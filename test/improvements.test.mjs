import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, prepareRequest } from '../bridge.mjs';
import { createRunner, checkCliCompatibility, REQUIRED_FLAGS } from '../runner.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url));
const models = ['claude-haiku-4-5-20251001'];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const fakeSpawn = extraEnv => (executable, args, options) => spawn(process.execPath, [fixture, ...args], { ...options, env: { ...options.env, ...extraEnv } });

test('byte-identical system/developer messages collapse to one copy, others keep their order', () => {
  const req = prepareRequest({ model: models[0], messages: [
    { role: 'system', content: 'Rules' }, { role: 'developer', content: 'Reminder' }, { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' }, { role: 'developer', content: 'Reminder' }, { role: 'user', content: 'c' },
    { role: 'developer', content: 'Reminder ' }, { role: 'user', content: 'd' },
  ] }, models);
  assert.equal(req.system, 'Rules\n\nReminder\n\nReminder ');
});

test('user images become native blocks referenced from the transcript record', () => {
  const req = prepareRequest({ model: models[0], messages: [
    { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: PNG } }, { type: 'image_url', image_url: 'https://example.com/a.png' }] },
  ] }, models);
  assert.equal(req.images.length, 2);
  assert.equal(req.images[0].source.type, 'base64');
  assert.equal(req.images[0].source.media_type, 'image/png');
  assert.deepEqual(req.images[1].source, { type: 'url', url: 'https://example.com/a.png' });
  const history = JSON.parse(req.prompt.slice(req.prompt.indexOf('\n') + 1));
  assert.deepEqual(history[0].images, ['image-1', 'image-2']);
  assert.match(req.prompt, /attached images/);
});

test('images are rejected on non-user roles, unknown schemes and unsupported media types', () => {
  const build = messages => () => prepareRequest({ model: models[0], messages }, models);
  assert.throws(build([{ role: 'system', content: [{ type: 'image_url', image_url: PNG }] }, { role: 'user', content: 'x' }]), /System messages cannot carry images/);
  assert.throws(build([{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'image_url', image_url: PNG }] }, { role: 'user', content: 'y' }]), /Only user messages/);
  assert.throws(build([{ role: 'user', content: [{ type: 'image_url', image_url: 'ftp://x/y.png' }] }]), /data: or http/);
  assert.throws(build([{ role: 'user', content: [{ type: 'image_url', image_url: 'data:image/bmp;base64,AAAA' }] }]), /PNG, JPEG, GIF or WebP/);
  assert.throws(build([{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }]), /text and image_url/);
});

test('runner switches to stream-json input only for image requests and keeps the prompt out of argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-img-'));
  try {
    let command;
    const run = createRunner({ executable: process.execPath, configDir: join(root, 'account'), tempRoot: root, timeoutMs: 5000,
      spawnProcess: (executable, args, options) => { command = { args }; return fakeSpawn()(executable, args, options); } });
    const withImage = prepareRequest({ model: models[0], messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }, { type: 'image_url', image_url: PNG }] }] }, models);
    const result = await run(withImage, {});
    assert.equal(result.result, 'IMAGES:1');
    assert.equal(command.args[command.args.indexOf('--input-format') + 1], 'stream-json');
    assert.ok(!JSON.stringify(command.args).includes('PRIVATE_PROMPT'));
    const textOnly = prepareRequest({ model: models[0], messages: [{ role: 'user', content: 'hi' }] }, models);
    assert.equal((await run(textOnly, {})).result, 'OK');
    assert.ok(!command.args.includes('--input-format'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI compatibility check accepts hidden-but-working flags and names flags that no longer exist', async () => {
  const ok = await checkCliCompatibility({ executable: process.execPath, spawnProcess: fakeSpawn() });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.missing, []);
  assert.match(ok.version, /Claude Code/);
  const broken = await checkCliCompatibility({ executable: process.execPath, spawnProcess: fakeSpawn({ FAKE_CLI_REMOVE_FLAGS: '--json-schema,--effort,--max-turns' }) });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.missing, ['--max-turns', '--json-schema', '--effort']);
  assert.ok(REQUIRED_FLAGS.includes('--input-format'));
});

test('/health reports degraded with 503 when the CLI check failed, ready otherwise', async () => {
  let cli = { ok: false, missing: ['--effort'], version: 'x' };
  const handler = createBridge({ models, key: 'k'.repeat(32), run: async () => ({}), status: () => ({ cli }) });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  try {
    let res = await fetch(url); let body = await res.json();
    assert.equal(res.status, 503); assert.equal(body.status, 'degraded'); assert.deepEqual(body.cli.missing, ['--effort']);
    cli = { ok: true, missing: [], version: 'x' };
    res = await fetch(url); body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.status, 'ready'); assert.equal(body.cli.ok, true);
  } finally { server.close(); }
});
