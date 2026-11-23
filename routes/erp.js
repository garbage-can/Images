// ERP 服务端接口：账号同步 + 额度设置。
// 鉴权使用 ERP_API_TOKEN（Bearer），不依赖浏览器 session/CSRF。

import { timingSafeEqual, randomBytes } from 'node:crypto';

import { sendJson, sendMethodNotAllowed, readJsonBody, bodyErrorStatus, routeErrorStatus } from '../utils/http.js';
import { users as usersTable } from '../services/db.js';
import { createUserByAdmin } from '../services/users.js';
import { summary, patchUserQuota } from '../services/quota.js';
import { sanitizeUser } from '../services/auth.js';
import { logger } from '../utils/logger.js';

const ERP_TOKEN = String(process.env.ERP_API_TOKEN || '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QUOTA_KEYS = ['daily_limit', 'monthly_limit', 'storage_limit_mb', 'concurrent_limit'];

function authorized(req) {
  if (!ERP_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(ERP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueUsername(email) {
  let base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  if (base.length < 3) base = 'erp';
  if (!usersTable.findByLogin(base)) return base;
  for (let i = 0; i < 20; i += 1) {
    const candidate = (base + '-' + randomBytes(2).toString('hex')).slice(0, 32);
    if (!usersTable.findByLogin(candidate)) return candidate;
  }
  return (base + '-' + Date.now().toString(36)).slice(0, 32);
}

function quotaPatchFrom(item) {
  const patch = {};
  for (const key of QUOTA_KEYS) {
    if (item[key] === undefined) continue;
    if (item[key] === null || item[key] === '') {
      patch[key] = null;
      continue;
    }
    const n = Number(item[key]);
    if (!Number.isFinite(n) || n < 0) throw new Error('invalid ' + key);
    patch[key] = Math.floor(n);
  }
  return patch;
}

async function handleListUsers(req, res, url) {
  if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
  const department = String(url.searchParams.get('department') || '').trim();
  const status = String(url.searchParams.get('status') || '').trim();
  let rows = usersTable.list();
  if (department) rows = rows.filter((u) => (u.department || '') === department);
  if (status) rows = rows.filter((u) => u.status === status);
  const items = rows.map((u) => {
    const sum = summary(u.id);
    return { user: sanitizeUser(u), quota: sum.quota, usage: sum.usage };
  });
  sendJson(res, 200, { items, total: items.length });
}

async function handleSync(req, res) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, bodyErrorStatus(err), { error: err.message || 'invalid json' });
  }
  const items = Array.isArray(body?.users) ? body.users : null;
  if (!items) return sendJson(res, 400, { error: 'users array required' });
  if (items.length > 1000) return sendJson(res, 413, { error: 'too many users (max 1000)' });

  const result = { created: 0, updated: 0, unchanged: 0, disabled: 0, errors: [] };
  const seen = new Set();

  for (const item of items) {
    try {
      const email = normalizeEmail(item?.email);
      if (!EMAIL_RE.test(email)) throw new Error('invalid email');
      seen.add(email);
      const role = item.role === 'admin' ? 'admin' : 'user';
      const status = item.status === 'disabled' ? 'disabled' : 'active';
      const department = item.department === undefined ? undefined : (item.department || null);
      const displayName = item.name === undefined ? undefined : String(item.name || '').slice(0, 80);
      const quota = quotaPatchFrom(item || {});
      const hasQuota = Object.keys(quota).length > 0;

      let user = usersTable.findByEmail(email);
      if (!user) {
        user = createUserByAdmin({
          username: uniqueUsername(email),
          email,
          password: randomBytes(24).toString('base64url'),
          role,
          department,
          source: 'erp',
          displayName
        });
        if (status === 'disabled') usersTable.updateStatus(user.id, 'disabled');
        if (hasQuota) patchUserQuota(user.id, quota, null);
        result.created += 1;
        continue;
      }

      let changed = false;
      if (user.role !== role) {
        user = usersTable.updateRole(user.id, role);
        changed = true;
      }
      if (user.status !== status) {
        user = usersTable.updateStatus(user.id, status);
        changed = true;
      }
      const org = usersTable.updateOrg(user.id, {
        department: department === undefined ? user.department : department,
        source: 'erp',
        displayName: displayName === undefined ? user.display_name : displayName
      });
      if (
        org.department !== user.department ||
        org.display_name !== user.display_name ||
        org.source !== user.source
      ) {
        changed = true;
      }
      if (hasQuota) {
        patchUserQuota(user.id, quota, null);
        changed = true;
      }
      if (changed) result.updated += 1;
      else result.unchanged += 1;
    } catch (err) {
      result.errors.push({ email: normalizeEmail(item?.email), error: String(err.message || err).slice(0, 160) });
    }
  }

  if (body?.full === true) {
    for (const user of usersTable.list()) {
      if (user.source !== 'erp') continue;
      if (user.status !== 'active') continue;
      if (seen.has(String(user.email).toLowerCase())) continue;
      usersTable.updateStatus(user.id, 'disabled');
      result.disabled += 1;
    }
  }

  logger.info('erp.users.sync', { created: result.created, updated: result.updated, disabled: result.disabled, errors: result.errors.length });
  sendJson(res, 200, result);
}

async function handleUserQuota(req, res, email) {
  if (req.method !== 'PUT') return sendMethodNotAllowed(res, ['PUT']);
  const normalized = normalizeEmail(email);
  const user = usersTable.findByEmail(normalized);
  if (!user) return sendJson(res, 404, { error: 'user not found' });
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, bodyErrorStatus(err), { error: err.message || 'invalid json' });
  }
  try {
    const patch = quotaPatchFrom(body || {});
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'no quota fields' });
    patchUserQuota(user.id, patch, null);
    logger.info('erp.user.quota', { userId: user.id, patch });
    sendJson(res, 200, { user: sanitizeUser(user), ...summary(user.id) });
  } catch (err) {
    sendJson(res, routeErrorStatus(err), { error: err.message });
  }
}

export async function handleErpRoute(req, res, pathname, url) {
  if (!ERP_TOKEN) return sendJson(res, 503, { error: 'ERP_API_TOKEN not configured' });
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (pathname === '/api/erp/users') return handleListUsers(req, res, url);
  if (pathname === '/api/erp/users/sync') return handleSync(req, res);
  const quota = pathname.match(/^\/api\/erp\/users\/([^/]+)\/quota\/?$/);
  if (quota) return handleUserQuota(req, res, decodeURIComponent(quota[1]));
  return sendJson(res, 404, { error: 'not found' });
}

export default handleErpRoute;
