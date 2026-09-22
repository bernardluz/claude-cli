import { randomUUID, timingSafeEqual } from 'node:crypto';
import Ajv from 'ajv';

export function failure(message, status = 400, code = 'invalid_request_error') {
  return Object.assign(new Error(message), { status, code });
}

export function cleanEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_') || name.startsWith('CLAUDE_BRIDGE_') ||
        ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'].includes(name)) delete env[name];
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// OpenAI image_url part -> Claude content block. Only base64 data URLs and http(s) URLs.
function imageBlock(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string' || !url) throw failure('Image content requires an image_url value.');
  if (url.startsWith('data:')) {
    const parsed = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/s.exec(url);
    if (!parsed || !IMAGE_MEDIA_TYPES.has(parsed[1])) throw failure('Image data URLs must be base64 PNG, JPEG, GIF or WebP.');
    const data = parsed[2].replace(/\s+/g, '');
    if (data.length * 3 / 4 > MAX_IMAGE_BYTES) throw failure('Image exceeds the 20 MB limit.', 413);
    return { type: 'image', source: { type: 'base64', media_type: parsed[1], data } };
  }
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  throw failure('Image URLs must use a data: or http(s) scheme.');
}

// Returns { text, images } for a message content; text parts join with newlines.
function content(value) {
  if (value == null) return { text: '', images: [] };
  if (typeof value === 'string') return { text: value, images: [] };
  if (!Array.isArray(value)) throw failure('Message content must be a string or an array of parts.');
  const text = []; const images = [];
  for (const part of value) {
    if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
    else if (part?.type === 'image_url') images.push(imageBlock(part));
    else throw failure('This bridge accepts text and image_url content parts only.');
  }
  return { text: text.join('\n'), images };
}

export function prepareRequest(body, models) {
  if (!isObject(body)) throw failure('The request must be a JSON object.');
  if (!models.includes(body.model)) throw failure('The requested model is not configured.', 404, 'model_not_found');
  if (!Array.isArray(body.messages) || !body.messages.length) throw failure('messages must be a non-empty array.');
  if (body.n != null && body.n !== 1) throw failure('Only n=1 is supported.');
  if (body.response_format && body.response_format.type !== 'text') throw failure('response_format is not supported by this adapter.');
  if (body.stop?.length) throw failure('Custom stop sequences are not supported.');
  if (body.temperature != null && body.temperature !== 1) throw failure('Custom temperature is not supported.');
  if (body.top_p != null && body.top_p !== 1) throw failure('Custom top_p is not supported.');
  if (body.reasoning_effort != null && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)) {
    throw failure('Unsupported reasoning_effort.');
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000)) throw failure('Invalid output token limit.');
  const systems = [];
  const history = [];
  const images = [];
  const pending = new Set();
  for (const msg of body.messages) {
    if (!isObject(msg)) throw failure('Every message must be an object.');
    if (['system', 'developer'].includes(msg.role)) {
      const { text, images: illegal } = content(msg.content);
      if (illegal.length) throw failure('System messages cannot carry images.');
      // Clients such as Codex re-send the same developer reminder every turn; byte-identical
      // copies collapse to the first one so the system prompt (and its cache prefix) stays stable.
      if (text && !systems.includes(text)) systems.push(text);
      continue;
    }
    if (!['user', 'assistant', 'tool'].includes(msg.role)) throw failure('Unsupported message role.');
    const parsed = content(msg.content);
    if (parsed.images.length && msg.role !== 'user') throw failure('Only user messages can carry images.');
    const entry = { role: msg.role, content: parsed.text };
    if (parsed.images.length) {
      // The text record keeps its place in the transcript; the binary goes as native blocks.
      entry.images = parsed.images.map((_, index) => `image-${images.length + index + 1}`);
      images.push(...parsed.images);
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      if (!Array.isArray(msg.tool_calls)) throw failure('Invalid assistant tool_calls.');
      entry.tool_calls = msg.tool_calls.map(call => {
        if (typeof call?.id !== 'string' || !call.id || !isObject(call.function) ||
            typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw failure('Invalid assistant tool call.');
        if (pending.has(call.id)) throw failure('Duplicate pending tool call ID.');
        pending.add(call.id);
        return { id: call.id, name: call.function.name, arguments: call.function.arguments };
      });
    }
    if (msg.role === 'tool') {
      if (typeof msg.tool_call_id !== 'string' || !pending.has(msg.tool_call_id)) throw failure('Unmatched or missing tool_call_id.');
      entry.tool_call_id = msg.tool_call_id;
      pending.delete(msg.tool_call_id);
    }
    history.push(entry);
  }
  if (!history.length || pending.size) throw failure('Conversation must contain input and all pending tool results.');
  if (body.tools != null && !Array.isArray(body.tools)) throw failure('tools must be an array.');
  const validators = new Map();
  const definitions = (body.tools || []).map(t => {
    if (t?.type !== 'function' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(t.function?.name ?? '')) throw failure('Only named function tools are supported.');
    if (validators.has(t.function.name)) throw failure('Duplicate function name.');
    const parameters = t.function.parameters || { type: 'object' };
    if (!isObject(parameters)) throw failure('Invalid tool argument schema.');
    try {
      const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false });
      validators.set(t.function.name, ajv.compile(parameters));
    } catch { throw failure('Unsupported or invalid tool argument schema.'); }
    return { name: t.function.name, description: t.function.description || '', parameters };
  });
  const choice = body.tool_choice ?? 'auto';
  const forced = isObject(choice) && choice.type === 'function' ? choice.function?.name : undefined;
  if (!['auto', 'none', 'required'].includes(choice) && !forced) throw failure('Invalid tool_choice.');
  if (forced && !validators.has(forced)) throw failure('Forced tool is not available.');
  if (choice === 'required' && !definitions.length) throw failure('tool_choice required needs tools.');
  const allowed = choice === 'none' ? [] : definitions.filter(d => !forced || d.name === forced);
  let schema;
  if (allowed.length) {
    systems.push('IMPORTANT: the functions listed below are DEFINITIONS ONLY. They are not installed in this environment and you cannot invoke them directly; any attempt to call them will fail. The caller executes them. To request one or more of them, answer with kind="tool_calls" in the required structured output, listing each call with its name and arguments; the caller will run them and send the results back in a later turn. Only answer with kind="message" when no function call is needed. Treat the JSON conversation as prior messages and tool results, retaining their roles.');
    systems.push(`Function definitions (request via structured output, never call directly): ${JSON.stringify(allowed)}`);
    systems.push(`Tool selection: ${forced ? `must request ${forced}` : choice}. Parallel tool calls: ${body.parallel_tool_calls !== false}.`);
    schema = {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: choice === 'required' || forced ? ['tool_calls'] : ['message', 'tool_calls'] },
        content: { type: 'string' },
        calls: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { name: { type: 'string', enum: allowed.map(t => t.name) }, arguments: { type: 'object', additionalProperties: true } },
          required: ['name', 'arguments'] } },
      }, required: ['kind', 'content', 'calls'],
    };
  }
  const header = 'Continue the conversation represented by these JSON records. Respond to the latest turn. The role and tool_call_id fields identify who supplied each record.'
    + (images.length ? ' Records with an "images" field refer, in order, to the attached images.' : '');
  // Resumed sessions send only the new records; the header stays identical either way.
  // The caller's own records are full of tool talk, and they are the last thing the model reads.
  // Without a closing reminder it starts emitting native tool calls for tools that do not exist
  // here, has every one rejected and burns the subscription retrying. Recency beats the system
  // prompt, so the contract is repeated after the conversation as well.
  const footer = allowed.length
    ? '\nREMINDER: no tool is executable in this environment and every direct tool call will be rejected. '
      + 'Do not emit tool calls. Answer now with the required structured output: kind="tool_calls" to ask the caller to run functions, or kind="message" otherwise.'
    : '';
  const promptFor = entries => header + '\n' + JSON.stringify(entries) + footer;
  return {
    model: body.model, system: systems.join('\n\n'),
    ...taskOf(history),
    prompt: promptFor(history), promptFor, history,
    images,
    schema, validators, forced, required: choice === 'required', parallel: body.parallel_tool_calls !== false,
    stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true,
    effort: body.reasoning_effort, maxTokens,
  };
}

export function decodeResult(raw, req) {
  if (!raw || raw.is_error || raw.subtype !== 'success') {
    const detail = `${raw?.result || ''} ${JSON.stringify(raw?.errors || [])}`;
    if (/oauth|authenticat|log.?in|session expired/i.test(detail)) throw failure('The Claude Code session must be authenticated again on the VPS.', 503, 'claude_login_required');
    if (/usage limit|rate.limit|quota|capacity|hit your (?:(?:weekly|daily|monthly|session) )?limit|api error:\s*429/i.test(detail)) {
      throw failure('The Claude subscription is currently limited.', 429, 'claude_rate_limited');
    }
    // Upstream hiccups (500/502/503/504/529) are worth retrying, and clients only retry when the
    // status says so: a 502 reads as "this bridge is broken" and ends the turn for good.
    if (/api error:\s*(?:500|502|503|504|529)|overloaded|internal server error|temporarily unavailable|service unavailable|bad gateway/i.test(detail)) {
      throw Object.assign(failure('Claude is temporarily unavailable upstream.', 503, 'claude_upstream_unavailable'),
        { detail: detail.replace(/\s+/g, ' ').trim().slice(0, 300) });
    }
    throw Object.assign(failure('Claude Code did not complete the request.', 502, 'claude_execution_failed'),
      { detail: detail.replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  let message = { role: 'assistant', content: raw.result || '' };
  if (req.schema) {
    const value = raw.structured_output;
    if (!isObject(value) || typeof value.content !== 'string' || !Array.isArray(value.calls)) throw failure('Claude returned invalid structured output.', 502);
    if (value.kind === 'message') {
      if (req.required || req.forced) throw failure('A tool call was required.', 502);
      if (value.calls.length) throw failure('Unexpected tool calls in final message.', 502);
      message.content = value.content;
    } else if (value.kind === 'tool_calls') {
      if (!value.calls.length) throw failure('Claude returned no tool calls.', 502);
      if (!req.parallel && value.calls.length !== 1) throw failure('Unexpected parallel tool calls.', 502);
      message = { role: 'assistant', content: value.content || null, tool_calls: value.calls.map(call => {
        const validate = req.validators.get(call?.name);
        if (!validate || (req.forced && call.name !== req.forced)) throw failure('Claude selected an unavailable tool.', 502);
        if (!isObject(call.arguments) || !validate(call.arguments)) throw failure('Claude returned invalid tool arguments.', 502);
        return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
      }) };
    } else throw failure('Invalid structured output kind.', 502);
  }
  const u = raw.usage || {};
  const count = key => Number.isFinite(u[key]) && u[key] > 0 ? u[key] : 0;
  const prompt = count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
  const completion = count('output_tokens');
  // Session bookkeeping (set by withSessions): only a decoded, valid reply is worth remembering.
  if (typeof raw.__remember === 'function') raw.__remember(message);
  return { message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', session: raw.__session, usage: {
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: count('cache_read_input_tokens') },
  } };
}

// Who called and what the turn is about, for the local panel. `origin` is the client's own
// user agent, trimmed; `subject` is the latest human instruction, with the client's boilerplate
// blocks stripped and cut short. Both stay on this machine, in the same log this adapter already
// writes, and are never sent to the model.
export function originOf(headers = {}) {
  const raw = headers['x-title'] || headers['x-app'] || headers['user-agent'] || '';
  const text = String(raw).split(/[;(]/)[0].replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 40) : null;
}

const BOILERPLATE = /<system-reminder>[\s\S]*?<\/system-reminder>|<environment_details>[\s\S]*?<\/environment_details>|<[^>]{1,40}>/g;

// Factory's subagent prompts open with a header naming the task and the agent, which is a far
// better label than the raw text. Anything else falls back to the latest human instruction.
const TASK_TITLE = /^[ 	]*Task description:[ 	]*(.+)$/mi;
const TASK_AGENT = /^[ 	]*Subagent type:[ 	]*([\w .-]{1,30})$/mi;

export function taskOf(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.role !== 'user' || entry.tool_call_id) continue;
    const raw = String(entry.content || '');
    const titled = TASK_TITLE.exec(raw);
    if (titled) {
      return { subject: titled[1].replace(/\s+/g, ' ').trim().slice(0, 110), agent: TASK_AGENT.exec(raw)?.[1].trim() || null };
    }
    const text = raw.replace(BOILERPLATE, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 3) return { subject: text.slice(0, 110), agent: null };
  }
  return { subject: null, agent: null };
}

export const subjectOf = history => taskOf(history).subject;

const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const authEquals = (a, b) => { const x = Buffer.from(a || ''); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

const MESSAGES_ROUTES = new Set(['/v1/messages', '/messages', '/v1/v1/messages']);
const COUNT_ROUTES = new Set(['/v1/messages/count_tokens', '/messages/count_tokens', '/v1/v1/messages/count_tokens']);

async function readBody(request, maxBodyBytes, signal) {
  const chunks = []; let bytes = 0;
  for await (const piece of request) {
    bytes += piece.length;
    if (bytes > maxBodyBytes) throw failure('Request body is too large.', 413);
    chunks.push(piece);
  }
  if (signal.aborted) throw failure('Client disconnected.', 499);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('Invalid JSON request.'); }
}

export function createBridge({ models, key, run, maxBodyBytes = 16 * 1024 * 1024, maxConcurrent = 3, log = () => {}, status = () => ({}), messages, panel }) {
  if (!key || !models?.length || !run) throw Error('Bridge configuration is incomplete.');
  let active = 0;
  return async (request, response) => {
    const id = `chatcmpl-${randomUUID()}`;
    const origin = originOf(request.headers);
    if (request.method === 'GET' && request.url === '/health') {
      // `cli` reports the flag compatibility check; a failed check is the first thing to look at.
      const extra = status();
      return json(response, extra.cli && extra.cli.ok === false ? 503 : 200, { status: extra.cli && extra.cli.ok === false ? 'degraded' : 'ready', transport: 'claude-cli', active, ...extra });
    }
    // The panel and its data are read-only and carry no prompt text, so they stay unauthenticated:
    // the server is bound to 127.0.0.1, and demanding the bridge key would only break the browser.
    if (request.method === 'GET' && panel && (request.url === '/panel' || request.url === '/panel.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(panel.html);
    }
    if (request.method === 'GET' && panel && request.url === '/stats') {
      try { return json(response, 200, await panel.stats()); }
      catch { return json(response, 500, { error: { message: 'Could not build the statistics.' } }); }
    }
    // Anthropic SDKs authenticate with x-api-key; OpenAI SDKs with a bearer token. Same local key.
    const isMessages = MESSAGES_ROUTES.has(request.url) || COUNT_ROUTES.has(request.url);
    if (!authEquals(request.headers.authorization, `Bearer ${key}`) && !authEquals(request.headers['x-api-key'], key)) {
      return json(response, 401, isMessages ? { type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } } : { error: { message: 'Unauthorized', type: 'authentication_error' } });
    }
    if (request.method === 'GET' && request.url === '/v1/models') return json(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'claude-cli' })) });
    if (request.method === 'POST' && COUNT_ROUTES.has(request.url) && messages) {
      try { return json(response, 200, messages.countTokens(await readBody(request, maxBodyBytes, new AbortController().signal))); }
      catch (error) { const e = messages.anthropicError(error); return json(response, e.status, e.body); }
    }
    if (request.method !== 'POST' || !(request.url === '/v1/chat/completions' || (isMessages && messages))) return json(response, 404, { error: { message: 'Not found' } });
    if (active >= maxConcurrent) return json(response, 429, isMessages ? { type: 'error', error: { type: 'rate_limit_error', message: 'Claude CLI concurrency limit reached.' } } : { error: { message: 'Claude CLI concurrency limit reached.', code: 'bridge_busy' } });
    active++;
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    if (isMessages) {
      try {
        const body = await readBody(request, maxBodyBytes, controller.signal);
        await messages.handle({ body, id, response, signal: controller.signal, origin });
      } catch (error) {
        const e = messages.anthropicError(error);
        if (!response.destroyed && !response.headersSent) json(response, e.status, e.body);
        log({ id, status: e.status, api: 'messages', code: error.code || 'bridge_error' });
      } finally { response.off('close', disconnect); active--; }
      return;
    }
    let heartbeat;
    let sentText = '';
    let req;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish_reason = null, usage) => ({ id, object: 'chat.completion.chunk', created, model: req.model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
    const startStream = () => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n\n`);
    };
    const send = value => { if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`); };
    try {
      const body = await readBody(request, maxBodyBytes, controller.signal);
      req = prepareRequest(body, models);
      // Keep HTTP status available for early authentication failures. Heartbeats start after 15 seconds.
      if (req.stream) heartbeat = setInterval(() => { startStream(); if (!response.destroyed) response.write(': waiting for claude\n\n'); }, 15000);
      const raw = await run(req, { signal: controller.signal, onText: text => {
        if (!req.stream || req.schema || !text || response.destroyed) return;
        sentText += text; startStream(); send(chunk({ content: text }));
      } });
      const result = decodeResult(raw, req);
      if (response.destroyed) return;
      if (req.stream) {
        startStream();
        if (result.message.tool_calls) send(chunk({ content: result.message.content, tool_calls: result.message.tool_calls.map((call, index) => ({ index, ...call })) }));
        else if (!sentText) send(chunk({ content: result.message.content }));
        else if ((result.message.content || '').trim() !== sentText.trim()) throw failure('CLI final text does not match its streamed output.', 502, 'inconsistent_stream');
        send(chunk({}, result.finish_reason));
        if (req.includeUsage) send(chunk({}, null, result.usage));
        response.end('data: [DONE]\n\n');
      } else json(response, 200, { id, object: 'chat.completion', created, model: req.model,
        choices: [{ index: 0, message: result.message, finish_reason: result.finish_reason }], usage: result.usage });
      log({ id, model: req.model, status: 200, effort: req.effort || 'default', origin, agent: req.agent, subject: req.subject,
        ...(result.session ? { session: result.session.id.slice(0, 8), resumed: result.session.resumed } : {}), ...result.usage });
    } catch (error) {
      const status = error.status || 500;
      const envelope = { error: { message: error.status ? error.message : 'Internal bridge error.', type: 'api_error', code: error.code || 'bridge_error' } };
      if (!response.destroyed) {
        if (response.headersSent) { send(envelope); response.end('data: [DONE]\n\n'); }
        else json(response, status, envelope);
      }
      log({ id, model: req?.model, status, code: envelope.error.code, origin, agent: req?.agent, subject: req?.subject, ...(error.detail ? { detail: error.detail } : {}) });
    } finally {
      clearInterval(heartbeat); response.off('close', disconnect); active--;
    }
  };
}
