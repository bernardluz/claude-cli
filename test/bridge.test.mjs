import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { prepareRequest, decodeResult, cleanEnvironment, createBridge } from '../bridge.mjs';

const models = ['claude-haiku-4-5-20251001'];
const base = { model: models[0], messages: [{ role: 'user', content: 'Hello' }] };
const tool = { type: 'function', function: { name: 'lookup', description: 'Lookup a city', parameters: {
  type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
} } };
const successful = (result = 'Hello') => ({ type: 'result', subtype: 'success', result, is_error: false,
  usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 4 } });

test('history retains roles, tool IDs and results; system instructions remain separate', () => {
  const req = prepareRequest({ ...base, messages: [
    { role: 'system', content: 'Rules' }, { role: 'developer', content: 'More rules' },
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"city":"Salvador"}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: '29 degrees' },
  ], tools: [tool] }, models);
  assert.match(req.system, /Rules/);
  assert.match(req.system, /More rules/);
  assert.match(req.prompt, /call_a/);
  assert.match(req.prompt, /29 degrees/);
  assert.doesNotMatch(req.prompt, /More rules/);
});

test('reject unsupported model, modalities and malformed tool result association', () => {
  assert.throws(() => prepareRequest({ ...base, model: '--dangerous' }, models), /model/i);
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }, models), /content/i);
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: 'tool', content: 'orphan' }] }, models), /tool_call_id/);
});

test('tools are returned to the caller with validated arguments and fresh IDs', () => {
  const req = prepareRequest({ ...base, tools: [tool] }, models);
  const raw = { ...successful(), structured_output: { kind: 'tool_calls', content: '', calls: [{ name: 'lookup', arguments: { city: 'Salvador' } }] } };
  const result = decodeResult(raw, req);
  assert.equal(result.finish_reason, 'tool_calls');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"city":"Salvador"}');
  assert.match(result.message.tool_calls[0].id, /^call_/);
  assert.equal(result.usage.prompt_tokens, 15);
  raw.structured_output.calls[0].arguments.city = 42;
  assert.throws(() => decodeResult(raw, req), /arguments/i);
  raw.structured_output.calls[0].name = 'shell';
  assert.throws(() => decodeResult(raw, req), /tool/i);
});

test('tool_choice and parallel_tool_calls are enforced, including forced final messages', () => {
  const required = prepareRequest({ ...base, tools: [tool], tool_choice: 'required' }, models);
  assert.throws(() => decodeResult({ ...successful(), structured_output: { kind: 'message', content: 'skip', calls: [] } }, required), /required/i);
  const none = prepareRequest({ ...base, tools: [tool], tool_choice: 'none' }, models);
  assert.equal(none.schema, undefined);
  const single = prepareRequest({ ...base, tools: [tool], parallel_tool_calls: false }, models);
  assert.throws(() => decodeResult({ ...successful(), structured_output: { kind: 'tool_calls', content: '', calls: [
    { name: 'lookup', arguments: { city: 'A' } }, { name: 'lookup', arguments: { city: 'B' } },
  ] } }, single), /parallel/i);
});

test('OAuth expiry is an error even when CLI subtype says success; no raw error leakage', () => {
  assert.throws(() => decodeResult({ ...successful('Failed to authenticate: OAuth session expired and could not be refreshed'), is_error: true }, prepareRequest(base, models)),
    e => e.status === 503 && e.code === 'claude_login_required' && !e.message.includes('OAuth session'));
});

test('native subscription weekly limit maps to HTTP 429 instead of generic execution failure', () => {
  const request = prepareRequest(base, models);
  for (const result of ["You've hit your weekly limit · resets 11am (Europe/Berlin)", "You've hit your limit", 'API Error: 429']) {
    assert.throws(() => decodeResult({ ...successful(result), is_error: true }, request),
      e => e.status === 429 && e.code === 'claude_rate_limited');
  }
});

test('transient upstream failures become a retryable 503, not a dead-end 502', () => {
  const request = prepareRequest(base, models);
  const transient = ['API Error: 529 Overloaded. This is a server-side issue, usually temporary',
    'API Error: 500 Internal server error.', 'API Error: 503 Service Unavailable', 'API Error: 502 Bad Gateway'];
  for (const result of transient) {
    assert.throws(() => decodeResult({ ...successful(result), is_error: true }, request),
      e => e.status === 503 && e.code === 'claude_upstream_unavailable' && !e.message.includes('Overloaded'));
  }
  // A genuine local failure must stay a 502 so it is not retried forever.
  assert.throws(() => decodeResult({ ...successful('Claude returned nothing useful'), is_error: true }, request),
    e => e.status === 502 && e.code === 'claude_execution_failed');
});

test('CLI environment never receives direct provider credentials or proxy endpoint', () => {
  const env = cleanEnvironment({ PATH: '/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'proxy',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CLAUDE_BRIDGE_KEY_FILE: 'secret-path' });
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_BRIDGE_KEY_FILE, undefined);
});

async function withServer(run, fn, extra = {}) {
  const server = createServer(createBridge({ models, key: 'test-private-key', run, ...extra }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const headers = { authorization: 'Bearer test-private-key', 'content-type': 'application/json' };

test('HTTP authenticates before invoking CLI and returns usage', async () => {
  let calls = 0;
  await withServer(async () => { calls++; return successful(); }, async url => {
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify(base) })).status, 401);
    assert.equal(calls, 0);
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(base) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'Hello');
    assert.equal(calls, 1);
  });
});

test('SSE streams text once, terminates correctly and includes requested usage', async () => {
  await withServer(async (_, { onText }) => { onText('Hel'); onText('lo'); return successful(); }, async url => {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ ...base, stream: true, stream_options: { include_usage: true } }) });
    const text = await response.text();
    const chunks = text.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
    assert.equal(chunks.flatMap(c => c.choices).map(c => c.delta.content || '').join(''), 'Hello');
    assert.match(text, /data: \[DONE\]/);
    assert.equal(chunks.at(-1).usage.prompt_tokens, 15);
  });
});

test('structured tool response hides internal text and returns a complete tool delta', async () => {
  await withServer(async (_, { onText }) => { onText('internal envelope'); return { ...successful(),
    structured_output: { kind: 'tool_calls', content: '', calls: [{ name: 'lookup', arguments: { city: 'A' } }] } }; }, async url => {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...base, tools: [tool], stream: true }) });
    const text = await response.text();
    assert.doesNotMatch(text, /internal envelope/);
    assert.match(text, /lookup/);
    assert.match(text, /tool_calls/);
  });
});

test('expired subscription produces 503, not a fabricated successful stream', async () => {
  await withServer(async () => ({ ...successful('OAuth session expired'), is_error: true }), async url => {
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...base, stream: true }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'claude_login_required');
  });
});

test('malformed and oversized requests do not invoke the CLI', async () => {
  await withServer(async () => { throw Error('must not invoke'); }, async url => {
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: 'a'.repeat(300) })).status, 413);
  }, { maxBodyBytes: 250 });
});

test('concurrent requests are bounded before another CLI process is started', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  await withServer(() => { entered(); return new Promise(resolve => { release = resolve; }); }, async url => {
    const first = fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(base) });
    await started;
    const second = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(base) });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, 'bridge_busy');
    release(successful());
    assert.equal((await first).status, 200);
  }, { maxConcurrent: 1 });
});

test('HTTP client disconnect propagates cancellation to the CLI runner', async () => {
  let entered;
  let cancelled;
  const started = new Promise(resolve => { entered = resolve; });
  const stopped = new Promise(resolve => { cancelled = resolve; });
  await withServer((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(Object.assign(Error('cancelled'), { status: 499 })); }, { once: true });
    entered();
  }), async url => {
    const controller = new AbortController();
    const request = fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(base), signal: controller.signal });
    const rejection = assert.rejects(request, e => e.name === 'AbortError');
    await started;
    controller.abort();
    await rejection;
    await stopped;
  });
});

test('HTTP tool round trip associates the returned result with the generated call ID', async () => {
  let turn = 0;
  await withServer(async req => {
    if (++turn === 1) return { ...successful(), structured_output: {
      kind: 'tool_calls', content: '', calls: [{ name: 'lookup', arguments: { city: 'Salvador' } }],
    } };
    assert.match(req.prompt, /29 degrees/);
    return { ...successful(), structured_output: { kind: 'message', content: 'Salvador: 29 degrees.', calls: [] } };
  }, async url => {
    const first = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...base, tools: [tool] }) });
    const assistant = (await first.json()).choices[0].message;
    const second = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...base, tools: [tool],
      messages: [...base.messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: '29 degrees' }],
    }) });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).choices[0].message.content, 'Salvador: 29 degrees.');
  });
});
