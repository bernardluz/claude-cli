// Request bookkeeping for the local panel: every log entry the bridge emits for a finished request
// is folded into rolling counters plus a short ring of recent calls. Prompts never enter here, only
// the same fields already written to the log file (model, status, tokens, session, effort).
const FIELDS = ['requests', 'ok', 'failed', 'cancelled', 'resumed', 'prompt', 'cached', 'output'];

const empty = () => Object.fromEntries(FIELDS.map(f => [f, 0]));

export function createMetrics({ max = 400, now = Date.now } = {}) {
  const started = now();
  let totals = empty();
  const byModel = new Map();
  const codes = new Map();
  const recent = [];
  let dirty = false;

  const bucket = model => {
    if (!byModel.has(model)) byModel.set(model, empty());
    return byModel.get(model);
  };

  return {
    // Accepts the bridge's own log entries; anything that is not a finished request is ignored.
    record(entry) {
      if (!entry || typeof entry.status !== 'number') return;
      const model = entry.model || 'desconhecido';
      const usage = entry.prompt_tokens_details || {};
      const row = {
        at: now(), model, status: entry.status, code: entry.code || null, effort: entry.effort || null,
        session: entry.session || null, resumed: entry.resumed === true,
        prompt: entry.prompt_tokens || 0, cached: usage.cached_tokens || 0, output: entry.completion_tokens || 0,
        detail: entry.detail ? String(entry.detail).slice(0, 160) : null,
      };
      for (const target of [totals, bucket(model)]) {
        target.requests++;
        if (row.status === 200) target.ok++;
        else if (row.status === 499) target.cancelled++;
        else target.failed++;
        if (row.resumed) target.resumed++;
        target.prompt += row.prompt; target.cached += row.cached; target.output += row.output;
      }
      if (row.status !== 200) codes.set(row.code || String(row.status), (codes.get(row.code || String(row.status)) || 0) + 1);
      recent.push(row);
      while (recent.length > max) recent.shift();
      dirty = true;
    },
    snapshot() {
      const models = [...byModel].map(([model, value]) => ({ model, ...value })).sort((a, b) => b.requests - a.requests);
      return {
        since: new Date(started).toISOString(),
        totals: { ...totals },
        models,
        errors: [...codes].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
        recent: recent.slice(-60).reverse(),
      };
    },
    // Persistence mirrors the session store: survive a restart without re-reading the log file.
    drain() { if (!dirty) return null; dirty = false; return { started, totals, byModel: [...byModel], codes: [...codes], recent }; },
    load(saved) {
      if (!saved || typeof saved !== 'object') return;
      if (saved.totals) totals = { ...empty(), ...saved.totals };
      for (const [model, value] of saved.byModel || []) byModel.set(model, { ...empty(), ...value });
      for (const [code, count] of saved.codes || []) codes.set(code, count);
      for (const row of (saved.recent || []).slice(-max)) recent.push(row);
    },
  };
}
