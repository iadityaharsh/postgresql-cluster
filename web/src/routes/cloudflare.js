const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { spawn } = require('child_process');

module.exports = function createCloudflareRouter(ctx) {
  const router = express.Router();
  const { nodes, conf, PORT, VIP, PG_PORT, PG_PASS, CLUSTER_NAME, findScript, updateConfKeys } = ctx;

  let cachedAccountId = '';

  function getCfToken() {
    return process.env.CLOUDFLARE_API_TOKEN || conf.CLOUDFLARE_API_TOKEN || '';
  }

  function fetchAccountId(token) {
    return new Promise((resolve) => {
      const req = https.get('https://api.cloudflare.com/client/v4/accounts?per_page=1', {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000
      }, (resp) => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => {
          try { const data = JSON.parse(body); if (data.success && data.result?.length > 0) resolve(data.result[0].id); else resolve(null); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async function getAccountId() {
    const explicit = process.env.CLOUDFLARE_ACCOUNT_ID || conf.CLOUDFLARE_ACCOUNT_ID || '';
    if (explicit) return explicit;
    if (cachedAccountId) return cachedAccountId;
    const token = getCfToken();
    if (!token) return '';
    const id = await fetchAccountId(token);
    if (id) { cachedAccountId = id; try { updateConfKeys({ CLOUDFLARE_ACCOUNT_ID: id }); } catch {} }
    return id || '';
  }

  async function cfApiRequest(method, apiPath, body) {
    const token = getCfToken();
    const accountId = await getAccountId();
    if (!token || !accountId) return { error: 'Cloudflare API credentials not configured' };
    const fullPath = `/client/v4/accounts/${accountId}${apiPath}`;
    const postData = body ? JSON.stringify(body) : null;
    return new Promise((resolve) => {
      const opts = {
        hostname: 'api.cloudflare.com', port: 443, path: fullPath, method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000
      };
      if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);
      const req = https.request(opts, (resp) => {
        let data = '';
        resp.on('data', d => data += d);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ success: false, error: 'Invalid API response' }); } });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'API timeout' }); });
      if (postData) req.write(postData);
      req.end();
    });
  }

  function getClusterTunnelId() {
    const token = conf.TUNNEL_TOKEN || '';
    if (!token) return null;
    try { return JSON.parse(Buffer.from(token, 'base64').toString('utf8')).t || null; } catch { return null; }
  }

  // ── Tunnel endpoints ──

  router.get('/tunnel/local', (req, res) => {
    const result = { installed: false, version: null, running: false };
    try {
      const ver = require('child_process').execSync('cloudflared --version 2>&1').toString().trim();
      result.installed = true;
      result.version = ver.match(/cloudflared version ([\d.]+)/)?.[1] || ver;
    } catch {}
    try { result.running = require('child_process').execSync('sudo systemctl is-active cloudflared 2>/dev/null').toString().trim() === 'active'; } catch {}
    res.json(result);
  });

  router.get('/tunnel', async (req, res) => {
    const results = await Promise.all(
      nodes.map(async node => {
        const data = await ctx.fetchJSON(`http://${node.ip}:${PORT}/api/tunnel/local`);
        return { name: node.name, ip: node.ip, installed: data?.installed || false, version: data?.version || null, running: data?.running || false };
      })
    );
    res.json({ nodes: results, configured: !!getClusterTunnelId() });
  });

  // Tunnel create, setup, apply, routes, status — kept as delegated from server.js
  // These are complex and share state; the router mounts them under /api/

  let tunnelTask = { running: false, log: [], exitCode: null, startTime: null };

  async function deployTunnelToNodes(token, task) {
    const scriptPath = findScript('setup-tunnel.sh');
    if (!scriptPath) { task.log.push(`[${new Date().toLocaleTimeString()}] ERROR: setup-tunnel.sh not found`); return false; }
    task.log.push(`[${new Date().toLocaleTimeString()}] --- This node ---`);
    const localOk = await new Promise((resolve) => {
      const child = spawn('sudo', ['bash', scriptPath, token], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TUNNEL_TOKEN: token } });
      child.stdout.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { task.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
      child.stderr.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { task.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
    if (!localOk) task.log.push(`[${new Date().toLocaleTimeString()}] WARNING: local setup failed`);

    const myIps = new Set();
    Object.values(os.networkInterfaces()).forEach(ifaces => ifaces.forEach(i => { if (i.family === 'IPv4') myIps.add(i.address); }));
    for (const node of nodes.filter(n => !myIps.has(n.ip))) {
      task.log.push(`[${new Date().toLocaleTimeString()}] --- ${node.name} (${node.ip}) ---`);
      await new Promise((resolve) => {
        const postData = JSON.stringify({ token });
        const r = http.request({ hostname: node.ip, port: PORT, path: '/api/tunnel/apply', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'X-Internal-Token': conf.INTERNAL_SECRET || '' }, timeout: 120000 }, (resp) => {
          let body = '';
          resp.on('data', d => body += d);
          resp.on('end', () => { task.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: ${body.trim() || 'OK'}`); resolve(); });
        });
        r.on('error', (e) => { task.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: ${e.message}`); resolve(); });
        r.on('timeout', () => { task.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: timeout`); r.destroy(); resolve(); });
        r.write(postData);
        r.end();
      });
    }
    return localOk;
  }

  router.post('/tunnel/create', async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tunnel name is required' });
    if (tunnelTask.running) return res.status(409).json({ error: 'Tunnel setup already running' });
    const token = getCfToken();
    const accountId = await getAccountId();
    if (!token || !accountId) return res.status(400).json({ error: 'Cloudflare API credentials not configured' });

    tunnelTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] Creating tunnel "${name.trim()}"...`);
    res.json({ status: 'started' });

    const tunnelSecret = require('crypto').randomBytes(32).toString('base64');
    const createResp = await cfApiRequest('POST', '/cfd_tunnel', { name: name.trim(), tunnel_secret: tunnelSecret });
    if (!createResp.success || !createResp.result?.id) {
      tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${createResp.errors?.[0]?.message || 'Failed to create tunnel'}`);
      tunnelTask.exitCode = 1; tunnelTask.running = false; return;
    }
    const tunnelId = createResp.result.id;
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] Tunnel created: ${tunnelId}`);
    const tunnelToken = Buffer.from(JSON.stringify({ a: accountId, t: tunnelId, s: tunnelSecret })).toString('base64');
    await cfApiRequest('PUT', `/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress: [{ service: 'http_status:404' }] } });
    updateConfKeys({ TUNNEL_TOKEN: tunnelToken });
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] Deploying connector to all nodes...`);
    await deployTunnelToNodes(tunnelToken, tunnelTask);
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] TASK OK — tunnel "${name.trim()}" created and deployed`);
    tunnelTask.exitCode = 0; tunnelTask.running = false;
  });

  router.post('/tunnel/setup', async (req, res) => {
    const { token } = req.body;
    if (tunnelTask.running) return res.status(409).json({ error: 'Tunnel setup already running' });
    if (!token || token.length < 20) return res.status(400).json({ error: 'Valid tunnel token is required' });
    updateConfKeys({ TUNNEL_TOKEN: token });
    const scriptPath = findScript('setup-tunnel.sh');
    if (!scriptPath) return res.status(404).json({ error: 'setup-tunnel.sh not found' });

    tunnelTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    res.json({ status: 'started' });
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] Setting up Cloudflare Tunnel on all nodes...`);
    const ok = await deployTunnelToNodes(token, tunnelTask);
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ${ok ? 'TASK OK' : 'TASK ERROR'}`);
    tunnelTask.exitCode = ok ? 0 : 1; tunnelTask.running = false;
  });

  router.post('/tunnel/apply', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const scriptPath = findScript('setup-tunnel.sh');
    if (!scriptPath) return res.status(404).json({ error: 'setup-tunnel.sh not found' });
    const child = spawn('sudo', ['bash', scriptPath, token], { stdio: 'ignore', detached: true, env: { ...process.env, TUNNEL_TOKEN: token } });
    child.unref();
    res.json({ message: 'Tunnel connector setup started' });
  });

  router.get('/tunnel/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: tunnelTask.running, exitCode: tunnelTask.exitCode, startTime: tunnelTask.startTime, log: tunnelTask.log.slice(since), totalLines: tunnelTask.log.length });
  });

  // ── Tunnel routes management ──
  router.get('/tunnel/routes', async (req, res) => {
    const tunnelId = getClusterTunnelId();
    if (!tunnelId) return res.json({ available: false, error: 'No tunnel configured.', tunnels: [] });
    const tunnelResp = await cfApiRequest('GET', `/cfd_tunnel/${tunnelId}`);
    if (tunnelResp.error || !tunnelResp.success) return res.json({ available: false, error: tunnelResp.error || tunnelResp.errors?.[0]?.message || 'Failed', tunnels: [] });
    const t = tunnelResp.result;
    const tunnel = { id: t.id, name: t.name, status: t.status, created: t.created_at, connectors: (t.connections || []).length };
    const cfgResp = await cfApiRequest('GET', `/cfd_tunnel/${tunnel.id}/configurations`);
    if (cfgResp.success && cfgResp.result?.config?.ingress) {
      tunnel.routes = cfgResp.result.config.ingress.filter(r => r.hostname).map(r => ({ hostname: r.hostname, service: r.service, path: r.path || '', originRequest: r.originRequest || {} }));
      tunnel.catch_all = cfgResp.result.config.ingress.find(r => !r.hostname)?.service || 'http_status:404';
    } else { tunnel.routes = []; tunnel.catch_all = 'http_status:404'; }
    res.json({ available: true, tunnels: [tunnel] });
  });

  router.post('/tunnel/routes', async (req, res) => {
    const { tunnel_id, hostname, service, path: routePath, originRequest } = req.body;
    if (!tunnel_id || !hostname || !service) return res.status(400).json({ error: 'tunnel_id, hostname, and service are required' });
    const cfgResp = await cfApiRequest('GET', `/cfd_tunnel/${tunnel_id}/configurations`);
    if (!cfgResp.success) return res.status(500).json({ error: cfgResp.errors?.[0]?.message || 'Failed' });
    const config = cfgResp.result?.config || { ingress: [{ service: 'http_status:404' }] };
    const ingress = config.ingress || [{ service: 'http_status:404' }];
    if (ingress.some(r => r.hostname === hostname)) return res.status(409).json({ error: `Route for ${hostname} already exists.` });
    const newRule = { hostname, service };
    if (routePath) newRule.path = routePath;
    if (originRequest && Object.keys(originRequest).length > 0) newRule.originRequest = originRequest;
    ingress.splice(ingress.length - 1, 0, newRule);
    const updateResp = await cfApiRequest('PUT', `/cfd_tunnel/${tunnel_id}/configurations`, { config: { ...config, ingress } });
    if (updateResp.success) res.json({ message: `Route ${hostname} → ${service} added` });
    else res.status(500).json({ error: updateResp.errors?.[0]?.message || 'Failed' });
  });

  router.put('/tunnel/routes/:hostname', async (req, res) => {
    const { tunnel_id, service, path: routePath, originRequest } = req.body;
    const targetHostname = decodeURIComponent(req.params.hostname);
    if (!tunnel_id || !service) return res.status(400).json({ error: 'tunnel_id and service are required' });
    const cfgResp = await cfApiRequest('GET', `/cfd_tunnel/${tunnel_id}/configurations`);
    if (!cfgResp.success) return res.status(500).json({ error: cfgResp.errors?.[0]?.message || 'Failed' });
    const config = cfgResp.result?.config || { ingress: [{ service: 'http_status:404' }] };
    const ingress = config.ingress || [];
    const idx = ingress.findIndex(r => r.hostname === targetHostname);
    if (idx === -1) return res.status(404).json({ error: `Route ${targetHostname} not found` });
    ingress[idx] = { hostname: targetHostname, service };
    if (routePath) ingress[idx].path = routePath;
    if (originRequest && Object.keys(originRequest).length > 0) ingress[idx].originRequest = originRequest;
    const updateResp = await cfApiRequest('PUT', `/cfd_tunnel/${tunnel_id}/configurations`, { config: { ...config, ingress } });
    if (updateResp.success) res.json({ message: `Route ${targetHostname} updated` });
    else res.status(500).json({ error: updateResp.errors?.[0]?.message || 'Failed' });
  });

  router.delete('/tunnel/routes/:hostname', async (req, res) => {
    const { tunnel_id } = req.body;
    const targetHostname = decodeURIComponent(req.params.hostname);
    if (!tunnel_id) return res.status(400).json({ error: 'tunnel_id is required' });
    const cfgResp = await cfApiRequest('GET', `/cfd_tunnel/${tunnel_id}/configurations`);
    if (!cfgResp.success) return res.status(500).json({ error: cfgResp.errors?.[0]?.message || 'Failed' });
    const config = cfgResp.result?.config || { ingress: [{ service: 'http_status:404' }] };
    const ingress = config.ingress || [];
    const filtered = ingress.filter(r => r.hostname !== targetHostname);
    if (filtered.length === ingress.length) return res.status(404).json({ error: `Route ${targetHostname} not found` });
    if (!filtered.some(r => !r.hostname)) filtered.push({ service: 'http_status:404' });
    const updateResp = await cfApiRequest('PUT', `/cfd_tunnel/${tunnel_id}/configurations`, { config: { ...config, ingress: filtered } });
    if (updateResp.success) res.json({ message: `Route ${targetHostname} deleted` });
    else res.status(500).json({ error: updateResp.errors?.[0]?.message || 'Failed' });
  });

  // ── Cloudflare Auth ──
  router.get('/cloudflare-auth', async (req, res) => {
    const token = getCfToken();
    const accountId = await getAccountId();
    if (!token || !accountId) return res.json({ available: false });
    let accountName = '';
    try { const resp = await cfApiRequest('GET', ''); if (resp.success && resp.result) accountName = resp.result.name || ''; } catch {}
    res.json({ available: true, account_name: accountName, account_id: accountId });
  });

  router.post('/cloudflare-auth', (req, res) => {
    const { account_id, api_token } = req.body;
    if (!account_id || !api_token) return res.status(400).json({ error: 'account_id and api_token are required' });
    try {
      updateConfKeys({ CLOUDFLARE_ACCOUNT_ID: account_id, CLOUDFLARE_API_TOKEN: api_token });
      process.env.CLOUDFLARE_ACCOUNT_ID = account_id;
      process.env.CLOUDFLARE_API_TOKEN = api_token;
      cachedAccountId = account_id;
      res.json({ message: 'Credentials saved' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/cloudflare-auth', (req, res) => {
    try {
      updateConfKeys({ CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', TUNNEL_TOKEN: '' });
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_API_TOKEN;
      cachedAccountId = '';
      res.json({ message: 'All Cloudflare credentials and configs cleared' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Hyperdrive ──
  const HYPERDRIVE_JSON = (() => {
    const candidates = [path.resolve(__dirname, '..', '..', 'hyperdrive.json'), path.resolve(__dirname, '..', '..', '..', 'hyperdrive.json')];
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
  })();

  function readHyperdriveConfigs() {
    try { if (fs.existsSync(HYPERDRIVE_JSON)) return JSON.parse(fs.readFileSync(HYPERDRIVE_JSON, 'utf8')); } catch {}
    return {};
  }
  function writeHyperdriveConfigs(configs) { fs.writeFileSync(HYPERDRIVE_JSON, JSON.stringify(configs, null, 2)); }

  async function fetchCloudflareHyperdrives() {
    const token = getCfToken();
    const accountId = await getAccountId();
    if (!token || !accountId) return null;
    const resp = await cfApiRequest('GET', '/hyperdrive/configs');
    return resp.success ? (resp.result || []) : null;
  }

  router.get('/hyperdrive', async (req, res) => {
    let configs = readHyperdriveConfigs();
    let databases = [];
    try {
      const pool = new Pool({ host: VIP || nodes[0].ip, port: parseInt(PG_PORT), user: 'postgres', password: PG_PASS, database: 'postgres', connectionTimeoutMillis: 3000, query_timeout: 5000 });
      const result = await pool.query(`SELECT datname FROM pg_database WHERE datname NOT IN ('template0', 'template1') ORDER BY datname`);
      databases = result.rows.map(r => r.datname);
      await pool.end().catch(() => {});
    } catch {}

    let cfApiAvailable = false, cfAccountName = '';
    const remoteConfigs = await fetchCloudflareHyperdrives();
    if (remoteConfigs) {
      cfApiAvailable = true;
      const accountResp = await cfApiRequest('GET', '');
      if (accountResp.success && accountResp.result) cfAccountName = accountResp.result.name || '';
      let changed = false;
      for (const hd of remoteConfigs) {
        const origin = hd.origin || {};
        const dbName = origin.database;
        if (!dbName) continue;
        if (Object.values(configs).find(c => c.hyperdrive_id === hd.id)) continue;
        const existingByDB = Object.values(configs).find(c => c.database === dbName);
        if (existingByDB) { if (!existingByDB.hyperdrive_id && hd.id) { existingByDB.hyperdrive_id = hd.id; changed = true; } continue; }
        configs[`${dbName}-${origin.user || 'unknown'}`] = { hyperdrive_id: hd.id, hyperdrive_name: hd.name || '', database: dbName, username: origin.user || '', hostname: origin.host || '', access_client_id: '', created: hd.created_on || new Date().toISOString(), source: 'cloudflare-api' };
        changed = true;
      }
      if (changed) writeHyperdriveConfigs(configs);
    }

    let wranglerInstalled = false;
    try { require('child_process').execSync('command -v wrangler >/dev/null 2>&1 || command -v npx >/dev/null 2>&1', { timeout: 2000 }); wranglerInstalled = true; } catch {}

    const entries = databases.map(db => { const cfg = Object.values(configs).find(c => c.database === db); return { database: db, configured: !!cfg, config: cfg || null }; });
    Object.values(configs).forEach(cfg => { if (!databases.includes(cfg.database)) entries.push({ database: cfg.database, configured: true, config: cfg, missing: !databases.length }); });
    const postgresHyperdrive = (conf.POSTGRES_HYPERDRIVE || '').toUpperCase() === 'ON';
    res.json({ entries, wrangler_installed: wranglerInstalled, cf_api_available: cfApiAvailable, cf_account_name: cfAccountName, postgres_hyperdrive: postgresHyperdrive });
  });

  // Legacy aliases
  router.post('/hyperdrive/cloudflare-auth', (req, res) => { req.url = '/cloudflare-auth'; router.handle(req, res); });
  router.delete('/hyperdrive/cloudflare-auth', (req, res) => { req.url = '/cloudflare-auth'; router.handle(req, res); });

  router.post('/hyperdrive/create-user', async (req, res) => {
    const { database, username, password } = req.body;
    if (!database || !username || !password) return res.status(400).json({ error: 'database, username, and password are required' });
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(username)) return res.status(400).json({ error: 'Invalid username format' });
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) return res.status(400).json({ error: 'Invalid database name format' });
    const pool = new Pool({ host: VIP || nodes[0].ip, port: parseInt(PG_PORT), user: 'postgres', password: PG_PASS, database: 'postgres', connectionTimeoutMillis: 5000 });
    try {
      const client = await pool.connect();
      try {
        const safeUser = client.escapeIdentifier(username);
        const safeDb = client.escapeIdentifier(database);
        const safePw = client.escapeLiteral(password);
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [username]);
        if (exists.rows.length > 0) {
          await client.query(`ALTER USER ${safeUser} WITH PASSWORD ${safePw}`);
        } else {
          await client.query(`CREATE USER ${safeUser} WITH PASSWORD ${safePw}`);
        }
        await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${safeDb} TO ${safeUser}`);
      } finally {
        client.release();
      }

      const dbPool = new Pool({ host: VIP || nodes[0].ip, port: parseInt(PG_PORT), user: 'postgres', password: PG_PASS, database, connectionTimeoutMillis: 5000 });
      const dbClient = await dbPool.connect();
      try {
        const safeUser = dbClient.escapeIdentifier(username);
        await dbClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${safeUser}`);
        await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${safeUser}`);
      } finally {
        dbClient.release();
        await dbPool.end().catch(() => {});
      }
      res.json({ message: `User ${username} configured with access to ${database}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await pool.end().catch(() => {}); }
  });

  let hyperdriveTask = { running: false, log: [], exitCode: null, startTime: null };

  router.post('/hyperdrive', async (req, res) => {
    const { database, username, password, hostname, hyperdrive_name, access_client_id, access_client_secret } = req.body;
    if (!database || !username || !password || !hostname || !access_client_id || !access_client_secret) return res.status(400).json({ error: 'All fields required' });
    if (hyperdriveTask.running) return res.status(409).json({ error: 'Already running' });
    const hdName = hyperdrive_name || `${CLUSTER_NAME}-${database}`;
    hyperdriveTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    const ts = () => `[${new Date().toLocaleTimeString()}]`;
    hyperdriveTask.log.push(`${ts()} Creating Hyperdrive config "${hdName}"...`);
    res.json({ status: 'started' });
    try {
      const origin = { scheme: 'postgres', host: hostname, database, user: username, password };
      if (access_client_id && access_client_secret) { origin.access_client_id = access_client_id; origin.access_client_secret = access_client_secret; }
      else { origin.port = 5432; }
      const result = await cfApiRequest('POST', '/hyperdrive/configs', { name: hdName, origin });
      if (result.success && result.result) {
        const configs = readHyperdriveConfigs();
        configs[`${database}-${username}`] = { hyperdrive_id: result.result.id, hyperdrive_name: hdName, database, username, hostname, access_client_id, created: new Date().toISOString() };
        writeHyperdriveConfigs(configs);
        hyperdriveTask.log.push(`${ts()} Hyperdrive ID: ${result.result.id}`);
        hyperdriveTask.log.push(`${ts()} TASK OK`);
        hyperdriveTask.exitCode = 0;
      } else {
        hyperdriveTask.log.push(`${ts()} API error: ${result.errors?.[0]?.message || result.error || JSON.stringify(result)}`);
        hyperdriveTask.exitCode = 1;
      }
    } catch (err) { hyperdriveTask.log.push(`${ts()} ERROR: ${err.message}`); hyperdriveTask.exitCode = 1; }
    hyperdriveTask.running = false;
  });

  router.get('/hyperdrive/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: hyperdriveTask.running, exitCode: hyperdriveTask.exitCode, startTime: hyperdriveTask.startTime, log: hyperdriveTask.log.slice(since), totalLines: hyperdriveTask.log.length });
  });

  router.put('/hyperdrive/:key', async (req, res) => {
    const configs = readHyperdriveConfigs();
    const cfg = configs[req.params.key];
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    const { password } = req.body;
    if (!password || !cfg.hyperdrive_id) return res.status(400).json({ error: 'password and hyperdrive_id required' });
    const origin = { scheme: 'postgres', host: cfg.hostname, database: cfg.database, user: cfg.username, password };
    if (cfg.access_client_id) origin.access_client_id = cfg.access_client_id; else origin.port = 5432;
    const result = await cfApiRequest('PUT', `/hyperdrive/configs/${cfg.hyperdrive_id}`, { name: cfg.hyperdrive_name, origin });
    if (result.success) { configs[req.params.key].updated = new Date().toISOString(); writeHyperdriveConfigs(configs); res.json({ message: 'Password updated' }); }
    else res.status(500).json({ error: result.errors?.[0]?.message || result.error || 'Failed' });
  });

  router.delete('/hyperdrive/:key', async (req, res) => {
    const configs = readHyperdriveConfigs();
    const cfg = configs[req.params.key];
    if (!cfg) return res.status(404).json({ error: 'Config not found' });
    if (!cfg.hyperdrive_id) { delete configs[req.params.key]; writeHyperdriveConfigs(configs); return res.json({ message: 'Local config removed' }); }
    const result = await cfApiRequest('DELETE', `/hyperdrive/configs/${cfg.hyperdrive_id}`);
    delete configs[req.params.key]; writeHyperdriveConfigs(configs);
    if (result.success) res.json({ message: `Hyperdrive ${cfg.hyperdrive_name} deleted` });
    else res.json({ message: 'Local config removed', warning: result.errors?.[0]?.message || result.error || 'API delete may have failed' });
  });

  return router;
};
