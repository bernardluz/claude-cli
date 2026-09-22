// Conversation -> Claude Code session mapping, so follow-up turns reuse `claude -p --resume`
// (server-side prompt cache over the whole history) instead of replaying the transcript.
//
// Clients speak stateless chat APIs: every turn resends the full history. After each successful
// answer we remember "history + our reply" under a hash; the next request whose history starts
// with exactly that state resumes the session and sends only the new records. Any mismatch
// (edited message, compaction, restart) silently falls back to a fresh session.
import { createHash, randomUUID } from 'node:crypto';

// Tool-call identifiers are minted per reply (and minted again by the Anthropic layer, which
// hands out `toolu_*` ids for the `call_*` ones stored here), so a client echoing our own reply
// back never reproduces the same ids. Identity is positional instead: the n-th call of the
// conversation, plus the record that answers it. Arguments are re-serialised with sorted keys so
// a JSON round-trip through the client cannot change the hash either.
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const stableArgs = text => { try { return JSON.stringify(stable(JSON.parse(text))); } catch { return text; } };

function canonical(entries) {
  const slot = new Map();
  return entries.map(entry => {
    const out = { role: entry.role, content: entry.content || '', images: entry.images || [] };
    if (entry.tool_calls) out.tool_calls = entry.tool_calls.map(call => {
      if (!slot.has(call.id)) slot.set(call.id, slot.size);
      return { slot: slot.get(call.id), name: call.name, arguments: stableArgs(call.arguments) };
    });
    if (entry.tool_call_id) out.answers = slot.has(entry.tool_call_id) ? slot.get(entry.tool_call_id) : -1;
    return out;
  });
}

const hashOf = (model, system, entries) => createHash('sha256').update(JSON.stringify([model, system, canonical(entries)])).digest('hex');
const contextOf = (model, system) => createHash('sha256').update(JSON.stringify([model, system])).digest('hex');

// The assistant record exactly as prepareRequest() will normalise it when the client echoes it back.
export function assistantEntry(message) {
  const entry = { role: 'assistant', content: message.content || '' };
  if (message.tool_calls?.length) entry.tool_calls = message.tool_calls.map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
  return entry;
}

export function createSessionStore({ ttlMs = 60 * 60 * 1000, max = 1000, now = Date.now } = {}) {
  const byHash = new Map(); // hash -> { sessionId, context, length, lastUsed }
  // Claude Code owns one transcript file per session, so two requests must never resume the same
  // one at the same time. A session already in flight is simply not offered; the second caller
  // gets a fresh session and pays the full prompt once.
  const inFlight = new Set();
  let dirty = false;
  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [key, value] of byHash) if (value.lastUsed < cutoff) byHash.delete(key);
    while (byHash.size > max) byHash.delete(byHash.keys().next().value);
  };
  return {
    size: () => byHash.size,
    // Longest stored state that is a prefix of this history, ending right before new client records.
    plan(req) {
      prune();
      const { model, system, history } = req;
      for (let m = history.length - 1; m >= 1; m--) {
        if (history[m - 1].role !== 'assistant') continue;
        const hit = byHash.get(hashOf(model, system, history.slice(0, m)));
        if (hit && !inFlight.has(hit.sessionId)) {
          hit.lastUsed = now(); inFlight.add(hit.sessionId);
          return { resume: hit.sessionId, newEntries: history.slice(m) };
        }
      }
      // A miss on a conversation that already has assistant turns means the stored state no longer
      // matches. `sameContext` separates the two causes: states kept for this same model+system
      // (the history diverged) or none at all (the client rewrites its system prompt every turn).
      const context = contextOf(model, system);
      let sameContext = 0;
      for (const value of byHash.values()) if (value.context === context) sameContext++;
      return { create: randomUUID(), newEntries: history,
        miss: history.some(e => e.role === 'assistant') ? { stored: byHash.size, sameContext } : null };
    },
    remember(req, sessionId, message) {
      const state = [...req.history, assistantEntry(message)];
      byHash.set(hashOf(req.model, req.system, state), { sessionId, context: contextOf(req.model, req.system), length: state.length, lastUsed: now() });
      dirty = true;
      prune();
    },
    forget(sessionId) { for (const [key, value] of byHash) if (value.sessionId === sessionId) byHash.delete(key); },
    release(sessionId) { inFlight.delete(sessionId); },
    busy: () => inFlight.size,
    // The map holds only hashes and session ids, never prompt text, so it can outlive the process:
    // an adapter restart would otherwise make every open conversation pay its whole context again.
    drain() { if (!dirty) return null; dirty = false; prune(); return [...byHash].map(([hash, v]) => ({ hash, ...v })); },
    load(entries) {
      const cutoff = now() - ttlMs;
      for (const e of Array.isArray(entries) ? entries : []) {
        if (typeof e?.hash === 'string' && typeof e.sessionId === 'string' && e.lastUsed > cutoff) {
          byHash.set(e.hash, { sessionId: e.sessionId, context: e.context, length: e.length, lastUsed: e.lastUsed });
        }
      }
      prune();
    },
  };
}

// Wraps a runner: plans the session, trims the prompt to the new records, records the outcome,
// and retries once from scratch when a resume is rejected by the CLI (expired/missing transcript).
export function withSessions(run, store, { log = () => {} } = {}) {
  return async (req, options) => {
    const plan = store.plan(req);
    try {
    const attempt = async (session, entries) => run({ ...req, session, prompt: req.promptFor(entries) }, options);
    let raw; let sessionId; let resumed = false;
    if (plan.resume) {
      sessionId = plan.resume; resumed = true;
      try {
        raw = await attempt({ resume: sessionId }, plan.newEntries);
        if (!raw || raw.is_error || raw.subtype !== 'success') throw Object.assign(new Error('resume failed'), { resumeFailed: true, raw });
      } catch (error) {
        if (!error.resumeFailed && error.status === 499) throw error; // client disconnected: nothing to retry
        store.forget(sessionId);
        log({ event: 'session-resume-failed', session: sessionId, code: error.code || (error.raw ? 'cli_result' : 'error') });
        sessionId = randomUUID(); resumed = false;
        raw = await attempt({ create: sessionId }, req.history);
      }
    } else {
      if (plan.miss) log({ event: 'session-miss', turns: req.history.length, ...plan.miss });
      sessionId = plan.create;
      raw = await attempt({ create: sessionId }, req.history);
    }
    if (raw && !raw.is_error && raw.subtype === 'success') {
      // Remember only what the client will echo back; decoding happens in the bridge.
      raw.__session = { id: sessionId, resumed };
      raw.__remember = message => store.remember(req, sessionId, message);
    }
    return raw;
    } finally { if (plan.resume) store.release(plan.resume); }
  };
}
