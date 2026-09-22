import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner.mjs';
import { prepareRequest, decodeResult } from '../bridge.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-cli.mjs', import.meta.url));
const models = ['claude-haiku-4-5-20251001'];
const req = text => prepareRequest({ model: models[0], messages: [{ role: 'system', content: 'Private instructions' }, { role: 'user', content: text }] }, models);
async function setup(fn, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  let command;
  const runner = createRunner({ executable: process.execPath, configDir: join(root, 'account'), tempRoot: root, timeoutMs: 5000,
    spawnProcess: (executable, args, options) => {
      command = { executable, args, options };
      return spawn(process.execPath, [fixture, ...args], options);
    }, ...overrides });
  try { await fn(runner, () => command); assert.deepEqual(await readdir(root), []); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('real child process receives -p, isolation flags, stdin prompt and emits streaming JSON', async () => {
  await setup(async (run, getCommand) => {
    const texts = [];
    const result = await run(req('PRIVATE_PROMPT'), { onText: text => texts.push(text) });
    assert.equal(result.result, 'OK');
    assert.deepEqual(texts, ['OK']);
    const { args, options } = getCommand();
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--system-prompt-file'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.ok(!JSON.stringify(args).includes('PRIVATE_PROMPT'));
    assert.ok(!JSON.stringify(args).includes('Private instructions'));
    assert.equal(options.shell, false);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  });
});

test('timeout terminates child and removes temporary instructions', async () => {
  await setup(async run => {
    await assert.rejects(run(req('HANG_PROCESS'), {}), e => e.code === 'claude_timeout' && e.status === 504);
  }, { timeoutMs: 100 });
});

test('client cancellation terminates child and removes temporary instructions', async () => {
  await setup(async run => {
    const controller = new AbortController();
    const promise = run(req('HANG_PROCESS'), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, e => e.status === 499);
  });
});

test('native CLI authentication failure survives subprocess exit code 1', async () => {
  await setup(async run => {
    const request = req('EXPIRED_LOGIN');
    const raw = await run(request, {});
    assert.equal(raw.is_error, true);
    assert.throws(() => decodeResult(raw, request), e => e.code === 'claude_login_required');
  });
});

test('unexpected native execution tools fail closed before accepting a result', async () => {
  await setup(async run => {
    await assert.rejects(run(req('UNSAFE_TOOL'), {}), /Unexpected executable tools/);
  });
});

test('a model inventing the caller tools is cut off instead of looping for dozens of turns', async () => {
  await setup(async run => {
    await assert.rejects(run(req('STRAY_TOOL'), {}), e => e.code === 'claude_tool_loop' && /2 native tool calls/.test(e.detail));
  });
});
