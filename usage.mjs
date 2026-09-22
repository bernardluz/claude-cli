// Subscription usage for the account Claude Code is logged in with. The OAuth token is read from
// the Claude Code credentials file and used only for this call; it is never logged or returned.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WINDOWS = [['five_hour', '5 horas'], ['seven_day', '7 dias'], ['seven_day_opus', '7 dias (Opus)']];

export function normalizeUsage(payload) {
  const windows = [];
  for (const [key, label] of WINDOWS) {
    const w = payload?.[key] ?? payload?.usage?.[key];
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const resets = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    windows.push({
      label,
      used: Math.round(Math.max(0, Math.min(100, w.utilization))),
      resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : null,
    });
  }
  return windows;
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
      const windows = normalizeUsage(await response.json());
      value = windows.length ? { windows, checkedAt: new Date(now()).toISOString() } : { windows: [], error: 'a assinatura ainda não informou consumo' };
    } catch (error) {
      // Never surface the raw error: it can carry the request headers, and therefore the token.
      value = { windows: [], error: error?.reason || 'não foi possível consultar a assinatura' };
    }
    cache = { at: now(), value };
    return value;
  };
}
