import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMetrics } from '../metrics.mjs';
import { createUsageReader, normalizeUsage } from '../usage.mjs';
import { createBridge } from '../bridge.mjs';
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

test('subscription windows are normalised and clamped', () => {
  const windows = normalizeUsage({ five_hour: { utilization: 3, resets_at: '2026-09-22T08:10:00+00:00' },
    seven_day: { utilization: 130, resets_at: null }, seven_day_opus: { utilization: -5, resets_at: null }, outra: { utilization: 9 } });
  assert.deepEqual(windows.map(w => [w.label, w.used]), [['5 horas', 3], ['7 dias', 100], ['7 dias (Opus)', 0]]);
  assert.equal(windows[0].resetsAt, '2026-09-22T08:10:00.000Z');
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
  const read = createUsageReader({ configDir: dir, fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 3, resets_at: null } }) }) });
  const value = await read();
  assert.equal(value.windows[0].used, 3);
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
