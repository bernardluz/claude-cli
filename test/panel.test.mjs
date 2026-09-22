import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMetrics } from '../metrics.mjs';
import { createUsageReader, normalizeUsage, normalizeBreakdown } from '../usage.mjs';
import { createBridge, originOf, subjectOf } from '../bridge.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = extra => ({ id: 'x', model: 'claude-opus-5', status: 200, prompt_tokens: 1000, completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 800 }, ...extra });

test('metrics fold log entries into totals, per-model rows and an error tally', () => {
  const m = createMetrics();
  m.record(ok({ resumed: true }));
  m.record(ok({ resumed: false, model: 'claude-haiku-4-5-20251001' }));
  m.record({ id: 'y', model: 'claude-opus-5', status: 502, code: 'claude_execution_failed' });
  m.record({ id: 'z', model: 'claude-opus-5', status: 499, code: 'invalid_request_error' });
  m.record({ event: 'listening' }); // not a request: ignored
  const s = m.snapshot();
  assert.deepEqual([s.totals.requests, s.totals.ok, s.totals.failed, s.totals.cancelled, s.totals.resumed], [4, 2, 1, 1, 1]);
  assert.equal(s.totals.prompt, 2000);
  assert.equal(s.totals.cached, 1600);
  assert.equal(s.models[0].model, 'claude-opus-5');
  assert.equal(s.models[0].requests, 3);
  assert.deepEqual(s.errors.map(e => e.code).sort(), ['claude_execution_failed', 'invalid_request_error']);
  assert.equal(s.recent[0].status, 499); // newest first
});

test('metrics never keep prompt text and survive a restart through drain/load', () => {
  const m = createMetrics();
  m.record({ ...ok(), messages: [{ role: 'user', content: 'segredo' }], system: 'segredo' });
  assert.ok(!JSON.stringify(m.snapshot()).includes('segredo'));
  const saved = JSON.parse(JSON.stringify(m.drain()));
  assert.equal(m.drain(), null);
  const other = createMetrics();
  other.load(saved);
  assert.equal(other.snapshot().totals.requests, 1);
});

test('the per-model caps come from `limits`, including the one the fixed keys never carry', () => {
  const payload = {
    five_hour: { utilization: 4, resets_at: '2026-09-22T08:10:00+00:00' },
    seven_day: { utilization: 13, resets_at: '2026-09-28T09:00:00+00:00' },
    seven_day_opus: null,
    limits: [
      { kind: 'session', percent: 4, severity: 'normal', resets_at: '2026-09-22T08:10:00+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', percent: 13, severity: 'normal', resets_at: '2026-09-28T09:00:00+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', percent: 8, severity: 'warning', resets_at: '2026-09-28T09:00:00+00:00', scope: { model: { display_name: 'Fable' } }, is_active: false },
    ],
  };
  const windows = normalizeUsage(payload);
  assert.deepEqual(windows.map(w => [w.label, w.used]), [['5 horas', 4], ['7 dias', 13], ['7 dias · Fable', 8]]);
  assert.equal(windows[1].active, true);
  assert.equal(windows[2].severity, 'warning');
  assert.equal(windows[0].resetsAt, '2026-09-22T08:10:00.000Z');
});

test('without `limits` the older fixed windows still answer, clamped', () => {
  const windows = normalizeUsage({ five_hour: { utilization: 3, resets_at: null }, seven_day: { utilization: 130 },
    seven_day_opus: { utilization: -5 }, outra: { utilization: 9 } });
  assert.deepEqual(windows.map(w => [w.label, w.used]), [['5 horas', 3], ['7 dias', 100], ['7 dias (Opus)', 0]]);
});

test('the weekly breakdown keeps only what was actually spent, largest first', () => {
  const rows = normalizeBreakdown({ seven_day_breakdown: { rows: [
    { key: 'chat', display_name: 'Chats', percent: 0 },
    { key: 'claude_code', display_name: 'Claude Code', percent: 96 },
    { key: 'cowork', display_name: 'Cowork', percent: 4 },
  ] } });
  assert.deepEqual(rows, [{ label: 'Claude Code', used: 96 }, { label: 'Cowork', used: 4 }]);
  assert.deepEqual(normalizeBreakdown({}), []);
});

test('a failed usage lookup reports a reason without leaking the token, and is cached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
  await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'segredo-do-token' } }));
  let calls = 0; let clock = 0;
  const read = createUsageReader({ configDir: dir, now: () => clock, fetchImpl: async () => { calls++; return { ok: false, status: 401 }; } });
  const first = await read();
  assert.match(first.error, /login/);
  assert.ok(!JSON.stringify(first).includes('segredo-do-token'));
  await read();
  assert.equal(calls, 1); // second call served from cache
  clock += 10 * 60 * 1000;
  await read();
  assert.equal(calls, 2); // cache expired
  await rm(dir, { recursive: true, force: true });
});

test('a missing Claude Code login is reported as such, and a good answer carries the windows', async () => {
  const missing = await createUsageReader({ configDir: join(tmpdir(), 'nao-existe-' + Date.now()) })();
  assert.ok(missing.error);
  assert.deepEqual(missing.windows, []);

  const dir = await mkdtemp(join(tmpdir(), 'usage-ok-'));
  await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  const read = createUsageReader({ configDir: dir, fetchImpl: async () => ({ ok: true, json: async () => ({
    limits: [{ kind: 'weekly_scoped', percent: 8, resets_at: null, scope: { model: { display_name: 'Fable' } } }],
    seven_day_breakdown: { rows: [{ display_name: 'Claude Code', percent: 96 }] } }) }) });
  const value = await read();
  assert.deepEqual(value.windows[0], { label: '7 dias · Fable', used: 8, resetsAt: null, severity: null, active: false });
  assert.deepEqual(value.breakdown, [{ label: 'Claude Code', used: 96 }]);
  assert.ok(value.checkedAt);
  await rm(dir, { recursive: true, force: true });
});

test('the panel and its data are served without the bridge key and carry no secrets', async () => {
  const server = http.createServer(createBridge({ models: ['m'], key: 'k'.repeat(30), run: async () => ({}),
    panel: { html: '<!doctype html><title>painel</title>', stats: async () => ({ status: 'ready', metrics: { totals: {} } }) } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/panel');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /painel/);
  const stats = await fetch(base + '/stats');
  assert.equal((await stats.json()).status, 'ready');
  // The LLM endpoint still demands the key.
  const denied = await fetch(base + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  await new Promise(r => server.close(r));
});

test('origin comes from the client agent and subject from the latest human turn', () => {
  assert.equal(originOf({ 'user-agent': 'factory-cli/0.223.0 (node; win32)' }), 'factory-cli/0.223.0');
  assert.equal(originOf({ 'user-agent': 'OpenAI/JS 6.25.0', 'x-title': 'Codex' }), 'Codex');
  assert.equal(originOf({}), null);

  // The client's boilerplate and code blocks are stripped; tool results are not instructions.
  const history = [
    { role: 'user', content: 'primeira tarefa' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'f', arguments: '{}' }] },
    { role: 'tool', content: 'resultado enorme da ferramenta', tool_call_id: 'c1' },
    { role: 'user', content: '<system-reminder>ruído</system-reminder>\n\nAgora corrija o gate do CI\n```js\ncodigo()\n```' },
  ];
  assert.equal(subjectOf(history), 'Agora corrija o gate do CI');
  assert.equal(subjectOf([{ role: 'tool', content: 'x', tool_call_id: 'c1' }]), null);
  assert.equal(subjectOf([{ role: 'user', content: 'x'.repeat(300) }]).length, 110);
});

test('the panel rows carry origin and subject, truncated', () => {
  const m = createMetrics();
  m.record(ok({ origin: 'factory-cli/0.223.0', subject: 'a'.repeat(200) }));
  const row = m.snapshot().recent[0];
  assert.equal(row.origin, 'factory-cli/0.223.0');
  assert.equal(row.subject.length, 110);
});
