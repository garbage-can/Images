// /api/auth/sso/* —— OIDC 单点登录入口。
// 流程：config -> start（302 到 IdP）-> callback（换 token、校验、建会话）。

import { sendJson, sendMethodNotAllowed } from '../utils/http.js';
import { setSessionCookie, parseCookies, setSsoStateCookie, clearSsoStateCookie } from '../utils/cookies.js';
import { clientIp, userAgent } from '../utils/request.js';
import { logger } from '../utils/logger.js';
import { users as usersTable } from '../services/db.js';
import { createUserByAdmin } from '../services/users.js';
import { createSession } from '../services/auth.js';
import {
  buildRedirectUri,
  claimsFromUserinfo,
  emailAllowed,
  exchangeCode,
  fetchUserinfo,
  getDiscovery,
  getSsoConfig,
  pkcePair,
  randomToken,
  ssoPublicConfig,
  verifyIdToken
} from '../services/sso.js';

const STATE_TTL_MS = 10 * 60_000;
const states = new Map();

function cleanupStates() {
  const now = Date.now();
  for (const [key, value] of states) {
    if (value.expiresAt <= now) states.delete(key);
  }
}

function safeRedirect(value) {
  const target = String(value || '/');
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function fail(res, code, detail) {
  logger.warn('auth.sso.failed', { code, detail: String(detail || '').slice(0, 160) });
  redirect(res, '/login.html?sso_error=' + encodeURIComponent(code));
}

function usernameBase(email) {
  let base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  base = base.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  if (base.length < 3) base = 'sso-' + randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return base;
}

function uniqueUsername(email) {
  const base = usernameBase(email);
  if (!usersTable.findByLogin(base)) return base;
  for (let i = 0; i < 8; i += 1) {
    const candidate = (base + '-' + randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 32);
    if (!usersTable.findByLogin(candidate)) return candidate;
  }
  return (base + '-' + Date.now().toString(36)).slice(0, 32);
}

function findOrCreateUser(claims) {
  const cfg = getSsoConfig();
  const role = claims.role === 'admin' ? 'admin' : cfg.defaultRole;
  const existing = (claims.phone && usersTable.findByPhone(claims.phone))
    || usersTable.findByEmail(claims.email)
    || usersTable.findByLogin(claims.email);
  if (existing) {
    if (existing.status === 'disabled') throw new Error('account disabled');
    if (claims.department || claims.name || claims.phone) {
      usersTable.updateOrg(existing.id, {
        department: claims.department || existing.department,
        source: existing.source || 'sso',
        displayName: claims.name || existing.display_name,
        phone: claims.phone || existing.phone
      });
    }
    if (role === 'admin' && existing.role !== 'admin') {
      usersTable.updateRole(existing.id, 'admin');
    }
    return usersTable.findById(existing.id);
  }
  if (!cfg.autoProvision) throw new Error('account not provisioned');
  return createUserByAdmin({
    username: uniqueUsername(claims.email),
    email: claims.email,
    phone: claims.phone || null,
    password: randomToken(24),
    role,
    department: claims.department || null,
    source: 'sso',
    displayName: claims.name || null
  });
}

async function handleConfig(req, res) {
  res.setHeader('cache-control', 'no-store');
  sendJson(res, 200, ssoPublicConfig());
}

async function handleStart(req, res, url) {
  const cfg = getSsoConfig();
  if (!cfg.enabled) return sendJson(res, 404, { error: 'sso disabled' });
  let discovery;
  try {
    discovery = await getDiscovery();
  } catch (err) {
    logger.warn('auth.sso.discovery_failed', { error: String(err.message || err).slice(0, 160) });
    return sendJson(res, 502, { error: 'sso discovery failed' });
  }
  cleanupStates();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const pkce = cfg.pkce ? pkcePair() : { verifier: null, challenge: null };
  const redirectUri = buildRedirectUri(req);
  const redirectTo = safeRedirect(url.searchParams.get('redirect'));
  states.set(state, {
    nonce,
    verifier: pkce.verifier,
    redirectUri,
    redirectTo,
    expiresAt: Date.now() + STATE_TTL_MS
  });
  setSsoStateCookie(res, state);
  const authorizeUrl = new URL(discovery.authorization_endpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('grant_type', 'authorization_code');
  authorizeUrl.searchParams.set('client_id', cfg.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  if (cfg.scopes) authorizeUrl.searchParams.set('scope', cfg.scopes);
  authorizeUrl.searchParams.set('state', state);
  if (cfg.mode !== 'oauth2') authorizeUrl.searchParams.set('nonce', nonce);
  if (pkce.challenge) {
    authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  }
  redirect(res, authorizeUrl.toString());
}

async function handleCallback(req, res, url) {
  const cfg = getSsoConfig();
  if (!cfg.enabled) return fail(res, 'sso_disabled', '');
  const queryState = String(url.searchParams.get('state') || '');
  const cookieState = String(parseCookies(req).sso_state || '');
  const state = queryState || cookieState;
  const code = String(url.searchParams.get('code') || '');
  clearSsoStateCookie(res);
  const stored = states.get(state);
  states.delete(state);
  if (!stored || stored.expiresAt <= Date.now()) {
    return fail(res, 'state_expired', `query=${queryState ? 'y' : 'n'} cookie=${cookieState ? 'y' : 'n'}`);
  }
  if (!code) return fail(res, 'missing_code', '');
  try {
    const tokens = await exchangeCode({
      code,
      codeVerifier: stored.verifier,
      redirectUri: stored.redirectUri
    });
    let claims;
    if (cfg.mode === 'oauth2') {
      const info = await fetchUserinfo(tokens.access_token);
      claims = claimsFromUserinfo(info);
    } else {
      claims = await verifyIdToken(tokens.id_token, { nonce: stored.nonce });
    }
    if (!emailAllowed(claims.email)) return fail(res, 'domain_not_allowed', claims.email);
    const user = findOrCreateUser(claims);
    const { sessionId } = createSession({
      userId: user.id,
      ua: userAgent(req),
      ip: clientIp(req)
    });
    setSessionCookie(res, sessionId);
    logger.info('auth.sso.login', { userId: user.id, provider: cfg.mode });
    redirect(res, stored.redirectTo || '/');
  } catch (err) {
    return fail(res, 'sso_failed', err.message || err);
  }
}

export async function handleSsoRoute(req, res, pathname, url) {
  if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
  if (pathname === '/api/auth/sso/config') return handleConfig(req, res);
  if (pathname === '/api/auth/sso/start') return handleStart(req, res, url);
  if (pathname === '/api/auth/sso/callback') return handleCallback(req, res, url);
  return sendJson(res, 404, { error: 'not found' });
}
