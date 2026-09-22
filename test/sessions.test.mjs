import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner.mjs';
import { prepareRequest, decodeResult } from '../bridge.mjs';
import { createSessionStore, withSessions, assistantEntry } from '../sessions.mjs';
import { toChatBody, toMessageResponse } from '../anthropic.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url));
const models = ['claude-haiku-4-5-20251001'];
const body = (...turns) => ({ model: models[0], messages: [{ role: 'system', content: 'Rules' }, ...turns] });

async function setup(fn) {
  const root = await mkdtemp(join(tmpdir(), 'sessions-test-'));
  const sessionsDir = join(root, 'sessions'); await mkdir(sessionsDir);
  const commands = [];
  const base = createRunner({ executable: process.execPath, configDir: join(root, 'account'), tempRoot: root, timeoutMs: 5000, sessionsDir,
    spawnProcess: (exe, args, opts) => { commands.push({ args, cwd: opts.cwd }); return spawn(process.execPath, [fixture, ...args], opts); } });
  const store = createSessionStore({ ttlMs: 60000 });
  const run = withSessions(base, store);
  try { await fn({ run, store, commands, sessionsDir, root }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('first turn creates a session, follow-up resumes it with only the new records', async () => {
  await setup(async ({ run, store, commands, sessionsDir }) => {
    const t1 = prepareRequest(body({ role: 'user', content: 'oi' }), models);
    const r1 = decodeResult(await run(t1, {}), t1);
    assert.equal(r1.message.content, 'OK'); assert.equal(r1.session.resumed, false); assert.equal(store.size(), 1);
    assert.ok(commands[0].args.includes('--session-id')); assert.ok(!commands[0].args.includes('--no-session-persistence'));
    assert.equal(commands[0].cwd, sessionsDir);
    const t2 = prepareRequest(body({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'e aí?' }), models);
    const r2 = decodeResult(await run(t2, {}), t2);
    assert.equal(r2.session.resumed, true); assert.equal(r2.session.id, r1.session.id);
    assert.match(r2.message.content, /^RESUMED:/); assert.equal(r2.usage.prompt_tokens_details.cached_tokens, 500);
    assert.equal(commands[1].args[commands[1].args.indexOf('--resume') + 1], r1.session.id);
    // Only the new record travels; the prompt file is not in argv, so inspect the request the runner got.
    assert.equal(store.size(), 2);
  });
});

test('edited history does not match a stored state and starts a fresh session', async () => {
  await setup(async ({ run, commands }) => {
    const t1 = prepareRequest(body({ role: 'user', content: 'oi' }), models);
    decodeResult(await run(t1, {}), t1);
    const edited = prepareRequest(body({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OUTRA RESPOSTA' }, { role: 'user', content: 'e aí?' }), models);
    const r = decodeResult(await run(edited, {}), edited);
    assert.equal(r.session.resumed, false); assert.equal(r.message.content, 'OK');
    assert.ok(commands[1].args.includes('--session-id'));
  });
});

test('a resume rejected by the CLI falls back to a fresh session with the full history', async () => {
  await setup(async ({ run, store, commands, sessionsDir }) => {
    const t1 = prepareRequest(body({ role: 'user', content: 'oi' }), models);
    const r1 = decodeResult(await run(t1, {}), t1);
    for (const f of await readdir(sessionsDir)) await rm(join(sessionsDir, f)); // transcript vanished
    const t2 = prepareRequest(body({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'e aí?' }), models);
    const r2 = decodeResult(await run(t2, {}), t2);
    assert.equal(r2.session.resumed, false); assert.notEqual(r2.session.id, r1.session.id); assert.equal(r2.message.content, 'OK');
    assert.ok(commands[1].args.includes('--resume')); assert.ok(commands[2].args.includes('--session-id'));
    assert.equal(commands.length, 3);
  });
});

test('tool-call replies are remembered in the shape the client echoes back', () => {
  const store = createSessionStore();
  const t1 = prepareRequest({ model: models[0], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }], messages: [{ role: 'user', content: 'go' }] }, models);
  const message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] };
  store.remember(t1, 'sess-1', message);
  assert.deepEqual(assistantEntry(message), { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'f', arguments: '{"a":1}' }] });
  const t2 = prepareRequest({ model: models[0], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: message.tool_calls }, { role: 'tool', tool_call_id: 'call_1', content: 'done' }] }, models);
  const plan = store.plan(t2);
  assert.equal(plan.resume, 'sess-1'); assert.deepEqual(plan.newEntries, [{ role: 'tool', content: 'done', tool_call_id: 'call_1' }]);
});

test('sessions expire by TTL and a different system prompt never resumes', () => {
  let clock = 1000;
  const store = createSessionStore({ ttlMs: 100, now: () => clock });
  const t1 = prepareRequest(body({ role: 'user', content: 'oi' }), models);
  store.remember(t1, 's', { role: 'assistant', content: 'OK' });
  const t2 = prepareRequest(body({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'x' }), models);
  assert.equal(store.plan(t2).resume, 's');
  const other = prepareRequest({ model: models[0], messages: [{ role: 'system', content: 'Other rules' }, { role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'x' }] }, models);
  assert.equal(store.plan(other).resume, undefined);
  clock += 200;
  assert.equal(store.plan(t2).resume, undefined);
});

// Regression: through /v1/messages a tool call is minted twice (call_* here, toolu_* on the wire),
// so identity cannot depend on those ids or Factory would never resume a single turn.
test('an Anthropic tool-call round trip resumes despite freshly minted tool ids', () => {
  const store = createSessionStore();
  const tools = [{ name: 'read_file', description: '', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } } }];
  const t1 = prepareRequest(toChatBody({ model: models[0], system: 'Factory rules', tools, messages: [{ role: 'user', content: 'leia o arquivo' }] }), models);
  const message = { role: 'assistant', content: 'vou ler', tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt","limit":10}' } }] };
  store.remember(t1, 'sess-anthropic', message);

  const reply = toMessageResponse({ message, usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } }, models[0]);
  const use = reply.content.find(b => b.type === 'tool_use');
  assert.match(use.id, /^toolu_/); // a different id than the one stored above
  const t2 = prepareRequest(toChatBody({ model: models[0], system: 'Factory rules', tools, messages: [
    { role: 'user', content: 'leia o arquivo' },
    { role: 'assistant', content: reply.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'conteudo' }] },
  ] }), models);
  const plan = store.plan(t2);
  assert.equal(plan.resume, 'sess-anthropic');
  assert.deepEqual(plan.newEntries, [{ role: 'tool', content: 'conteudo', tool_call_id: use.id }]);
});

test('a reordered tool-argument JSON still matches the stored state', () => {
  const store = createSessionStore();
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
  const t1 = prepareRequest({ model: models[0], tools, messages: [{ role: 'user', content: 'go' }] }, models);
  store.remember(t1, 'sess-args', { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1,"b":2}' } }] });
  const t2 = prepareRequest({ model: models[0], tools, messages: [{ role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'x9', type: 'function', function: { name: 'f', arguments: '{"b":2,"a":1}' } }] },
    { role: 'tool', tool_call_id: 'x9', content: 'ok' }] }, models);
  assert.equal(store.plan(t2).resume, 'sess-args');
});

test('a session already in flight is never resumed twice at once', () => {
  const store = createSessionStore();
  const t1 = prepareRequest(body({ role: 'user', content: 'oi' }), models);
  store.remember(t1, 'sess-busy', { role: 'assistant', content: 'OK' });
  const t2 = prepareRequest(body({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'x' }), models);
  assert.equal(store.plan(t2).resume, 'sess-busy');
  assert.equal(store.plan(t2).resume, undefined); // second caller in parallel gets a fresh session
  store.release('sess-busy');
  assert.equal(store.plan(t2).resume, 'sess-busy');
});

test('the session map survives a restart through drain/load and drops expired rows', () => {
  let clock = 1000;
  const a = createSessionStore({ ttlMs: 500, now: () => clock });
  const t1 = prepareRequest(body({ role: 'user', content: 'oi' }), models);
  a.remember(t1, 'sess-persist', { role: 'assistant', content: 'OK' });
  const saved = a.drain();
  assert.equal(saved.length, 1);
  assert.equal(a.drain(), null); // nothing new to write

  const t2 = prepareRequest(body({ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'x' }), models);
  const fresh = createSessionStore({ ttlMs: 500, now: () => clock });
  fresh.load(JSON.parse(JSON.stringify(saved)));
  assert.equal(fresh.plan(t2).resume, 'sess-persist');

  clock += 1000;
  const stale = createSessionStore({ ttlMs: 500, now: () => clock });
  stale.load(saved);
  assert.equal(stale.size(), 0);
});
