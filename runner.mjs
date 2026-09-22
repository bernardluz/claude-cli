import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { cleanEnvironment, failure } from './bridge.mjs';

// Every CLI flag this runner relies on. A Claude Code update that drops or renames one must
// surface as a clear health failure, never as a silent behaviour change.
export const REQUIRED_FLAGS = ['-p', '--model', '--output-format', '--include-partial-messages', '--tools', '--strict-mcp-config',
  '--mcp-config', '--setting-sources', '--settings', '--disable-slash-commands', '--no-session-persistence', '--permission-mode',
  '--max-turns', '--system-prompt-file', '--json-schema', '--effort', '--input-format', '--verbose', '--resume', '--session-id'];

export async function checkCliCompatibility({ executable, configDir, spawnProcess = spawn, timeoutMs = 20000 }) {
  const env = cleanEnvironment(process.env);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const capture = args => new Promise(resolve => {
    let out = '';
    const child = spawnProcess(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.once('error', () => { clearTimeout(timer); resolve({ ok: false, out }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
  const version = (await capture(['--version'])).out.trim().split('\n')[0] || 'unknown';
  const help = await capture(['--help']);
  if (!help.ok) return { ok: false, version, missing: [...REQUIRED_FLAGS], checkedAt: new Date().toISOString() };
  const documented = flag => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(\\s|,|$|=|\\b)`).test(help.out);
  // Some flags (e.g. --max-turns, --system-prompt-file) are accepted but hidden from --help.
  // Probing `claude <flag> <value> --help` costs no API call: an unknown option exits non-zero
  // with "unknown option", a known one prints the help text.
  const takesValue = new Set(['--model', '--output-format', '--tools', '--mcp-config', '--setting-sources', '--settings', '--permission-mode',
    '--max-turns', '--system-prompt-file', '--json-schema', '--effort', '--input-format', '--resume', '--session-id']);
  const missing = [];
  for (const flag of REQUIRED_FLAGS) {
    if (documented(flag)) continue;
    const probe = await capture([flag, ...(takesValue.has(flag) ? ['1'] : []), '--help']);
    if (!probe.ok || /unknown option/i.test(probe.out)) missing.push(flag);
  }
  return { ok: missing.length === 0, version, missing, checkedAt: new Date().toISOString() };
}

export function createRunner({ executable, configDir, tempRoot = tmpdir(), timeoutMs = 300000, spawnProcess = spawn, sessionsDir }) {
  return async (request, { signal, onText = () => {}, onThinking = () => {} }) => {
    if (signal?.aborted) throw failure('Client disconnected.', 499);
    const scratch = await mkdtemp(join(tempRoot, 'claude-cli-request-'));
    // Claude Code stores and looks up sessions per working directory: resumable requests must all
    // run from the same stable directory; one-shot requests keep their private scratch cwd.
    const session = request.session && sessionsDir ? request.session : null;
    const cwd = session ? sessionsDir : scratch;
    let child; let timer; let killTimer; let error; let closed;
    const stop = () => {
      if (!child || child.exitCode != null || child.signalCode != null) return;
      const kill = sig => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
      kill('SIGTERM');
      killTimer ||= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const abort = () => { error ||= failure('Client disconnected.', 499); stop(); };
    try {
      const args = ['-p', '--model', request.model, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
        '--settings', '{"disableAllHooks":true}', '--disable-slash-commands',
        '--permission-mode', 'dontAsk', '--max-turns', request.schema ? '3' : '1'];
      if (!session) args.push('--no-session-persistence');
      else if (session.resume) args.push('--resume', session.resume);
      else args.push('--session-id', session.create);
      if (request.system) {
        const path = join(scratch, 'system.txt');
        await writeFile(path, request.system, { mode: 0o600 });
        args.push('--system-prompt-file', path);
      }
      if (request.schema) args.push('--json-schema', JSON.stringify(request.schema));
      if (request.effort && request.effort !== 'none') args.push('--effort', request.effort);
      // Images travel as native content blocks through the stream-json input mode; text-only
      // requests keep the plain stdin prompt so their shape stays identical to before.
      const withImages = request.images?.length > 0;
      if (withImages) args.push('--input-format', 'stream-json');
      const env = cleanEnvironment(process.env);
      env.PATH = dirname(executable) + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '');
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      // Claude Code treats reaching CLAUDE_CODE_MAX_OUTPUT_TOKENS as an API error and retries,
      // unlike OpenAI's max_tokens (a soft cut). Small client caps (thinking tokens count too)
      // would fail every request, so only real budgets are forwarded.
      if (request.maxTokens && request.maxTokens >= 8192) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxTokens);
      if (signal?.aborted) throw failure('Client disconnected.', 499);
      child = spawnProcess(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
      closed = new Promise(resolve => {
        child.once('error', () => { error ||= failure('Could not start Claude Code.', 502, 'claude_start_failed'); });
        child.once('close', (code, sig) => resolve({ code, sig }));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { error ||= failure('Claude Code request timed out.', 504, 'claude_timeout'); stop(); }, timeoutMs);
      // The input transcript is never retained. Only the tail of stderr is kept in memory, so a
      // failure can say why Claude Code stopped instead of surfacing a bare 502.
      let stderrTail = '';
      child.stderr.on('data', piece => { stderrTail = (stderrTail + piece).slice(-1024); });
      child.stdin.on('error', () => {});
      child.stdin.end(withImages
        ? JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: request.prompt }, ...request.images] } }) + '\n'
        : request.prompt);
      let result; let bytes = 0; let stray = 0;
      child.stdout.on('data', piece => {
        bytes += piece.length;
        if (bytes > 32 * 1024 * 1024) { error ||= failure('Claude output exceeded the bridge limit.', 502); stop(); }
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        if (error || !line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { error = failure('Claude emitted invalid stream JSON.', 502); stop(); continue; }
        if (event.type === 'system' && event.subtype === 'init') {
          const unexpected = (event.tools || []).filter(name => name !== 'StructuredOutput');
          if (unexpected.length || event.mcp_servers?.length) { error = failure('Unexpected executable tools were enabled in Claude Code.', 502); stop(); }
        }
        // Nothing is executable here, so a native tool_use means the model ignored the structured
        // output contract and started inventing the caller's tools. Every call is rejected and it
        // retries for dozens of turns, burning the subscription before failing anyway: stop at once.
        if (event.type === 'assistant') {
          for (const block of event.message?.content || []) if (block?.type === 'tool_use' && block.name !== 'StructuredOutput') stray++;
          if (stray >= 2) {
            error = Object.assign(failure('Claude Code tried to call tools that do not exist in this sandbox.', 502, 'claude_tool_loop'),
              { detail: `${stray} native tool calls instead of structured output` });
            stop();
            continue;
          }
        }
        // Thinking is forwarded like the real API does: a client that sees nothing for minutes
        // assumes the model died. It is never the answer, so it flows even under structured output.
        const delta = event.type === 'stream_event' ? event.event?.delta : null;
        if (delta?.type === 'text_delta') onText(delta.text);
        // Claude Code redacts the reasoning itself: the delta arrives with an empty string and only
        // an `estimated_tokens` hint. It is forwarded as it comes, never invented, because what the
        // client needs is the proof that the model is still working.
        else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') onThinking({ text: delta.thinking, tokens: delta.estimated_tokens ?? null });
        else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') onThinking({ signature: delta.signature });
        if (event.type === 'result') result = event;
      }
      const exit = await closed;
      const detail = () => stderrTail.replace(/\s+/g, ' ').trim().slice(-300) || `exit ${exit?.code ?? '?'}${exit?.sig ? ' ' + exit.sig : ''}`;
      if (error) { error.detail ||= detail(); throw error; }
      if (!result || (exit.code !== 0 && !result.is_error)) {
        throw Object.assign(failure('Claude exited without a completed result.', 502, 'claude_execution_failed'), { detail: detail() });
      }
      return result;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      stop();
      if (closed) await closed;
      clearTimeout(killTimer);
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
