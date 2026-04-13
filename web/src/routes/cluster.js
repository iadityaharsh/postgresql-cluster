const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { spawn } = require('child_process');

module.exports = function createClusterRouter(ctx) {
  const router = express.Router();
  const { nodes, conf, fetchJSON, CLUSTER_NAME, VIP, PG_PORT, PG_PASS, PORT, PATRONI_API_USER, PATRONI_API_PASS, findScript } = ctx;

  const pool = new Pool({
    host: VIP || nodes[0].ip,
    port: parseInt(PG_PORT),
    user: 'postgres',
    password: PG_PASS,
    database: 'postgres',
    connectionTimeoutMillis: 3000,
    max: 5,
    idleTimeoutMillis: 30000
  });

  // Helper: Patroni auth object
  function pAuth() {
    return PATRONI_API_USER ? { user: PATRONI_API_USER, pass: PATRONI_API_PASS } : undefined;
  }

  // GET /api/cluster — full cluster status from Patroni
  router.get('/cluster', async (req, res) => {
    try {
      let cluster = null;
      for (const node of nodes) {
        cluster = await fetchJSON(`https://${node.ip}:8008/cluster`, 3000, pAuth());
        if (cluster) break;
      }
      const nodeStatuses = await Promise.all(
        nodes.map(async node => {
          const status = await fetchJSON(`https://${node.ip}:8008/patroni`, 3000, pAuth());
          return { name: node.name, ip: node.ip, patroni: status };
        })
      );
      res.json({
        cluster_name: CLUSTER_NAME, vip: VIP, pg_port: PG_PORT,
        nodes: nodeStatuses, cluster, timestamp: Date.now()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cluster/switchover
  router.post('/cluster/switchover', async (req, res) => {
    const { target } = req.body || {};
    try {
      let cluster = null;
      for (const node of nodes) {
        cluster = await fetchJSON(`https://${node.ip}:8008/cluster`, 3000, pAuth());
        if (cluster) break;
      }
      if (!cluster || !cluster.members) {
        return res.status(503).json({ error: 'Cannot reach Patroni cluster' });
      }
      const leader = cluster.members.find(m => m.role === 'leader' || m.role === 'master');
      const targetName = target && cluster.members.find(m => m.name === target) ? target : nodes[0].name;
      if (!leader) return res.status(503).json({ error: 'No leader found in cluster' });
      if (leader.name === targetName) return res.json({ status: 'ok', message: `${targetName} is already the leader` });
      const targetMember = cluster.members.find(m => m.name === targetName);
      if (!targetMember || targetMember.state !== 'streaming') {
        return res.status(400).json({ error: `${targetName} is not healthy (state: ${targetMember?.state || 'unknown'})` });
      }
      const leaderNode = nodes.find(n => n.name === leader.name);
      if (!leaderNode) return res.status(500).json({ error: 'Leader node not found in config' });

      const postData = JSON.stringify({ leader: leader.name, candidate: targetName });
      const switchHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };
      if (PATRONI_API_USER) switchHeaders['Authorization'] = 'Basic ' + Buffer.from(`${PATRONI_API_USER}:${PATRONI_API_PASS}`).toString('base64');
      const switchRes = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: leaderNode.ip, port: 8008, path: '/switchover',
          method: 'POST', headers: switchHeaders, timeout: 15000, rejectUnauthorized: false
        }, (resp) => {
          let body = '';
          resp.on('data', d => body += d);
          resp.on('end', () => resolve({ status: resp.statusCode, body }));
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
        r.write(postData);
        r.end();
      });
      if (switchRes.status === 200 || switchRes.status === 202) {
        res.json({ status: 'ok', message: `${targetName} is now the leader` });
      } else {
        res.status(switchRes.status).json({ error: `Patroni returned ${switchRes.status}: ${switchRes.body}` });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/databases
  router.get('/databases', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT datname, pg_database_size(datname) as size_bytes, numbackends as connections
        FROM pg_stat_database WHERE datname NOT IN ('template0', 'template1') ORDER BY datname
      `);
      res.json(result.rows);
    } catch { res.json([]); }
  });

  // GET /api/replication
  router.get('/replication', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
               pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes
        FROM pg_stat_replication
      `);
      res.json(result.rows);
    } catch { res.json([]); }
  });

  // GET /api/connections
  router.get('/connections', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT state, count(*) as count FROM pg_stat_activity GROUP BY state ORDER BY count DESC
      `);
      const max = await pool.query('SHOW max_connections');
      res.json({ by_state: result.rows, max_connections: parseInt(max.rows[0].max_connections) });
    } catch { res.json({ by_state: [], max_connections: 0 }); }
  });

  // GET /api/system/local
  router.get('/system/local', (req, res) => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    res.json({
      hostname: os.hostname(), uptime_seconds: os.uptime(),
      load_avg: { '1m': os.loadavg()[0], '5m': os.loadavg()[1], '15m': os.loadavg()[2] },
      cpu_count: cpus.length,
      memory: { total_bytes: totalMem, free_bytes: freeMem, used_percent: ((1 - freeMem / totalMem) * 100).toFixed(1) }
    });
  });

  // GET /api/system
  router.get('/system', async (req, res) => {
    const results = await Promise.all(
      nodes.map(async node => {
        const data = await fetchJSON(`http://${node.ip}:${PORT}/api/system/local`);
        return { name: node.name, ip: node.ip, ...(data || { hostname: node.name, error: true }) };
      })
    );
    res.json(results);
  });

  // GET /api/config
  router.get('/config', (req, res) => {
    res.json({ cluster_name: CLUSTER_NAME, node_count: nodes.length, pg_port: PG_PORT, vip: VIP, monitor_port: PORT, nodes });
  });

  // GET /api/config/export
  router.get('/config/export', (req, res) => {
    const confPath = ctx.confPath;
    if (!fs.existsSync(confPath)) return res.status(404).json({ error: 'cluster.conf not found' });
    const content = fs.readFileSync(confPath, 'utf8');
    const redacted = content.replace(/^(PG_REPL_PASS|PG_ADMIN_PASS|PG_SUPERUSER_PASS|PG_REPLICATOR_PASS|SMB_PASS|BORG_PASSPHRASE|PATRONI_API_PASS|CLOUDFLARE_API_TOKEN|TUNNEL_TOKEN)="[^"]*"/gm, '$1="***REDACTED***"');
    let output = redacted;
    const auth = require('../middleware/auth');
    if (auth.AUTH_PATH && fs.existsSync(auth.AUTH_PATH)) {
      const authData = auth.loadAuth();
      if (authData) {
        output += '\n\n# ================================================================\n';
        output += '# Dashboard Authentication (auth.json)\n';
        output += '# Password is hashed — not recoverable from this backup.\n';
        output += '# ================================================================\n';
        output += `# AUTH_JSON=${JSON.stringify(authData)}\n`;
      }
    }
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="cluster-${CLUSTER_NAME}-${new Date().toISOString().slice(0,10)}.conf"`);
    res.send(output);
  });

  // GET /api/config/patroni
  router.get('/config/patroni', async (req, res) => {
    const configs = {};
    const pOpts = { timeout: 5000, rejectUnauthorized: false };
    if (PATRONI_API_USER) pOpts.headers = { 'Authorization': 'Basic ' + Buffer.from(`${PATRONI_API_USER}:${PATRONI_API_PASS}`).toString('base64') };
    for (const node of nodes) {
      try {
        const resp = await new Promise((resolve, reject) => {
          const r = https.get(`https://${node.ip}:8008/config`, pOpts, resolve);
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
        });
        let body = '';
        resp.on('data', d => body += d);
        await new Promise((resolve, reject) => { resp.on('end', resolve); setTimeout(() => reject(new Error('timeout')), 5000); });
        configs[node.name] = JSON.parse(body);
      } catch { configs[node.name] = { error: 'unreachable' }; }
    }
    res.json(configs);
  });

  // Restart endpoints
  router.post('/restart/local', (req, res) => {
    const services = ['etcd', 'patroni', 'vip-manager', 'cloudflared'];
    const results = [];
    for (const svc of services) {
      try {
        require('child_process').execSync(`sudo systemctl is-enabled ${svc} 2>/dev/null`, { timeout: 3000 });
        require('child_process').execSync(`sudo systemctl restart ${svc}`, { timeout: 30000 });
        results.push({ service: svc, status: 'restarted' });
      } catch { results.push({ service: svc, status: 'skipped' }); }
    }
    res.json({ results });
  });

  let restartTask = { running: false, log: [], done: false };
  router.post('/restart', async (req, res) => {
    if (restartTask.running) return res.status(409).json({ error: 'Restart already in progress' });
    restartTask = { running: true, log: [], done: false };
    res.json({ message: 'Restart initiated' });

    for (const node of nodes) {
      restartTask.log.push(`Restarting services on ${node.name} (${node.ip})...`);
      try {
        const result = await new Promise((resolve, reject) => {
          const r = http.request(`http://${node.ip}:${PORT}/api/restart/local`, { method: 'POST', timeout: 60000, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': conf.INTERNAL_SECRET || '' } }, (resp) => {
            let body = '';
            resp.on('data', d => body += d);
            resp.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ results: [] }); } });
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          r.end();
        });
        const restarted = (result.results || []).filter(s => s.status === 'restarted').map(s => s.service);
        const skipped = (result.results || []).filter(s => s.status === 'skipped').map(s => s.service);
        if (restarted.length) restartTask.log.push(`  Restarted: ${restarted.join(', ')}`);
        if (skipped.length) restartTask.log.push(`  Skipped: ${skipped.join(', ')}`);
      } catch (err) { restartTask.log.push(`  Failed: ${err.message}`); }
    }

    // Restart pg-monitor on remote nodes
    const localIps = new Set();
    try { Object.values(os.networkInterfaces()).forEach(ifaces => ifaces.forEach(i => localIps.add(i.address))); } catch {}
    for (const node of nodes) {
      if (localIps.has(node.ip)) continue;
      restartTask.log.push(`Restarting pg-monitor on ${node.name}...`);
      try {
        await new Promise((resolve, reject) => {
          const r = http.request(`http://${node.ip}:${PORT}/api/restart/monitor`, { method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': conf.INTERNAL_SECRET || '' } }, (resp) => {
            let body = '';
            resp.on('data', d => body += d);
            resp.on('end', () => resolve(body));
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          r.end();
        });
        restartTask.log.push(`  Done`);
      } catch (err) { restartTask.log.push(`  Failed: ${err.message}`); }
    }

    restartTask.log.push('Restarting local pg-monitor...');
    restartTask.running = false;
    restartTask.done = true;
    setTimeout(() => {
      spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref();
    }, 1500);
  });

  router.post('/restart/monitor', (req, res) => {
    res.json({ message: 'Restarting pg-monitor' });
    setTimeout(() => {
      spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref();
    }, 500);
  });

  router.get('/restart/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: restartTask.running, done: restartTask.done, log: restartTask.log.slice(since), totalLines: restartTask.log.length });
  });

  router._pool = pool;

  return router;
};
