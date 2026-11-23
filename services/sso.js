// 单点登录（OIDC Authorization Code + PKCE）最小实现，零第三方依赖。
// 配置全部来自环境变量，未配置时 SSO 关闭，不影响本地账号登录。

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';

const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;

let discoveryCache = { at: 0, issuer: '', data: null };
let jwksCache = { at: 0, uri: '', keys: [] };

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : String(value).trim();
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

export function getSsoConfig() {
  const issuer = env('SSO_ISSUER').replace(/\/+$/, '');
  const allowedDomains = env('SSO_ALLOWED_DOMAINS')
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return {
    enabled: envFlag('SSO_ENABLED') && Boolean(issuer && env('SSO_CLIENT_ID')),
    issuer,
    clientId: env('SSO_CLIENT_ID'),
    clientSecret: env('SSO_CLIENT_SECRET'),
    scopes: env('SSO_SCOPES', 'openid profile email'),
    redirectUri: env('SSO_REDIRECT_URI'),
    allowedDomains,
    autoProvision: envFlag('SSO_AUTO_PROVISION', true),
    defaultRole: env('SSO_DEFAULT_ROLE', 'user') === 'admin' ? 'admin' : 'user',
    buttonLabel: env('SSO_BUTTON_LABEL', '使用公司账号登录'),
    tokenAuth: env('SSO_TOKEN_AUTH', 'post') === 'basic' ? 'basic' : 'post'
  };
}

export function ssoPublicConfig() {
  const cfg = getSsoConfig();
  return {
    enabled: cfg.enabled,
    label: cfg.buttonLabel,
    loginUrl: '/api/auth/sso/start'
  };
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildRedirectUri(req) {
  const cfg = getSsoConfig();
  if (cfg.redirectUri) return cfg.redirectUri;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}/api/auth/sso/callback`;
}

async function fetchJson(url, timeoutMs = 10_000) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SSO endpoint ${url} returned HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`SSO endpoint ${url} returned invalid JSON`);
  }
}

export async function getDiscovery() {
  const cfg = getSsoConfig();
  if (!cfg.enabled) throw new Error('SSO is not enabled');
  if (
    discoveryCache.data &&
    discoveryCache.issuer === cfg.issuer &&
    Date.now() - discoveryCache.at < DISCOVERY_TTL_MS
  ) {
    return discoveryCache.data;
  }
  const data = await fetchJson(cfg.issuer + '/.well-known/openid-configuration');
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error('SSO discovery document is missing required endpoints');
  }
  discoveryCache = { at: Date.now(), issuer: cfg.issuer, data };
  return data;
}

async function getJwks() {
  const discovery = await getDiscovery();
  const uri = discovery.jwks_uri;
  if (!uri) throw new Error('SSO discovery document is missing jwks_uri');
  if (jwksCache.uri === uri && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const data = await fetchJson(uri);
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { at: Date.now(), uri, keys };
  return keys;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function audienceMatches(aud, clientId) {
  if (Array.isArray(aud)) return aud.includes(clientId);
  return aud === clientId;
}

export async function verifyIdToken(idToken, { nonce } = {}) {
  const cfg = getSsoConfig();
  const discovery = await getDiscovery();
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('invalid id_token');
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (header.alg !== 'RS256') throw new Error('unsupported id_token alg');
  const keys = await getJwks();
  const jwk = keys.find((key) => key.kid === header.kid) || keys.find((key) => key.kty === 'RSA');
  if (!jwk) throw new Error('no matching JWKS key');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verifySignature(
    'RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    publicKey,
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw new Error('invalid id_token signature');
  if (payload.iss !== discovery.issuer) throw new Error('invalid id_token issuer');
  if (!audienceMatches(payload.aud, cfg.clientId)) throw new Error('invalid id_token audience');
  if (!payload.exp || Number(payload.exp) * 1000 <= Date.now()) throw new Error('id_token expired');
  if (nonce && payload.nonce !== nonce) throw new Error('invalid id_token nonce');
  const email = String(payload.email || payload.preferred_username || payload.upn || '').trim().toLowerCase();
  if (!email) throw new Error('id_token has no email claim');
  return {
    subject: String(payload.sub || ''),
    email,
    name: String(payload.name || payload.given_name || email.split('@')[0]),
    claims: payload
  };
}

export async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const cfg = getSsoConfig();
  const discovery = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: codeVerifier
  });
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json'
  };
  if (cfg.clientSecret) {
    if (cfg.tokenAuth === 'basic') {
      headers.authorization = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    } else {
      body.set('client_secret', cfg.clientSecret);
    }
  }
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(`SSO token exchange failed: HTTP ${res.status} ${String(data.error || '').slice(0, 80)}`);
  }
  if (!data.id_token) throw new Error('SSO token response has no id_token');
  return data;
}

export function emailAllowed(email) {
  const cfg = getSsoConfig();
  if (!cfg.allowedDomains.length) return true;
  const domain = String(email).split('@')[1] || '';
  return cfg.allowedDomains.includes(domain.toLowerCase());
}
