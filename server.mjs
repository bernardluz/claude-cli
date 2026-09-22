import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createBridge } from './bridge.mjs';
import { createRunner, checkCliCompatibility } from './runner.mjs';
import { createMessagesHandler, countTokens, anthropicError } from './anthropic.mjs';
import { createSessionStore, withSessions } from './sessions.mjs';
import { createMetrics } from './metrics.mjs';
import { createUsageReader } from './usage.mjs';

const path = process.env.CLAUDE_BRIDGE_CONFIG;
if (!path) throw Error('Set CLAUDE_BRIDGE_CONFIG to the bridge JSON configuration file.');
const config = JSON.parse(await readFile(path, 'utf8'));
if (config.host !== '127.0.0.1') throw Error('The bridge must listen on 127.0.0.1.');
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('Invalid bridge port.');
const key = (await readFile(config.keyFile, 'utf8')).trim();
if (key.length < 24) throw Error('The internal key must contain at least 24 characters.');
// Every finished request already produces a log line; the panel feeds on the same entries.
const metrics = createMetrics();
const log = entry => { metrics.record(entry); console.log(JSON.stringify(entry)); };
const readUsage = createUsageReader({ configDir: config.configDir });
const panelHtml = await readFile(new URL('./panel.html', import.meta.url), 'utf8');

// The runner depends on specific `claude` flags. Check them at start and every 6 hours
// (auto-updates can change the CLI under a long-running service); /health exposes the result.
let cli = { ok: false, version: 'unchecked', missing: [], checkedAt: null };
async function recheck() {
  try { cli = await checkCliCompatibility(config); } catch (error) { cli = { ok: false, version: 'unknown', missing: ['(check failed)'], error: String(error?.message || error), checkedAt: new Date().toISOString() }; }
  log({ event: 'cli-compatibility', ...cli });
}
await recheck();
setInterval(recheck, 6 * 60 * 60 * 1000).unref();

// Sessions: follow-up turns resume the Claude Code session so the whole history stays cached.
// Transcripts land under ~/.claude/projects/<encoded sessionsDir>/ and are pruned by age.
const sessions = { enabled: true, ttlMinutes: 60, ...(config.sessions || {}) };
let run = createRunner({ ...config, sessionsDir: undefined });
let store;
if (sessions.enabled) {
  const sessionsDir = sessions.dir || join(config.tempRoot || homedir(), 'claude-cli-sessions');
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  store = createSessionStore({ ttlMs: sessions.ttlMinutes * 60 * 1000 });
  run = withSessions(createRunner({ ...config, sessionsDir }), store, { log });
  const configHome = config.configDir || join(homedir(), '.claude');
  const projectDir = join(configHome, 'projects', sessionsDir.replace(/[^A-Za-z0-9]/g, '-'));
  const pruneTranscripts = async () => {
    const cutoff = Date.now() - 2 * sessions.ttlMinutes * 60 * 1000;
    let removed = 0;
    try {
      for (const name of await readdir(projectDir)) {
        const file = join(projectDir, name);
        try { if ((await stat(file)).mtimeMs < cutoff) { await rm(file, { recursive: true, force: true }); removed++; } } catch {}
      }
    } catch {}
    if (removed) log({ event: 'transcripts-pruned', removed });
  };
  await pruneTranscripts();
  setInterval(pruneTranscripts, 10 * 60 * 1000).unref();
  // The transcripts survive a restart, so the map pointing at them should too: without it every
  // open conversation would replay its whole context on the next turn. Only hashes are written.
  const stateFile = join(sessionsDir, 'sessions.json');
  let restored = 0;
  try { const saved = JSON.parse(await readFile(stateFile, 'utf8')); store.load(saved); restored = store.size(); } catch {}
  const metricsFile = join(sessionsDir, 'metrics.json');
  try { metrics.load(JSON.parse(await readFile(metricsFile, 'utf8'))); } catch {}
  const write = async (file, value) => {
    await writeFile(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
    await rename(file + '.tmp', file);
  };
  const saveState = async () => {
    const entries = store.drain();
    const counters = metrics.drain();
    try {
      if (entries) await write(stateFile, entries);
      if (counters) await write(metricsFile, counters);
    } catch (error) { log({ event: 'sessions-save-failed', error: String(error?.message || error) }); }
  };
  setInterval(saveState, 30 * 1000).unref();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { saveState(); });
  log({ event: 'sessions', enabled: true, ttlMinutes: sessions.ttlMinutes, dir: sessionsDir, restored });
}

const messages = { handle: createMessagesHandler({ models: config.models, run, log }), countTokens, anthropicError };
const status = () => ({ cli, sessions: { enabled: sessions.enabled, active: store ? store.size() : 0 } });
const panel = {
  html: panelHtml,
  stats: async () => ({ status: cli.ok === false ? 'degraded' : 'ready', ...status(), metrics: metrics.snapshot(), usage: await readUsage() }),
};
const server = createServer(createBridge({ ...config, key, run, status, log, messages, panel }));
server.requestTimeout = 60000;
server.headersTimeout = 30000;
server.listen(config.port, config.host, () => log({ event: 'listening', host: config.host, port: config.port, transport: 'claude-cli' }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  server.close();
  server.closeAllConnections();
});
