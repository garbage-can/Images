import { sendJson, sendMethodNotAllowed } from '../utils/http.js';
import { requireAdmin } from '../middleware/guard.js';
import { openDatabase } from '../services/db.js';

const PLUGIN_BASE = String(process.env.CPA_PLUGIN_BASE || '').replace(/\/+$/, '');
const MGMT_KEY = String(process.env.CPA_MGMT_KEY || '');
const MAX_PAGES = 10;
const CACHE_TTL_MS = 30_000;
const cache = new Map();

function cst(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}

async function pluginJson(path, ttlMs = CACHE_TTL_MS) {
  if (!PLUGIN_BASE || !MGMT_KEY) throw new Error('CPA plugin not configured');
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const res = await fetch(PLUGIN_BASE + path, {
    headers: { authorization: 'Bearer ' + MGMT_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(12_000)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || 'plugin HTTP ' + res.status;
    throw new Error(String(msg).slice(0, 200));
  }
  cache.set(path, { at: Date.now(), data });
  return data;
}

function classify(entry) {
  if (!entry?.failed) return 'ok';
  const body = String(entry.error_body || '').toLowerCase();
  if (body.includes('context canceled') || body.includes('canceled') || body.includes('cancelled')) {
    return 'cancelled';
  }
  return 'failed';
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

async function fetchEvents(fromIso, toIso) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({
      from: fromIso,
      to: toIso,
      limit: '500',
      offset: String(out.length)
    });
    const data = await pluginJson('/events?' + qs.toString());
    const entries = Array.isArray(data.entries) ? data.entries : [];
    out.push(...entries);
    if (entries.length < 500) break;
  }
  return out;
}

function hourlyBuckets(entries, fromMs, toMs) {
  const hour = 3600e3;
  const start = Math.floor(fromMs / hour) * hour;
  const buckets = [];
  for (let t = start; t <= toMs; t += hour) {
    buckets.push({
      at: t,
      label: new Date(t + 8 * hour).toISOString().slice(11, 16),
      ok: 0,
      cancelled: 0,
      failed: 0
    });
  }
  const index = new Map(buckets.map((b, i) => [b.at, i]));
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    const slot = Math.floor(at / hour) * hour;
    const i = index.get(slot);
    if (i === undefined) continue;
    buckets[i][classify(entry)] += 1;
  }
  return buckets;
}

async function buildCodex() {
  const files = (await pluginJson('/auth-files')).files || [];
  const codex = files.filter((f) => f.category === 'codex');
  const accounts = [];
  for (const file of codex) {
    const item = {
      account: file.title || file.name,
      disabled: Boolean(file.disabled),
      plan: '',
      windows: [],
      error: ''
    };
    try {
      const data = await pluginJson(
        '/auth-files/quota?auth_index=' + encodeURIComponent(file.auth_index),
        60_000
      );
      item.plan = data.plan || '';
      const windows = Array.isArray(data.quota) ? data.quota : [];
      item.windows = windows.map((w) => ({
        label: w.label || String(w.window_seconds || ''),
        windowSeconds: w.window_seconds || 0,
        remainingPercent: typeof w.remaining_percent === 'number' ? w.remaining_percent : null,
        resetAt: w.reset_at || '',
        usage: w.usage || null,
        meterAvailable: Boolean(w.meter && Object.keys(w.meter).length)
      }));
    } catch (err) {
      item.error = String(err.message || err).slice(0, 160);
    }
    accounts.push(item);
  }
  return accounts;
}

function studioStats(hours) {
  const since = Date.now() - hours * 3600e3;
  const sinceIso = new Date(since).toISOString();
  const db = openDatabase();
  const jobs = {};
  for (const row of db.prepare(
    'SELECT status, COUNT(*) AS n FROM generation_jobs WHERE created_at >= ? GROUP BY status'
  ).all(since)) {
    jobs[row.status] = Number(row.n) || 0;
  }
  const users = db.prepare(
    `SELECT u.username AS username, j.status AS status, COUNT(*) AS n
       FROM generation_jobs j LEFT JOIN users u ON u.id = j.user_id
      WHERE j.created_at >= ? GROUP BY u.username, j.status`
  ).all(since).map((r) => ({ user: r.username || '?', status: r.status, n: Number(r.n) || 0 }));
  const images = Number(db.prepare(
    'SELECT COUNT(*) AS n FROM images WHERE created_at >= ?'
  ).get(sinceIso)?.n) || 0;
  return { jobs, users, images };
}

export async function handleAdminUsageRoute(req, res, pathname, url) {
  if (pathname !== '/api/admin/usage') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, ['GET']);
    return;
  }
  if (!requireAdmin(req, res)) return;

  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 5));
  const now = Date.now();
  const from = now - hours * 3600e3;
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(now).toISOString();

  const payload = {
    window: { hours, from: fromIso, to: toIso, fromCst: cst(fromIso), toCst: cst(toIso) },
    cpa: { error: '', total: 0, ok: 0, cancelled: 0, failed: 0, latency: null, accounts: [], models: [], hourly: [], errors: [] },
    codex: [],
    studio: { jobs: {}, users: [], images: 0 }
  };

  try {
    payload.studio = studioStats(hours);
  } catch (err) {
    payload.studio.error = String(err.message || err).slice(0, 160);
  }

  try {
    const entries = await fetchEvents(fromIso, toIso);
    const ok = entries.filter((e) => classify(e) === 'ok');
    const cancelled = entries.filter((e) => classify(e) === 'cancelled');
    const failed = entries.filter((e) => classify(e) === 'failed');
    const latencies = ok.map((e) => Number(e.latency_ms) || 0).sort((a, b) => a - b);
    const accountMap = new Map();
    for (const entry of entries) {
      const key = entry.account || entry.credential || 'unknown';
      const bucket = accountMap.get(key) || { account: key, ok: 0, cancelled: 0, failed: 0 };
      bucket[classify(entry)] += 1;
      accountMap.set(key, bucket);
    }
    const modelMap = new Map();
    for (const entry of entries) {
      const key = entry.billing_model || entry.upstream_model || 'unknown';
      modelMap.set(key, (modelMap.get(key) || 0) + 1);
    }
    payload.cpa = {
      error: '',
      total: entries.length,
      ok: ok.length,
      cancelled: cancelled.length,
      failed: failed.length,
      latency: latencies.length
        ? {
            avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
            p50: percentile(latencies, 0.5),
            p90: percentile(latencies, 0.9),
            max: latencies[latencies.length - 1]
          }
        : null,
      accounts: [...accountMap.values()].sort((a, b) => b.ok + b.failed + b.cancelled - (a.ok + a.failed + a.cancelled)),
      models: [...modelMap.entries()].map(([model, n]) => ({ model, n })),
      hourly: hourlyBuckets(entries, from, now),
      errors: failed.slice(0, 8).map((e) => ({
        at: cst(e.at),
        account: e.account || '',
        latencyMs: e.latency_ms || 0,
        error: String(e.error_body || '').slice(0, 180)
      }))
    };
  } catch (err) {
    payload.cpa.error = String(err.message || err).slice(0, 200);
  }

  try {
    payload.codex = await buildCodex();
  } catch (err) {
    payload.codex = [{ error: String(err.message || err).slice(0, 200) }];
  }

  sendJson(res, 200, payload);
}
