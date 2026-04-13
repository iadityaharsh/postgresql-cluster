const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sessions = new Map(); // token -> { username, created }

// Load auth.json
function findAuthPath() {
  return [
    path.resolve(__dirname, '..', '..', 'auth.json'),
    path.resolve(__dirname, '..', '..', '..', 'auth.json')
  ].find(p => fs.existsSync(p)) || null;
}

const AUTH_PATH = findAuthPath();

// Resolve cluster.conf path (env override for tests, else same resolution as app.js)
function findConfPath() {
  if (process.env.PG_CLUSTER_CONF) return process.env.PG_CLUSTER_CONF;
  return [
    path.resolve(__dirname, '..', '..', 'cluster.conf'),
    path.resolve(__dirname, '..', '..', '..', 'cluster.conf')
  ].find(p => fs.existsSync(p)) || null;
}

function getInternalSecret() {
  const p = findConfPath();
  if (!p || !fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8');
  const match = content.match(/^INTERNAL_SECRET="?([^"\n]*)"?$/m);
  return match ? match[1] : null;
}

function isInternalRequest(req) {
  const token = req.headers && req.headers['x-internal-token'];
  const secret = getInternalSecret();
  if (!secret || !token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function loadAuth() {
  if (!AUTH_PATH) return null;
  try { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
  catch { return null; }
}

let authConfig = loadAuth();

function verifyPassword(password, hash, salt) {
  return new Promise((resolve) => {
    crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) return resolve(false);
      resolve(derived.toString('hex') === hash);
    });
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) return reject(err);
      resolve({ hash: derived.toString('hex'), salt });
    });
  });
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

// Paths that never require auth (browser-facing, healthchecks, version gossip).
const PUBLIC_PATHS = [
  '/healthz',
  '/api/login',
  '/api/auth/status',
  '/api/version',
  '/api/tunnel/local',
  '/api/system/local'
];

// Paths that require a valid session cookie OR a valid X-Internal-Token header.
const INTERNAL_PATHS = [
  '/api/storage/apply',
  '/api/version/upgrade/apply',
  '/api/tunnel/apply',
  '/api/tunnel/setup',
  '/api/restart/local',
  '/api/restart/monitor'
];

function pathMatches(list, p) {
  return list.some(x => p === x || p.startsWith(x + '/'));
}

function authMiddleware(req, res, next) {
  // No auth configured — allow everything (install/setup flow)
  if (!authConfig) return next();
  // Internal node-to-node paths are checked first (more specific than PUBLIC_PATHS)
  if (pathMatches(INTERNAL_PATHS, req.path)) {
    // Session cookie check
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['pg_session'];
    if (token && sessions.has(token)) return next();
    // Fall back to X-Internal-Token
    if (isInternalRequest(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Always-public paths
  if (pathMatches(PUBLIC_PATHS, req.path)) return next();
  // Static files (login page)
  if (!req.path.startsWith('/api/')) return next();
  // Session cookie check (valid for any /api/* path)
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['pg_session'];
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Clean up expired sessions every hour
setInterval(() => {
  const maxAge = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.created > maxAge) sessions.delete(token);
  }
}, 60 * 60 * 1000);

module.exports = {
  sessions,
  authConfig,
  setAuthConfig(config) { authConfig = config; },
  AUTH_PATH,
  loadAuth,
  verifyPassword,
  hashPassword,
  parseCookies,
  authMiddleware,
  getInternalSecret,
  isInternalRequest
};
