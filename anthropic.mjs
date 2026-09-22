// Anthropic Messages API surface (/v1/messages) on top of the same claude -p runner.
// Requests are translated to the OpenAI shape that prepareRequest() already validates, and the
// decoded result is rendered back as Anthropic blocks (text / tool_use) or as the SSE event stream.
import { randomUUID } from 'node:crypto';
import { failure, prepareRequest, decodeResult } from './bridge.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

function imagePart(block) {
  const src = block.source || {};
  if (src.type === 'base64') return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
  throw failure('Unsupported image source.');
}

function effortFromThinking(body) {
  const explicit = body.output_config?.effort ?? body.effort;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(explicit)) return explicit;
  const budget = body.thinking?.type === 'enabled' ? Number(body.thinking.budget_tokens) : 0;
  if (!budget) return undefined;
  return budget < 4096 ? 'low' : budget < 16384 ? 'medium' : 'high';
}

// Anthropic request -> OpenAI chat body (validated afterwards by prepareRequest).
export function toChatBody(body) {
  if (!isObject(body)) throw failure('The request must be a JSON object.');
  if (!Array.isArray(body.messages)) throw failure('messages must be an array.');
  const messages = [];
  const systems = typeof body.system === 'string' ? [body.system] : Array.isArray(body.system) ? [textOf(body.system)] : [];
  for (const s of systems) if (s) messages.push({ role: 'system', content: s });
  for (const msg of body.messages) {
    if (!isObject(msg) || !['user', 'assistant'].includes(msg.role)) throw failure('Messages must have role user or assistant.');
    if (typeof msg.content === 'string') { messages.push({ role: msg.role, content: msg.content }); continue; }
    if (!Array.isArray(msg.content)) throw failure('Message content must be a string or an array of blocks.');
    if (msg.role === 'assistant') {
      const text = textOf(msg.content);
      const calls = msg.content.filter(b => b?.type === 'tool_use').map(b => {
        if (typeof b.id !== 'string' || typeof b.name !== 'string' || !isObject(b.input)) throw failure('Invalid tool_use block.');
        return { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } };
      });
      // thinking / redacted_thinking blocks are dropped: they cannot be replayed through the CLI.
      messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    const parts = []; const results = [];
    for (const b of msg.content) {
      if (b?.type === 'text') parts.push({ type: 'text', text: b.text ?? '' });
      else if (b?.type === 'image') parts.push(imagePart(b));
      else if (b?.type === 'tool_result') {
        if (typeof b.tool_use_id !== 'string') throw failure('tool_result requires tool_use_id.');
        const content = typeof b.content === 'string' ? b.content : textOf(b.content);
        results.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `[error] ${content}` : content });
      } else throw failure(`Unsupported content block: ${b?.type}`);
    }
    // Tool results answer the previous assistant turn, so they go before this turn's own text.
    messages.push(...results);
    if (parts.length) messages.push({ role: 'user', content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts });
  }
  const chat = { model: body.model, messages, stream: body.stream === true, max_tokens: body.max_tokens };
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.map(t => {
      if (!isObject(t) || typeof t.name !== 'string') throw failure('Only custom tools with a name are supported.');
      return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } } };
    });
  }
  const choice = body.tool_choice;
  if (isObject(choice)) {
    if (choice.type === 'any') chat.tool_choice = 'required';
    else if (choice.type === 'tool') chat.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice.type === 'none') chat.tool_choice = 'none';
    else chat.tool_choice = 'auto';
    if (choice.disable_parallel_tool_use === true) chat.parallel_tool_calls = false;
  }
  const effort = effortFromThinking(body);
  if (effort) chat.reasoning_effort = effort;
  return chat;
}

const toolUseId = () => `toolu_${randomUUID().replaceAll('-', '')}`;

function blocksOf(message) {
  const blocks = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls || []) {
    blocks.push({ type: 'tool_use', id: toolUseId(), name: call.function.name, input: JSON.parse(call.function.arguments) });
  }
  return blocks;
}

function usageOf(result) {
  const cached = result.usage.prompt_tokens_details?.cached_tokens || 0;
  return { input_tokens: Math.max(0, result.usage.prompt_tokens - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: result.usage.completion_tokens };
}

export function toMessageResponse(result, model) {
  const blocks = blocksOf(result.message);
  return { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model, content: blocks,
    stop_reason: result.message.tool_calls ? 'tool_use' : 'end_turn', stop_sequence: null, usage: usageOf(result) };
}

export function anthropicError(error) {
  const status = error.status || 500;
  const type = status === 401 ? 'authentication_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error'
    : status === 413 ? 'invalid_request_error' : error.code === 'claude_upstream_unavailable' ? 'overloaded_error'
    : status >= 500 ? 'api_error' : 'invalid_request_error';
  return { status, body: { type: 'error', error: { type, message: error.status ? error.message : 'Internal bridge error.' } } };
}

export function createMessagesHandler({ models, run, log = () => {} }) {
  return async ({ body, id, response, signal, origin = null }) => {
    const req = prepareRequest(toChatBody(body), models);
    const created = () => ({ id: `msg_${id.replace(/^chatcmpl-/, '').replaceAll('-', '')}` });
    const send = (event, data) => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let started = false; let textOpen = false; let sentText = '';
    const start = () => {
      if (started || response.headersSent || response.destroyed) return;
      started = true;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      send('message_start', { type: 'message_start', message: { ...created(), type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    };
    let heartbeat;
    if (req.stream) heartbeat = setInterval(() => { start(); send('ping', { type: 'ping' }); }, 15000);
    try {
      const raw = await run(req, { signal, onText: text => {
        if (!req.stream || req.schema || !text || response.destroyed) return;
        start();
        if (!textOpen) { send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); textOpen = true; }
        sentText += text; send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      } });
      const result = decodeResult(raw, req);
      if (response.destroyed) return;
      if (!req.stream) {
        const payload = toMessageResponse(result, req.model);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload));
      } else {
        start();
        const blocks = blocksOf(result.message);
        let index = 0;
        for (const block of blocks) {
          if (block.type === 'text') {
            if (textOpen) {
              if (block.text.trim() !== sentText.trim()) throw failure('CLI final text does not match its streamed output.', 502, 'inconsistent_stream');
            } else {
              send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
              send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
            }
            send('content_block_stop', { type: 'content_block_stop', index }); textOpen = false;
          } else {
            send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
            send('content_block_stop', { type: 'content_block_stop', index });
          }
          index++;
        }
        const usage = usageOf(result);
        send('message_delta', { type: 'message_delta', delta: { stop_reason: result.message.tool_calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens } });
        send('message_stop', { type: 'message_stop' });
        response.end();
      }
      log({ id, model: req.model, status: 200, effort: req.effort || 'default', api: 'messages', origin, subject: req.subject,
        ...(result.session ? { session: result.session.id.slice(0, 8), resumed: result.session.resumed } : {}), ...result.usage });
    } catch (error) {
      const { status, body: envelope } = anthropicError(error);
      if (!response.destroyed) {
        if (response.headersSent) { send('error', envelope); response.end(); }
        else { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(envelope)); }
      }
      log({ id, model: req?.model || body?.model, status, api: 'messages', code: error.code || 'bridge_error', origin, subject: req?.subject, ...(error.detail ? { detail: error.detail } : {}) });
    } finally { clearInterval(heartbeat); }
  };
}

// Rough estimate; the CLI has no token counter and Anthropic clients call this before sending.
export function countTokens(body) {
  const chat = toChatBody({ ...body, stream: false });
  const text = JSON.stringify(chat.messages) + JSON.stringify(chat.tools || []);
  return { input_tokens: Math.ceil(text.length / 3.5) };
}
