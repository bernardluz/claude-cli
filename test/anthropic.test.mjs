import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../bridge.mjs';
import { createRunner } from '../runner.mjs';
import { toChatBody, toMessageResponse, createMessagesHandler, countTokens, anthropicError } from '../anthropic.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url));
const models = ['claude-haiku-4-5-20251001'];
const KEY = 'k'.repeat(32);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('Anthropic request translates system, tool_use/tool_result, images and tool_choice', () => {
  const chat = toChatBody({ model: models[0], max_tokens: 1024, system: [{ type: 'text', text: 'Rules' }],
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'any', disable_parallel_tool_use: true }, thinking: { type: 'enabled', budget_tokens: 8000 },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'clima?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'vou olhar' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Salvador' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '29C' }] }, { type: 'text', text: 'e aí?' }] },
    ] });
  assert.equal(chat.messages[0].role, 'system'); assert.equal(chat.messages[0].content, 'Rules');
  assert.equal(chat.messages[1].content[1].type, 'image_url');
  assert.deepEqual(chat.messages[2].tool_calls[0], { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Salvador"}' } });
  assert.deepEqual(chat.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '29C' });
  assert.equal(chat.messages[4].content, 'e aí?');
  assert.equal(chat.tools[0].function.parameters.properties.city.type, 'string');
  assert.equal(chat.tool_choice, 'required'); assert.equal(chat.parallel_tool_calls, false);
  assert.equal(chat.reasoning_effort, 'medium'); assert.equal(chat.max_tokens, 1024);
  assert.throws(() => toChatBody({ model: models[0], messages: [{ role: 'user', content: [{ type: 'document' }] }] }), /Unsupported content block/);
});

test('decoded results render as Anthropic content blocks with tool_use ids and usage', () => {
  const r = toMessageResponse({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Recife"}' } }] },
    finish_reason: 'tool_calls', usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 60 } } }, models[0]);
  assert.equal(r.type, 'message'); assert.equal(r.stop_reason, 'tool_use');
  assert.equal(r.content[0].type, 'tool_use'); assert.match(r.content[0].id, /^toolu_/); assert.deepEqual(r.content[0].input, { city: 'Recife' });
  assert.deepEqual(r.usage, { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 0, output_tokens: 7 });
  assert.equal(anthropicError(Object.assign(new Error('x'), { status: 429 })).body.error.type, 'rate_limit_error');
  assert.ok(countTokens({ model: models[0], messages: [{ role: 'user', content: 'oi' }] }).input_tokens > 0);
});

async function withServer(fn) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-test-'));
  const run = createRunner({ executable: process.execPath, configDir: join(root, 'account'), tempRoot: root, timeoutMs: 5000,
    spawnProcess: (exe, args, opts) => spawn(process.execPath, [fixture, ...args], opts) });
  const logs = [];
  const messages = { handle: createMessagesHandler({ models, run, log: e => logs.push(e) }), countTokens, anthropicError };
  const server = http.createServer(createBridge({ models, key: KEY, run, messages, log: e => logs.push(e) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, logs); } finally { server.close(); await rm(root, { recursive: true, force: true }); }
}

test('/v1/messages authenticates with x-api-key and returns an Anthropic message', async () => {
  await withServer(async base => {
    const unauth = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(unauth.status, 401); assert.equal((await unauth.json()).type, 'error');
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0], max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'message'); assert.deepEqual(body.content, [{ type: 'text', text: 'OK' }]); assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.usage.input_tokens, 1);
    const count = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'x-api-key': KEY }, body: JSON.stringify({ model: models[0], messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(count.status, 200); assert.ok((await count.json()).input_tokens > 0);
  });
});

test('/v1/messages streams the Anthropic event sequence with real text deltas', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0], max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const raw = await res.text();
    const events = raw.split('\n\n').filter(Boolean).map(f => f.split('\n')[0].replace('event: ', ''));
    assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.match(raw, /"text_delta","text":"OK"/); assert.match(raw, /"stop_reason":"end_turn"/);
  });
});

test('thinking is streamed as its own block before the answer, so a slow turn never looks dead', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0], max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'THINK_FIRST' }] }) });
    const raw = await res.text();
    const frames = raw.split('\n\n').filter(Boolean).map(f => JSON.parse(f.split('\n')[1].replace('data: ', '')));
    const kinds = frames.map(f => f.type);
    assert.deepEqual(kinds, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    // O raciocínio ocupa o índice 0 e a resposta vem depois, no índice 1.
    assert.equal(frames[1].content_block.type, 'thinking');
    assert.equal(frames[1].index, 0);
    assert.equal(frames[2].delta.thinking, ''); // o CLI redige o raciocínio; repassamos como vem
    assert.equal(frames[3].delta.type, 'signature_delta');
    assert.equal(frames[5].content_block.type, 'text');
    assert.equal(frames[5].index, 1);
    assert.match(raw, /"text_delta","text":"OK"/);
  });
});

test('expired login on /v1/messages is an Anthropic-shaped 503, not a fake message', async () => {
  await withServer(async (base, logs) => {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: models[0], max_tokens: 100, messages: [{ role: 'user', content: 'EXPIRED_LOGIN' }] }) });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.type, 'error'); assert.equal(body.error.type, 'api_error');
    assert.equal(logs.at(-1).code, 'claude_login_required');
  });
});

test('an overloaded upstream is reported to Anthropic clients as overloaded_error', () => {
  const e = anthropicError(Object.assign(new Error('Claude is temporarily unavailable upstream.'), { status: 503, code: 'claude_upstream_unavailable' }));
  assert.equal(e.status, 503);
  assert.equal(e.body.error.type, 'overloaded_error');
});
