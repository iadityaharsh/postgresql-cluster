const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { authMiddleware, sessions, authConfig, setAuthConfig, AUTH_PATH, loadAuth, verifyPassword, hashPassword, parseCookies } = require('./middleware/auth');
const createClusterRouter = require('./routes/cluster');
const createBackupRouter = require('./routes/backup');
const createCloudflareRouter = require('./routes/cloudflare');

function createApp() {
  // Version
  function readLocalVersion() {
    const vf = [path.resolve(__dirname, '..', 'VERSION'), path.resolve(__dirname, '..', '..', 'VERSION')].find(p => fs.existsSync(p));
    return vf ? fs.readFileSync(vf, 'utf8').trim() : '0.0.0';
  }
  let LOCAL_VERSION = readLocalVersion();

  // Load cluster.conf
  const confPath = fs.existsSync(path.resolve(__dirname, '..', 'cluster.conf'))
    ? path.resolve(__dirname, '..', 'cluster.conf')
    : path.resolve(__dirname, '..', '..', 'cluster.conf');
  const conf = {};
  function reloadConf() {
    if (fs.existsSync(confPath)) {
      fs.readFileSync(confPath, 'utf8').split('\n').forEach(line => {
        const match = line.match(/^(\w+)="?([^"]*)"?$/);
        if (match) conf[match[1]] = match[2];
      });
    }
  }
  reloadConf();

  const FORBIDDEN_VALUE_CHARS = /["\n\r$`\\]/;

  function updateConfKeys(updates) {
    let content = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid config key: ${key}`);
      }
      const strValue = String(value);
      if (FORBIDDEN_VALUE_CHARS.test(strValue)) {
        throw new Error(`Invalid value for ${key}: contains forbidden characters (", newline, $, backtick, backslash)`);
      }
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}="${strValue}"`;
      if (regex.test(content)) content = content.replace(regex, line);
      else content = content.trimEnd() + '\n' + line + '\n';
    }
    fs.writeFileSync(confPath, content);
    reloadConf();
  }

  function findScript(name) {
    const candidates = [
      path.resolve(__dirname, '..', 'scripts', name),
      path.resolve(__dirname, '..', '..', 'scripts', name),
      '/root/postgresql-cluster/scripts/' + name,
      os.homedir() + '/postgresql-cluster/scripts/' + name,
      '/opt/postgresql-cluster/scripts/' + name
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }

  const PORT = conf.MONITOR_PORT || process.env.MONITOR_PORT || 8080;
  const NODE_COUNT = parseInt(conf.NODE_COUNT) || 3;
  const PG_PORT = conf.PG_PORT || '5432';
  const PG_PASS = conf.PG_SUPERUSER_PASS || '';
  const CLUSTER_NAME = conf.CLUSTER_NAME || 'pg-cluster';
  const VIP = conf.VIP_ADDRESS || '';
  const PATRONI_API_USER = conf.PATRONI_API_USER || '';
  const PATRONI_API_PASS = conf.PATRONI_API_PASS || '';

  const nodes = [];
  for (let i = 1; i <= NODE_COUNT; i++) {
    nodes.push({ name: conf[`NODE_${i}_NAME`] || `node-${i}`, ip: conf[`NODE_${i}_IP`] || `127.0.0.${i}` });
  }

  function _fetch(url, timeout, auth) {
    const opts = { timeout, rejectUnauthorized: false };
    if (auth) opts.headers = { 'Authorization': 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') };
    const lib = url.startsWith('https') ? https : http;
    return new Promise((resolve) => {
      const req = lib.get(url, opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async function fetchJSON(url, timeout = 3000, auth) {
    const result = await _fetch(url, timeout, auth);
    if (result) return result;
    // HTTP fallback only when explicitly opted in — prevents credential leakage over cleartext
    if (url.startsWith('https://') && process.env.INSECURE_PATRONI === '1') {
      console.warn(`[WARN] HTTPS failed for ${url.split('//')[1]?.split('/')[0]}, retrying over HTTP (INSECURE_PATRONI=1)`);
      return _fetch(url.replace('https://', 'http://'), timeout, auth);
    }
    return null;
  }

  // Dashboard always serves HTTPS (server.js generates a self-signed cert if needed).
  // Use HTTPS for all node-to-node calls with rejectUnauthorized: false for self-signed certs.
  const SELF_PROTO = 'https';
  const internalLib = https;
  const internalOpts = { rejectUnauthorized: false };

  const ctx = { nodes, conf, confPath, fetchJSON, CLUSTER_NAME, VIP, PG_PORT, PG_PASS, PORT, PATRONI_API_USER, PATRONI_API_PASS, findScript, reloadConf, updateConfKeys, SELF_PROTO, internalLib, internalOpts };

  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  // Health check (no auth)
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime() });
  });

  // Sliding-window login rate limiter — max 5 failed attempts per IP per 60 seconds
  const loginFailures = new Map(); // ip -> [timestamp, ...]
  const LOGIN_WINDOW_MS = 60000;
  const LOGIN_MAX_FAILURES = 5;

  function isRateLimited(ip) {
    const now = Date.now();
    const times = (loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    loginFailures.set(ip, times);
    return times.length >= LOGIN_MAX_FAILURES;
  }

  function recordFailedLogin(ip) {
    const now = Date.now();
    const times = (loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    times.push(now);
    loginFailures.set(ip, times);
  }

  // Auth endpoints
  app.post('/api/login', async (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    const currentAuth = loadAuth();
    if (!currentAuth) return res.json({ message: 'No auth configured' });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username !== currentAuth.username) { recordFailedLogin(clientIp); return res.status(401).json({ error: 'Invalid credentials' }); }
    const valid = await verifyPassword(password, currentAuth.hash, currentAuth.salt);
    if (!valid) { recordFailedLogin(clientIp); return res.status(401).json({ error: 'Invalid credentials' }); }
    const token = require('crypto').randomBytes(32).toString('hex');
    const csrf = require('crypto').randomBytes(32).toString('hex');
    sessions.set(token, { username, created: Date.now(), csrf });
    res.setHeader('Set-Cookie', [
      `pg_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      `pg_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=86400`
    ]);
    res.json({ message: 'Logged in' });
  });

  app.post('/api/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['pg_session'];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'pg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ message: 'Logged out' });
  });

  app.get('/api/auth/status', (req, res) => {
    const currentAuth = loadAuth();
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['pg_session'];
    const loggedIn = token && sessions.has(token);
    res.json({ auth_required: !!currentAuth, logged_in: loggedIn, username: loggedIn ? sessions.get(token).username : null });
  });

  app.post('/api/auth/change-password', async (req, res) => {
    let currentAuth = loadAuth();
    if (!currentAuth) return res.status(400).json({ error: 'No auth configured' });
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
    const valid = await verifyPassword(current_password, currentAuth.hash, currentAuth.salt);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    if (new_password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
    try {
      const { hash, salt } = await hashPassword(new_password);
      currentAuth.hash = hash;
      currentAuth.salt = salt;
      fs.writeFileSync(AUTH_PATH, JSON.stringify(currentAuth, null, 2));
      setAuthConfig(currentAuth);
      sessions.clear();
      res.json({ message: 'Password changed. Please log in again.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Version endpoints
  app.get('/api/version', (req, res) => {
    LOCAL_VERSION = readLocalVersion();
    res.json({ version: LOCAL_VERSION });
  });

  function compareVersions(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  // Cache for GitHub version check — avoids hammering the API on every click
  let versionCache = { result: null, fetchedAt: 0 };
  const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  app.get('/api/version/check', async (req, res) => {
    LOCAL_VERSION = readLocalVersion();
    const nodeVersions = await Promise.all(
      nodes.map(async (node) => {
        try {
          const data = await fetchJSON(`${SELF_PROTO}://${node.ip}:${PORT}/api/version`, 3000);
          return { name: node.name, ip: node.ip, version: data?.version || 'unknown' };
        } catch { return { name: node.name, ip: node.ip, version: 'unreachable' }; }
      })
    );
    const allSameVersion = nodeVersions.every(n => n.version === LOCAL_VERSION);

    async function fetchLatestFromGitHub() {
      return new Promise((resolve) => {
        https.get('https://api.github.com/repos/iadityaharsh/postgresql-cluster/tags?per_page=30', {
          headers: { 'User-Agent': 'pg-cluster-monitor', 'Accept': 'application/vnd.github.v3+json' }, timeout: 10000
        }, (resp) => {
          let body = '';
          resp.on('data', d => body += d);
          resp.on('end', () => {
            try {
              const tags = JSON.parse(body);
              if (Array.isArray(tags) && tags.length > 0) {
                let latest = '0.0.0';
                for (const tag of tags) { const v = tag.name.replace(/^v/, ''); if (/^\d+\.\d+\.\d+$/.test(v) && compareVersions(v, latest) > 0) latest = v; }
                resolve({ latest });
              } else resolve({ latest: null, error: tags.message || 'No tags found' });
            } catch (e) { resolve({ latest: null, error: e.message }); }
          });
        }).on('error', (err) => resolve({ latest: null, error: err.message }));
      });
    }

    let result;
    const now = Date.now();
    if (versionCache.result && (now - versionCache.fetchedAt) < VERSION_CACHE_TTL) {
      result = versionCache.result;
    } else {
      result = await fetchLatestFromGitHub();
      if (!result.latest) {
        // One retry after 2 seconds
        await new Promise(r => setTimeout(r, 2000));
        const retry = await fetchLatestFromGitHub();
        if (retry.latest) result = retry;
      }
      if (result.latest) {
        versionCache = { result, fetchedAt: now };
      }
    }
    res.json({ current: LOCAL_VERSION, latest: result.latest, update_available: result.latest ? compareVersions(result.latest, LOCAL_VERSION) > 0 : false, nodes: nodeVersions, all_nodes_match: allSameVersion, error: result.error || undefined });
  });

  // Task state persistence — survives server restarts (e.g. after upgrade)
  const TASK_DIR = '/var/run/pg-monitor-tasks';

  function saveTask(name, state) {
    try {
      fs.mkdirSync(TASK_DIR, { recursive: true });
      fs.writeFileSync(path.join(TASK_DIR, `${name}.json`), JSON.stringify({ ...state, log: state.log.slice(-500) }));
    } catch {}
  }

  function loadTask(name) {
    try {
      const p = path.join(TASK_DIR, `${name}.json`);
      if (fs.existsSync(p)) {
        const t = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Mark task not-running if server restarted mid-task
        if (t.running) { t.running = false; t.log.push('[Server restarted — task result may be incomplete]'); saveTask(name, t); }
        return t;
      }
    } catch {}
    return { running: false, log: [], exitCode: null, startTime: null };
  }

  // Version upgrade endpoints
  let upgradeTask = loadTask('upgrade');

  function runLocalUpdate(task) {
    return new Promise((resolve) => {
      const repoCandidates = [path.resolve(__dirname, '..', '..'), '/root/postgresql-cluster', path.resolve(os.homedir(), 'postgresql-cluster'), '/opt/postgresql-cluster'];
      const repoDir = repoCandidates.find(d => fs.existsSync(path.join(d, 'update.sh')));
      let cmd, args;
      if (!repoDir) {
        cmd = 'sudo'; args = ['bash', '-c', 'cd /root && [ ! -d postgresql-cluster/.git ] && rm -rf postgresql-cluster; git clone https://github.com/iadityaharsh/postgresql-cluster.git 2>&1 && cd postgresql-cluster && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1'];
      } else {
        cmd = 'sudo'; args = ['bash', '-c', `cd ${repoDir} && git fetch origin --tags -f 2>&1 && git pull origin main 2>&1 && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1`];
      }
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PG_DASHBOARD_UPGRADE: '1' } });
      child.stdout.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { task.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
      child.stderr.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { task.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  app.post('/api/version/upgrade', async (req, res) => {
    if (upgradeTask.running) return res.status(409).json({ error: 'Upgrade already running' });
    upgradeTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    saveTask('upgrade', upgradeTask);
    upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] Starting cluster-wide upgrade from ${LOCAL_VERSION}...`);
    res.json({ status: 'started' });

    upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] --- Upgrading this node ---`);
    const localOk = await runLocalUpdate(upgradeTask);
    if (!localOk) { upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] TASK ERROR — local update failed`); upgradeTask.exitCode = 1; upgradeTask.running = false; return; }

    const myIpSet = new Set();
    try { Object.values(os.networkInterfaces()).forEach(ifaces => ifaces.forEach(i => { if (i.family === 'IPv4') myIpSet.add(i.address); })); } catch {}
    const otherNodes = nodes.filter(n => !myIpSet.has(n.ip));
    if (otherNodes.length > 0) {
      upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] --- Upgrading ${otherNodes.length} other node(s) ---`);
      for (const node of otherNodes) {
        upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] Upgrading ${node.ip}...`);
        await new Promise((resolve) => {
          const r = internalLib.request({ hostname: node.ip, port: PORT, path: '/api/version/upgrade/apply', method: 'POST', ...internalOpts, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': conf.INTERNAL_SECRET || '' }, timeout: 120000 }, (resp) => {
            let body = ''; resp.on('data', d => body += d);
            resp.on('end', () => { try { upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.ip}: ${JSON.parse(body).message || 'OK'}`); } catch { upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.ip}: ${body.trim() || 'OK'}`); } resolve(true); });
          });
          r.on('error', (e) => { upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.ip}: ${e.message}`); resolve(false); });
          r.on('timeout', () => { upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.ip}: timeout`); r.destroy(); resolve(false); });
          r.end();
        });
      }
    }
    upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] TASK OK — page will reload automatically.`);
    upgradeTask.exitCode = 0; upgradeTask.running = false;
    saveTask('upgrade', upgradeTask);
    // Restart local service AFTER all remote nodes have been upgraded so the task
    // state and log remain accessible until the orchestration loop completes.
    setTimeout(() => { spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref(); }, 3000);
  });

  app.post('/api/version/upgrade/apply', async (req, res) => {
    const repoCandidates = [path.resolve(__dirname, '..', '..'), '/root/postgresql-cluster', path.resolve(os.homedir(), 'postgresql-cluster'), '/opt/postgresql-cluster'];
    const repoDir = repoCandidates.find(d => fs.existsSync(path.join(d, 'update.sh')));
    if (!repoDir) return res.status(404).json({ message: 'No git repo found' });
    const child = spawn('sudo', ['bash', '-c', `cd ${repoDir} && git fetch origin --tags -f 2>&1 && git pull origin main 2>&1 && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1`], { stdio: 'ignore', detached: true, env: { ...process.env, PG_DASHBOARD_UPGRADE: '1' } });
    child.unref();
    res.json({ message: 'Upgrade started, restarting...' });
    res.on('finish', () => { setTimeout(() => { spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref(); }, 5000); });
  });

  app.get('/api/version/upgrade/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: upgradeTask.running, exitCode: upgradeTask.exitCode, startTime: upgradeTask.startTime, log: upgradeTask.log.slice(since), totalLines: upgradeTask.log.length });
  });

  // Storage endpoints
  let storageTask = loadTask('storage');

  app.get('/api/storage', (req, res) => {
    try {
      let mounted = false;
      try {
        if (fs.existsSync('/mnt/pg-backup')) mounted = require('child_process').execSync('sudo mountpoint -q /mnt/pg-backup 2>/dev/null && echo yes || echo no', { timeout: 5000 }).toString().trim() === 'yes';
      } catch {}
      res.json({ enabled: conf.ENABLE_BACKUP === 'Y' || conf.ENABLE_BACKUP === 'y', type: conf.NFS_SERVER ? 'nfs' : (conf.SMB_SHARE ? 'smb' : 'none'), nfs_server: conf.NFS_SERVER || '', nfs_path: conf.NFS_PATH || '', smb_share: conf.SMB_SHARE || '', smb_user: conf.SMB_USER || '', smb_domain: conf.SMB_DOMAIN || '', schedule: conf.BACKUP_SCHEDULE || '0 2 * * *', retention: conf.BACKUP_LOCAL_RETENTION || '7', is_lxc: false, mounted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/storage/mount', (req, res) => {
    const child = spawn('sudo', ['bash', '-c', 'mount /mnt/pg-backup 2>&1 || mount -a 2>&1'], { timeout: 15000 });
    let out = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('close', () => { try { const mounted = require('child_process').execSync('sudo mountpoint -q /mnt/pg-backup && echo yes || echo no', { timeout: 3000 }).toString().trim() === 'yes'; if (mounted) res.json({ message: 'Share mounted successfully' }); else res.status(500).json({ error: out.trim() || 'Mount failed' }); } catch { res.status(500).json({ error: out.trim() || 'Mount failed' }); } });
    child.on('error', (err) => res.status(500).json({ error: err.message }));
  });

  app.get('/api/storage/nfs-exports', (req, res) => {
    const server = req.query.server;
    if (!server || !require('net').isIPv4(server)) return res.status(400).json({ error: 'Invalid server IP' });
    const child = spawn('sudo', ['bash', '-c', `command -v showmount >/dev/null 2>&1 || apt-get install -y -qq nfs-common >/dev/null 2>&1; showmount -e ${server} --no-headers 2>&1`], { timeout: 15000 });
    let out = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('close', (code) => {
      if (code !== 0) return res.json({ exports: [], error: out.trim() || 'Failed to scan NFS exports' });
      const exports = out.trim().split('\n').filter(l => l.trim()).map(l => { const parts = l.trim().split(/\s+/); return { path: parts[0], allowed: parts.slice(1).join(' ') }; });
      res.json({ exports });
    });
  });

  app.post('/api/storage', (req, res) => {
    const { type, nfs_server, nfs_path, smb_share, smb_user, smb_pass, smb_domain, schedule, retention } = req.body;
    if (storageTask.running) return res.status(409).json({ error: 'Storage setup already running' });
    if (type === 'nfs' && (!nfs_server || !nfs_path)) return res.status(400).json({ error: 'NFS server and path are required' });
    if (type === 'smb' && !smb_share) return res.status(400).json({ error: 'SMB share path is required' });
    const updates = { ENABLE_BACKUP: type !== 'none' ? 'y' : 'n', BACKUP_SCHEDULE: schedule || '0 2 * * *', BACKUP_LOCAL_RETENTION: retention || '7', NFS_SERVER: type === 'nfs' ? nfs_server : '', NFS_PATH: type === 'nfs' ? nfs_path : '', SMB_SHARE: type === 'smb' ? smb_share : '', SMB_USER: type === 'smb' ? (smb_user || '') : '', SMB_PASS: type === 'smb' ? (smb_pass || '') : '', SMB_DOMAIN: type === 'smb' ? (smb_domain || 'WORKGROUP') : '' };
    updateConfKeys(updates);
    if (type === 'none') return res.json({ status: 'ok', message: 'Backups disabled' });
    const script = findScript('backup-setup.sh');
    if (!script) return res.status(404).json({ error: 'backup-setup.sh not found' });
    storageTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    const child = spawn('sudo', ['bash', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
    child.stderr.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
    child.on('close', (code) => { storageTask.exitCode = code; storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${code === 0 ? 'TASK OK' : 'TASK ERROR'}`); storageTask.running = false; });
    child.on('error', (err) => { storageTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`); storageTask.exitCode = 1; storageTask.running = false; });
    res.json({ status: 'started', message: 'Setting up storage' });
  });

  app.get('/api/storage/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: storageTask.running, exitCode: storageTask.exitCode, startTime: storageTask.startTime, log: storageTask.log.slice(since), totalLines: storageTask.log.length });
  });

  const STORAGE_APPLY_ALLOWED_KEYS = new Set([
    'NFS_SERVER', 'NFS_PATH', 'NFS_OPTIONS',
    'SMB_SHARE', 'SMB_USER', 'SMB_PASS', 'SMB_DOMAIN',
    'STORAGE_TYPE', 'BACKUP_SCHEDULE', 'BACKUP_RETENTION',
  ]);

  app.post('/api/storage/apply', (req, res) => {
    const updates = req.body;
    const disallowed = Object.keys(updates).filter(k => !STORAGE_APPLY_ALLOWED_KEYS.has(k));
    if (disallowed.length > 0) {
      return res.status(400).json({ error: `Keys not allowed via this endpoint: ${disallowed.join(', ')}` });
    }
    try {
      updateConfKeys(updates);
      const backupScript = findScript('backup-setup.sh');
      if (backupScript) { const child = spawn('sudo', ['bash', backupScript], { stdio: 'ignore', detached: true }); child.unref(); }
      res.json({ status: 'ok', message: 'Config applied, setup running' });
    } catch (err) {
      const isValidation = /Invalid (config key|value for)/i.test(err.message);
      res.status(isValidation ? 400 : 500).json({ error: err.message });
    }
  });

  // Mount routers
  const clusterRouter = createClusterRouter(ctx);
  ctx.pool = clusterRouter._pool;
  app.use('/api', clusterRouter);
  app.use('/api/backups', createBackupRouter(ctx));
  app.use('/api', createCloudflareRouter(ctx));

  // Log viewer API
  const { LOG_DIR } = require('./logger');
  app.get('/api/logs', (req, res) => {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('pg-monitor-') && f.endsWith('.log'))
        .sort()
        .reverse();
      res.json(files.map(f => {
        const stat = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, size: stat.size, date: f.slice(11, 21) };
      }));
    } catch { res.json([]); }
  });

  app.get('/api/logs/:file', (req, res) => {
    const file = req.params.file;
    if (!/^pg-monitor-\d{4}-\d{2}-\d{2}\.log$/.test(file)) return res.status(400).json({ error: 'Invalid log file name' });
    const filePath = path.join(LOG_DIR, file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Log file not found' });
    const lines = parseInt(req.query.lines) || 200;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());
      const tail = allLines.slice(-lines);
      res.json({ file, total: allLines.length, lines: tail });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Static files — serve from dist/ (Vite build) if available, else public/
  const distDir = path.join(__dirname, '..', 'dist');
  const publicDir = path.join(__dirname, '..', 'public');
  const staticDir = fs.existsSync(distDir) ? distDir : publicDir;
  app.use(express.static(staticDir));

  // SPA catch-all: serve index.html for any non-API, non-asset route so that
  // deep links (e.g. /cluster/node-1) don't 404 on page reload
  const indexHtml = path.join(staticDir, 'index.html');
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
    next();
  });

  // Log unhandled Express errors
  app.use((err, req, res, _next) => {
    console.error(`[${req.method} ${req.path}] ${err.stack || err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, PORT, conf };
}

module.exports = { createApp };
