// Simulated Claude Code CLI for tests. Never used in production.
const args = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');

if (args.includes('--version')) { process.stdout.write('9.9.9 (Claude Code)\n'); process.exit(0); }
// Session simulation: --session-id creates a marker file in cwd; --resume requires it (else the
// CLI-style "No conversation found" error result), and the reply echoes the resumed id.
import { existsSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
const sessionCreate = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : null;
const sessionResume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
if (sessionCreate && !args.includes('--help')) writeFileSync(joinPath(process.cwd(), `session-${sessionCreate}.marker`), '');
if (sessionResume && !args.includes('--help') && !existsSync(joinPath(process.cwd(), `session-${sessionResume}.marker`))) {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `No conversation found with session ID: ${sessionResume}` }) + '\n');
  process.exit(1);
}
if (args.includes('--help')) {
  // Like the real CLI: --max-turns and --system-prompt-file are accepted but undocumented;
  // FAKE_CLI_REMOVE_FLAGS simulates flags that no longer exist at all.
  const flags = ['-p, --print', '--model <model>', '--output-format <format>', '--include-partial-messages', '--tools <tools...>',
    '--strict-mcp-config', '--mcp-config <configs...>', '--setting-sources <sources>', '--settings <file-or-json>', '--disable-slash-commands',
    '--no-session-persistence', '--permission-mode <mode>', '--json-schema <schema>', '--effort <level>', '--input-format <format>', '--verbose'];
  const removed = process.env.FAKE_CLI_REMOVE_FLAGS ? process.env.FAKE_CLI_REMOVE_FLAGS.split(',') : [];
  const unknown = args.find(a => a.startsWith('--') && a !== '--help' && removed.includes(a));
  if (unknown) { process.stderr.write(`error: unknown option '${unknown}'\n`); process.exit(1); }
  process.stdout.write('Usage: claude [options]\n\nOptions:\n' + flags.filter(f => !removed.some(h => f.includes(h))).map(f => `  ${f}  description`).join('\n') + '\n');
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const streamJson = args[args.indexOf('--input-format') + 1] === 'stream-json' && args.includes('--input-format');
let prompt = input;
let imageCount = 0;
if (streamJson) {
  const record = JSON.parse(input.trim().split('\n')[0]);
  const blocks = record.message.content;
  prompt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
  imageCount = blocks.filter(b => b.type === 'image').length;
}
if (prompt.includes('HANG_PROCESS')) {
  setInterval(() => {}, 1000);
} else if (prompt.includes('EXPIRED_LOGIN')) {
  send({ type: 'result', subtype: 'success', is_error: true, result: 'OAuth session expired' });
  process.exitCode = 1;
} else if (prompt.includes('STRAY_TOOL')) {
  send({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Create', input: {} }, { type: 'tool_use', name: 'LS', input: {} }] } });
  setInterval(() => {}, 1000);
} else if (prompt.includes('UNSAFE_TOOL')) {
  send({ type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [] });
  setInterval(() => {}, 1000);
} else {
  const text = imageCount ? `IMAGES:${imageCount}` : sessionResume ? `RESUMED:${sessionResume.slice(0, 8)}` : 'OK';
  send({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
  // THINK_FIRST makes the fake reason before answering, like the real CLI under --effort.
  if (prompt.includes('THINK_FIRST')) {
    send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } } });
    send({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } } });
    send({ type: 'stream_event', event: { delta: { type: 'signature_delta', signature: 'assinatura' } } });
    send({ type: 'stream_event', event: { type: 'content_block_stop' } });
  }
  send({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } });
  send({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionResume || sessionCreate || 'none', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: sessionResume ? 500 : 0 } });
}
