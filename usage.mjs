// Subscription usage for the account Claude Code is logged in with. The OAuth token is read from
// the Claude Code credentials file and used only for this call; it is never logged or returned.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Legacy shape, still returned by the endpoint but with the per-model windows blanked out.
const WINDOWS = [['five_hour', '5 horas'], ['seven_day', '7 dias'], ['seven_day_opus', '7 dias (Opus)']];

const percent = value => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : null;
const instant = value => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export function normalizeUsage(payload) {
  // `limits` is the current shape and the only place the per-model caps appear, each as a
  // weekly_scoped row naming its model (Fable, Opus, ...). The fixed keys no longer carry them.
  const rows = Array.isArray(payload?.limits) ? payload.limits : [];
  const windows = [];
  for (const row of rows) {
    const used = percent(row?.percent);
    if (used === null) continue;
    const model = row?.scope?.model?.display_name;
    windows.push({
      label: row.kind === 'session' ? '5 horas' : model ? `7 dias · ${model}` : '7 dias',
      used,
      resetsAt: instant(row.resets_at),
      severity: typeof row.severity === 'string' ? row.severity : null,
      active: row.is_active === true,
    });
  }
  if (windows.length) return windows;
  for (const [key, label] of WINDOWS) {
    const w = payload?.[key] ?? payload?.usage?.[key];
    const used = percent(w?.utilization);
    if (used === null) continue;
    windows.push({ label, used, resetsAt: instant(w.resets_at), severity: null, active: false });
  }
  return windows;
}

// Where the weekly window was spent (Claude Code, chats, cowork...), when the account reports it.
export function normalizeBreakdown(payload) {
  const rows = payload?.seven_day_breakdown?.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({ label: r?.display_name || r?.key || '?', used: percent(r?.percent) }))
    .filter(r => r.used !== null && r.used > 0)
    .sort((a, b) => b.used - a.used);
}

// Cached because the panel polls: the subscription window moves in minutes, not seconds.
export function createUsageReader({ configDir, ttlMs = 5 * 60 * 1000, now = Date.now, fetchImpl = fetch } = {}) {
  let cache = null;
  return async function read() {
    if (cache && now() - cache.at < ttlMs) return cache.value;
    let value;
    try {
      const path = join(configDir || join(homedir(), '.claude'), '.credentials.json');
      const token = JSON.parse(await readFile(path, 'utf8'))?.claudeAiOauth?.accessToken;
      if (!token) throw Object.assign(Error('sem token'), { reason: 'Claude Code não está autenticado' });
      const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      });
      if (!response.ok) {
        throw Object.assign(Error('http'), { reason: [401, 403].includes(response.status) ? 'refaça o login do Claude Code' : `consulta falhou (${response.status})` });
      }
      const payload = await response.json();
      const windows = normalizeUsage(payload);
      value = windows.length
        ? { windows, breakdown: normalizeBreakdown(payload), checkedAt: new Date(now()).toISOString() }
        : { windows: [], error: 'a assinatura ainda não informou consumo' };
    } catch (error) {
      // Never surface the raw error: it can carry the request headers, and therefore the token.
      value = { windows: [], error: error?.reason || 'não foi possível consultar a assinatura' };
    }
    cache = { at: now(), value };
    return value;
  };
}
