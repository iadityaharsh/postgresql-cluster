const express = require('express');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Version — read from VERSION file (written during deploy from git tag)
function readLocalVersion() {
  const vf = [
    path.resolve(__dirname, 'VERSION'),
    path.resolve(__dirname, '..', 'VERSION')
  ].find(p => fs.existsSync(p));
  return vf ? fs.readFileSync(vf, 'utf8').trim() : '0.0.0';
}
let LOCAL_VERSION = readLocalVersion();

// Load cluster.conf
const confPath = fs.existsSync(path.resolve(__dirname, 'cluster.conf'))
  ? path.resolve(__dirname, 'cluster.conf')
  : path.resolve(__dirname, '..', 'cluster.conf');
const conf = {};
if (fs.existsSync(confPath)) {
  fs.readFileSync(confPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^(\w+)="?([^"]*)"?$/);
    if (match) conf[match[1]] = match[2];
  });
}

// Helper: find a script in multiple possible locations
function findScript(name) {
  const candidates = [
    path.resolve(__dirname, 'scripts', name),           // /opt/pg-monitor/scripts/
    path.resolve(__dirname, '..', 'scripts', name),     // git repo (when run from web/)
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
const BORG_REPO = '/mnt/pg-backup/borg-repo';
const BACKUP_SCRIPT = '/opt/pg-backup/pg-backup.sh';

// Build node list
const nodes = [];
for (let i = 1; i <= NODE_COUNT; i++) {
  nodes.push({
    name: conf[`NODE_${i}_NAME`] || `node-${i}`,
    ip: conf[`NODE_${i}_IP`] || `127.0.0.${i}`
  });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fetch JSON from a URL with timeout
function fetchJSON(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// GET /api/cluster — full cluster status from Patroni
app.get('/api/cluster', async (req, res) => {
  try {
    // Try each node's Patroni API until one responds
    let cluster = null;
    for (const node of nodes) {
      cluster = await fetchJSON(`http://${node.ip}:8008/cluster`);
      if (cluster) break;
    }

    // Get individual node status from each Patroni
    const nodeStatuses = await Promise.all(
      nodes.map(async node => {
        const status = await fetchJSON(`http://${node.ip}:8008/patroni`);
        return {
          name: node.name,
          ip: node.ip,
          patroni: status
        };
      })
    );

    res.json({
      cluster_name: CLUSTER_NAME,
      vip: VIP,
      pg_port: PG_PORT,
      nodes: nodeStatuses,
      cluster: cluster,
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cluster/switchover — switch leader to a specific node (preferably node-1)
app.post('/api/cluster/switchover', async (req, res) => {
  const { target } = req.body || {};

  try {
    // Find current leader from Patroni
    let cluster = null;
    for (const node of nodes) {
      cluster = await fetchJSON(`http://${node.ip}:8008/cluster`);
      if (cluster) break;
    }
    if (!cluster || !cluster.members) {
      return res.status(503).json({ error: 'Cannot reach Patroni cluster' });
    }

    const leader = cluster.members.find(m => m.role === 'leader' || m.role === 'master');
    const targetName = target && cluster.members.find(m => m.name === target) ? target : nodes[0].name;

    if (!leader) {
      return res.status(503).json({ error: 'No leader found in cluster' });
    }
    if (leader.name === targetName) {
      return res.json({ status: 'ok', message: `${targetName} is already the leader` });
    }

    // Check target is healthy
    const targetMember = cluster.members.find(m => m.name === targetName);
    if (!targetMember || targetMember.state !== 'streaming') {
      return res.status(400).json({ error: `${targetName} is not healthy (state: ${targetMember?.state || 'unknown'})` });
    }

    // Trigger switchover via Patroni REST API on the leader
    const leaderNode = nodes.find(n => n.name === leader.name);
    if (!leaderNode) {
      return res.status(500).json({ error: 'Leader node not found in config' });
    }

    const postData = JSON.stringify({ leader: leader.name, candidate: targetName });
    const switchRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: leaderNode.ip,
        port: 8008,
        path: '/switchover',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 15000
      }, (resp) => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => resolve({ status: resp.statusCode, body }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(postData);
      req.end();
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

// GET /api/databases — database sizes and info
app.get('/api/databases', async (req, res) => {
  const pool = new Pool({
    host: VIP || nodes[0].ip,
    port: parseInt(PG_PORT),
    user: 'postgres',
    password: PG_PASS,
    database: 'postgres',
    connectionTimeoutMillis: 3000
  });
  try {
    const result = await pool.query(`
      SELECT datname, pg_database_size(datname) as size_bytes,
             numbackends as connections
      FROM pg_stat_database
      WHERE datname NOT IN ('template0', 'template1')
      ORDER BY pg_database_size(datname) DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  } finally {
    await pool.end();
  }
});

// GET /api/replication — replication status
app.get('/api/replication', async (req, res) => {
  const pool = new Pool({
    host: VIP || nodes[0].ip,
    port: parseInt(PG_PORT),
    user: 'postgres',
    password: PG_PASS,
    database: 'postgres',
    connectionTimeoutMillis: 3000
  });
  try {
    const result = await pool.query(`
      SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
             pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes
      FROM pg_stat_replication
    `);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  } finally {
    await pool.end();
  }
});

// GET /api/connections — connection stats
app.get('/api/connections', async (req, res) => {
  const pool = new Pool({
    host: VIP || nodes[0].ip,
    port: parseInt(PG_PORT),
    user: 'postgres',
    password: PG_PASS,
    database: 'postgres',
    connectionTimeoutMillis: 3000
  });
  try {
    const result = await pool.query(`
      SELECT state, count(*) as count
      FROM pg_stat_activity
      GROUP BY state
      ORDER BY count DESC
    `);
    const max = await pool.query('SHOW max_connections');
    res.json({
      by_state: result.rows,
      max_connections: parseInt(max.rows[0].max_connections)
    });
  } catch (err) {
    res.json({ by_state: [], max_connections: 0 });
  } finally {
    await pool.end();
  }
});

// GET /api/system/local — this node's system stats (used by other nodes to aggregate)
app.get('/api/system/local', (req, res) => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = os.uptime();
  const loadAvg = os.loadavg();

  res.json({
    hostname: os.hostname(),
    uptime_seconds: uptime,
    load_avg: { '1m': loadAvg[0], '5m': loadAvg[1], '15m': loadAvg[2] },
    cpu_count: cpus.length,
    memory: {
      total_bytes: totalMem,
      free_bytes: freeMem,
      used_percent: ((1 - freeMem / totalMem) * 100).toFixed(1)
    }
  });
});

// GET /api/system — system stats from all nodes
app.get('/api/system', async (req, res) => {
  const results = await Promise.all(
    nodes.map(async node => {
      const data = await fetchJSON(`http://${node.ip}:${PORT}/api/system/local`);
      return {
        name: node.name,
        ip: node.ip,
        ...( data || { hostname: node.name, error: true })
      };
    })
  );
  res.json(results);
});

// GET /api/config — safe cluster config info
app.get('/api/config', (req, res) => {
  res.json({
    cluster_name: CLUSTER_NAME,
    node_count: NODE_COUNT,
    pg_port: PG_PORT,
    vip: VIP,
    monitor_port: PORT,
    nodes: nodes
  });
});

// GET /api/config/export — download cluster.conf as file
app.get('/api/config/export', (req, res) => {
  if (!fs.existsSync(confPath)) return res.status(404).json({ error: 'cluster.conf not found' });
  const content = fs.readFileSync(confPath, 'utf8');
  // Redact sensitive fields
  const redacted = content.replace(/^(PG_REPL_PASS|PG_ADMIN_PASS|SMB_PASS)="[^"]*"/gm, '$1="***REDACTED***"');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="cluster-${CLUSTER_NAME}-${new Date().toISOString().slice(0,10)}.conf"`);
  res.send(redacted);
});

// GET /api/config/patroni — export patroni config from all nodes
app.get('/api/config/patroni', async (req, res) => {
  const configs = {};
  for (const node of nodes) {
    try {
      const resp = await new Promise((resolve, reject) => {
        const r = http.get(`http://${node.ip}:8008/config`, { timeout: 5000 }, resolve);
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      });
      let body = '';
      resp.on('data', d => body += d);
      await new Promise((resolve, reject) => {
        resp.on('end', resolve);
        setTimeout(() => reject(new Error('timeout')), 5000);
      });
      configs[node.name] = JSON.parse(body);
    } catch { configs[node.name] = { error: 'unreachable' }; }
  }
  res.json(configs);
});

// GET /api/version — current local version
app.get('/api/version', (req, res) => {
  LOCAL_VERSION = readLocalVersion();
  res.json({ version: LOCAL_VERSION });
});

// GET /api/version/check — check for latest version on GitHub + all node versions
app.get('/api/version/check', async (req, res) => {
  // Always re-read local version
  LOCAL_VERSION = readLocalVersion();

  // Fetch versions from all nodes
  const nodeVersions = await Promise.all(
    nodes.map(async (node) => {
      try {
        const data = await fetchJSON(`http://${node.ip}:${PORT}/api/version`, 3000);
        return { name: node.name, ip: node.ip, version: data?.version || 'unknown' };
      } catch {
        return { name: node.name, ip: node.ip, version: 'unreachable' };
      }
    })
  );

  const allSameVersion = nodeVersions.every(n => n.version === LOCAL_VERSION);

  // Always fetch from GitHub — no cache, this is user-triggered
  const result = await new Promise((resolve) => {
    https.get('https://api.github.com/repos/iadityaharsh/postgresql-cluster/tags?per_page=30', {
      headers: { 'User-Agent': 'pg-cluster-monitor', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 10000
    }, (resp) => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        try {
          const tags = JSON.parse(body);
          if (Array.isArray(tags) && tags.length > 0) {
            let latest = '0.0.0';
            for (const tag of tags) {
              const v = tag.name.replace(/^v/, '');
              if (/^\d+\.\d+\.\d+$/.test(v) && compareVersions(v, latest) > 0) latest = v;
            }
            resolve({ latest });
          } else {
            resolve({ latest: null, error: tags.message || 'No tags found' });
          }
        } catch (e) { resolve({ latest: null, error: e.message }); }
      });
    }).on('error', (err) => {
      resolve({ latest: null, error: err.message });
    });
  });

  res.json({
    current: LOCAL_VERSION,
    latest: result.latest,
    update_available: result.latest ? compareVersions(result.latest, LOCAL_VERSION) > 0 : false,
    nodes: nodeVersions,
    all_nodes_match: allSameVersion,
    error: result.error || undefined
  });
});

// POST /api/version/upgrade — upgrade ALL nodes in the cluster
let upgradeTask = { running: false, log: [], exitCode: null, startTime: null };

// Helper: run update.sh on this node
function runLocalUpdate(task) {
  return new Promise((resolve) => {
    const repoCandidates = [
      path.resolve(__dirname, '..'),
      '/root/postgresql-cluster',
      path.resolve(os.homedir(), 'postgresql-cluster'),
      '/opt/postgresql-cluster'
    ];
    const repoDir = repoCandidates.find(d => fs.existsSync(path.join(d, 'update.sh')));

    // Always git fetch + pull FIRST so we get the latest update.sh before running it
    // This avoids the bootstrap problem where a broken update.sh can't update itself
    let cmd, args;
    if (!repoDir) {
      cmd = 'bash';
      args = ['-c', 'cd /root && [ ! -d postgresql-cluster/.git ] && rm -rf postgresql-cluster; git clone https://github.com/iadityaharsh/postgresql-cluster.git 2>&1 && cd postgresql-cluster && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1'];
    } else {
      cmd = 'bash';
      args = ['-c', `cd ${repoDir} && git fetch origin --tags -f 2>&1 && git pull origin main 2>&1 && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1`];
    }

    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PG_DASHBOARD_UPGRADE: '1' }
    });

    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => {
        task.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
      });
    });
    child.stderr.on('data', (data) => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => {
        task.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
      });
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// Helper: trigger upgrade on a remote node via its API
function triggerRemoteUpgrade(nodeIp, task) {
  return new Promise((resolve) => {
    task.log.push(`[${new Date().toLocaleTimeString()}] Upgrading ${nodeIp}...`);
    const req = http.request({
      hostname: nodeIp, port: PORT, path: '/api/version/upgrade/apply',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      timeout: 120000
    }, (resp) => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          task.log.push(`[${new Date().toLocaleTimeString()}] ${nodeIp}: ${data.message || 'OK'}`);
        } catch {
          task.log.push(`[${new Date().toLocaleTimeString()}] ${nodeIp}: ${body.trim() || 'OK'}`);
        }
        resolve(true);
      });
    });
    req.on('error', (e) => {
      task.log.push(`[${new Date().toLocaleTimeString()}] ${nodeIp}: ${e.message}`);
      resolve(false);
    });
    req.on('timeout', () => {
      task.log.push(`[${new Date().toLocaleTimeString()}] ${nodeIp}: timeout`);
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

app.post('/api/version/upgrade', async (req, res) => {
  if (upgradeTask.running) return res.status(409).json({ error: 'Upgrade already running' });

  upgradeTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
  upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] Starting cluster-wide upgrade from ${LOCAL_VERSION}...`);
  res.json({ status: 'started' });

  // Step 1: Update this node (git pull + copy files, no service restart)
  upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] --- Upgrading this node ---`);
  const localOk = await runLocalUpdate(upgradeTask);

  if (!localOk) {
    upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] TASK ERROR — local update failed`);
    upgradeTask.exitCode = 1;
    upgradeTask.running = false;
    return;
  }

  // Step 2: Trigger upgrade on all other nodes
  const myIps = (() => { try { return os.networkInterfaces(); } catch { return {}; } })();
  const myIpSet = new Set();
  Object.values(myIps).forEach(ifaces => ifaces.forEach(i => { if (i.family === 'IPv4') myIpSet.add(i.address); }));

  const otherNodes = nodes.filter(n => !myIpSet.has(n.ip));
  if (otherNodes.length > 0) {
    upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] --- Upgrading ${otherNodes.length} other node(s) ---`);
    for (const node of otherNodes) {
      await triggerRemoteUpgrade(node.ip, upgradeTask);
    }
  }

  // Done
  upgradeTask.log.push(`[${new Date().toLocaleTimeString()}] TASK OK — page will reload automatically.`);
  upgradeTask.exitCode = 0;
  upgradeTask.running = false;

  // Restart ourselves after frontend sees success — use systemctl explicitly
  // so it works regardless of systemd Restart= policy
  setTimeout(() => {
    spawn('systemctl', ['restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref();
  }, 5000);
});

// POST /api/version/upgrade/apply — called by leader to upgrade this node
app.post('/api/version/upgrade/apply', async (req, res) => {
  const repoCandidates = [
    path.resolve(__dirname, '..'),
    '/root/postgresql-cluster',
    path.resolve(os.homedir(), 'postgresql-cluster'),
    '/opt/postgresql-cluster'
  ];
  const repoDir = repoCandidates.find(d => fs.existsSync(path.join(d, 'update.sh')));

  if (!repoDir) {
    return res.status(404).json({ message: 'No git repo found' });
  }

  // Git fetch + pull first, then run update.sh deploy phase (skip Phase 1 re-pull)
  const child = spawn('bash', ['-c', `cd ${repoDir} && git fetch origin --tags -f 2>&1 && git pull origin main 2>&1 && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1`], {
    stdio: 'ignore', detached: true,
    env: { ...process.env, PG_DASHBOARD_UPGRADE: '1' }
  });
  child.unref();

  res.json({ message: 'Upgrade started, restarting...' });
  // Restart after response is flushed — use systemctl explicitly
  res.on('finish', () => {
    setTimeout(() => {
      spawn('systemctl', ['restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref();
    }, 5000);
  });
});

// GET /api/version/upgrade/status — upgrade task log
app.get('/api/version/upgrade/status', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({
    running: upgradeTask.running,
    exitCode: upgradeTask.exitCode,
    startTime: upgradeTask.startTime,
    log: upgradeTask.log.slice(since),
    totalLines: upgradeTask.log.length
  });
});

function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Helper: run borg command and return stdout
function runBorg(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BORG_PASSPHRASE: '', BORG_REPO };
    execFile('borg', args, { env, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// GET /api/backups — list all backup archives
app.get('/api/backups', async (req, res) => {
  try {
    const output = await runBorg(['list', '--json', BORG_REPO]);
    const data = JSON.parse(output);
    const archives = (data.archives || []).map(a => ({
      name: a.name,
      start: a.start,
      time: a.time || a.start,
      id: a.id
    })).reverse();
    res.json({ available: true, archives });
  } catch (err) {
    if (err.message.includes('No such file') || err.message.includes('not a valid')) {
      res.json({ available: false, archives: [], error: 'Borg repo not found. Run setup-backup.sh first.' });
    } else {
      res.json({ available: false, archives: [], error: err.message });
    }
  }
});

// Backup task state
let backupTask = { running: false, log: [], exitCode: null, startTime: null };

// POST /api/backups — trigger a new backup
app.post('/api/backups', (req, res) => {
  if (backupTask.running) {
    return res.status(409).json({ error: 'A backup is already running' });
  }
  if (!fs.existsSync(BACKUP_SCRIPT)) {
    return res.status(404).json({ error: 'Backup script not found. Run setup-backup.sh first.' });
  }

  backupTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
  backupTask.log.push(`[${new Date().toLocaleTimeString()}] Starting backup task...`);
  backupTask.log.push(`[${new Date().toLocaleTimeString()}] Executing: ${BACKUP_SCRIPT}`);

  const child = spawn('bash', [BACKUP_SCRIPT], {
    env: { ...process.env, BORG_PASSPHRASE: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      backupTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    });
  });

  child.stderr.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      backupTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    });
  });

  child.on('close', (code) => {
    backupTask.exitCode = code;
    backupTask.log.push(`[${new Date().toLocaleTimeString()}] ${code === 0 ? 'TASK OK' : `TASK ERROR (exit code ${code})`}`);
    backupTask.running = false;
  });

  child.on('error', (err) => {
    backupTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`);
    backupTask.exitCode = 1;
    backupTask.running = false;
  });

  res.json({ status: 'started', message: 'Backup started' });
});

// GET /api/backups/status — task status + log
app.get('/api/backups/status', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({
    running: backupTask.running,
    exitCode: backupTask.exitCode,
    startTime: backupTask.startTime,
    log: backupTask.log.slice(since),
    totalLines: backupTask.log.length
  });
});

// GET /api/backups/:name — info about a specific archive
app.get('/api/backups/:name', async (req, res) => {
  try {
    const output = await runBorg(['info', '--json', `${BORG_REPO}::${req.params.name}`]);
    const data = JSON.parse(output);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/backups/:name — delete a specific archive
app.delete('/api/backups/:name', async (req, res) => {
  const name = req.params.name;
  if (!name || !/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid archive name' });
  try {
    await runBorg(['delete', `${BORG_REPO}::${name}`]);
    res.json({ message: `Archive ${name} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore task state
let restoreTask = { running: false, log: [], exitCode: null, startTime: null };

// POST /api/backups/restore — restore from a specific archive
app.post('/api/backups/restore', (req, res) => {
  const { archive } = req.body;
  if (!archive) return res.status(400).json({ error: 'Archive name required' });
  if (restoreTask.running) return res.status(409).json({ error: 'A restore is already running' });

  const host = VIP || nodes[0].ip;
  restoreTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
  restoreTask.log.push(`[${new Date().toLocaleTimeString()}] Starting restore of "${archive}"...`);
  restoreTask.log.push(`[${new Date().toLocaleTimeString()}] Target: ${host}:${PG_PORT}`);

  const env = { ...process.env, BORG_PASSPHRASE: '', PGPASSWORD: PG_PASS };
  const borgExtract = spawn('borg', ['extract', '--stdout', `${BORG_REPO}::${archive}`], { env });
  const psqlRestore = spawn('psql', ['-h', host, '-p', PG_PORT, '-U', 'postgres', '-f', '-'], { env });

  borgExtract.stdout.pipe(psqlRestore.stdin);

  borgExtract.stderr.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      restoreTask.log.push(`[${new Date().toLocaleTimeString()}] borg: ${line}`);
    });
  });

  psqlRestore.stderr.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      restoreTask.log.push(`[${new Date().toLocaleTimeString()}] psql: ${line}`);
    });
  });

  psqlRestore.on('close', (code) => {
    restoreTask.exitCode = code;
    restoreTask.log.push(`[${new Date().toLocaleTimeString()}] ${code === 0 ? 'TASK OK' : `TASK ERROR (exit code ${code})`}`);
    restoreTask.running = false;
  });

  borgExtract.on('error', (err) => {
    restoreTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`);
    restoreTask.exitCode = 1;
    restoreTask.running = false;
  });

  res.json({ status: 'started', message: `Restoring ${archive}` });
});

// GET /api/backups/restore/status — restore task status + log
app.get('/api/backups/restore/status', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({
    running: restoreTask.running,
    exitCode: restoreTask.exitCode,
    startTime: restoreTask.startTime,
    log: restoreTask.log.slice(since),
    totalLines: restoreTask.log.length
  });
});

// ============================================================
// Storage configuration (NFS/SMB) — Proxmox-style from dashboard
// ============================================================

function reloadConf() {
  if (fs.existsSync(confPath)) {
    fs.readFileSync(confPath, 'utf8').split('\n').forEach(line => {
      const match = line.match(/^(\w+)="?([^"]*)"?$/);
      if (match) conf[match[1]] = match[2];
    });
  }
}

function updateConfKeys(updates) {
  let content = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}="${value}"`;
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content = content.trimEnd() + '\n' + line + '\n';
    }
  }
  fs.writeFileSync(confPath, content);
  reloadConf();
}

// Detect if running inside an LXC container
function isLxcContainer() {
  try {
    // systemd-detect-virt returns 'lxc' inside LXC containers
    const virt = require('child_process').execSync('systemd-detect-virt --container 2>/dev/null || true').toString().trim();
    if (virt === 'lxc') return true;
    // Fallback: check /proc/1/environ for container=lxc
    if (fs.existsSync('/proc/1/environ')) {
      const env = fs.readFileSync('/proc/1/environ', 'utf8');
      if (env.includes('container=lxc')) return true;
    }
    return false;
  } catch { return false; }
}

// GET /api/storage — current storage config
app.get('/api/storage', (req, res) => {
  try {
    reloadConf();
    let mounted = false;
    try {
      // Check systemd automount first — if active, the share mounts on access (like Proxmox)
      const automountActive = require('child_process').execSync(
        'systemctl is-active mnt-pg\\\\x2dbackup.automount 2>/dev/null || echo inactive',
        { timeout: 3000 }
      ).toString().trim() === 'active';
      if (automountActive) {
        mounted = true;
      } else if (fs.existsSync('/mnt/pg-backup')) {
        mounted = require('child_process').execSync('mountpoint -q /mnt/pg-backup 2>/dev/null && echo yes || echo no', { timeout: 5000 }).toString().trim() === 'yes';
      }
    } catch {}
    res.json({
      enabled: conf.ENABLE_BACKUP === 'Y' || conf.ENABLE_BACKUP === 'y',
      type: conf.NFS_SERVER ? 'nfs' : (conf.SMB_SHARE ? 'smb' : 'none'),
      nfs_server: conf.NFS_SERVER || '',
      nfs_path: conf.NFS_PATH || '',
      smb_share: conf.SMB_SHARE || '',
      smb_user: conf.SMB_USER || '',
      smb_domain: conf.SMB_DOMAIN || '',
      schedule: conf.BACKUP_SCHEDULE || '0 2 * * *',
      retention: conf.BACKUP_LOCAL_RETENTION || '7',
      is_lxc: isLxcContainer(),
      mounted
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/storage/mount — manually mount the backup share (for SMB)
app.post('/api/storage/mount', (req, res) => {
  const child = spawn('bash', ['-c', 'mount /mnt/pg-backup 2>&1 || mount -a 2>&1'], { timeout: 15000 });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  child.on('close', (code) => {
    try {
      const mounted = require('child_process').execSync('mountpoint -q /mnt/pg-backup && echo yes || echo no', { timeout: 3000 }).toString().trim() === 'yes';
      if (mounted) {
        res.json({ message: 'Share mounted successfully' });
      } else {
        res.status(500).json({ error: out.trim() || 'Mount failed' });
      }
    } catch {
      res.status(500).json({ error: out.trim() || 'Mount failed' });
    }
  });
  child.on('error', (err) => {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/storage/nfs-exports?server=<ip> — discover NFS exports via showmount
app.get('/api/storage/nfs-exports', (req, res) => {
  const server = req.query.server;
  if (!server || !require('net').isIPv4(server)) {
    return res.status(400).json({ error: 'Invalid server IP' });
  }
  const child = spawn('bash', ['-c',
    `command -v showmount >/dev/null 2>&1 || apt-get install -y -qq nfs-common >/dev/null 2>&1; showmount -e ${server} --no-headers 2>&1`
  ], { timeout: 15000 });

  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  child.on('close', (code) => {
    if (code !== 0) {
      return res.json({ exports: [], error: out.trim() || 'Failed to scan NFS exports' });
    }
    const exports = out.trim().split('\n')
      .filter(l => l.trim())
      .map(l => {
        const parts = l.trim().split(/\s+/);
        return { path: parts[0], allowed: parts.slice(1).join(' ') };
      });
    res.json({ exports });
  });
});

// POST /api/storage — configure and setup backup storage
let storageTask = { running: false, log: [], exitCode: null, startTime: null };

app.post('/api/storage', (req, res) => {
  const { type, nfs_server, nfs_path, smb_share, smb_user, smb_pass, smb_domain, schedule, retention } = req.body;

  if (storageTask.running) return res.status(409).json({ error: 'Storage setup already running' });

  if (type === 'nfs' && (!nfs_server || !nfs_path)) {
    return res.status(400).json({ error: 'NFS server and path are required' });
  }
  if (type === 'smb' && !smb_share) {
    return res.status(400).json({ error: 'SMB share path is required' });
  }
  if (type === 'smb' && isLxcContainer()) {
    return res.status(400).json({ error: 'SMB/CIFS is not supported in LXC containers (missing CAP_SYS_ADMIN). Use NFS instead.' });
  }

  // Update cluster.conf
  const updates = {
    ENABLE_BACKUP: type !== 'none' ? 'y' : 'n',
    BACKUP_SCHEDULE: schedule || '0 2 * * *',
    BACKUP_LOCAL_RETENTION: retention || '7',
    NFS_SERVER: type === 'nfs' ? nfs_server : '',
    NFS_PATH: type === 'nfs' ? nfs_path : '',
    SMB_SHARE: type === 'smb' ? smb_share : '',
    SMB_USER: type === 'smb' ? (smb_user || '') : '',
    SMB_PASS: type === 'smb' ? (smb_pass || '') : '',
    SMB_DOMAIN: type === 'smb' ? (smb_domain || 'WORKGROUP') : ''
  };
  updateConfKeys(updates);

  if (type === 'none') {
    return res.json({ status: 'ok', message: 'Backups disabled' });
  }

  // Run setup-backup.sh with task viewer
  const script = findScript('setup-backup.sh');
  if (!script) {
    return res.status(404).json({ error: 'setup-backup.sh not found' });
  }

  storageTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
  storageTask.log.push(`[${new Date().toLocaleTimeString()}] Configuring ${type.toUpperCase()} storage...`);
  storageTask.log.push(`[${new Date().toLocaleTimeString()}] Server: ${nfs_server}:${nfs_path}`);
  storageTask.log.push(`[${new Date().toLocaleTimeString()}] Running setup-backup.sh on this node...`);

  const child = spawn('bash', [script], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    });
  });
  child.stderr.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    });
  });

  child.on('close', async (code) => {
    if (code === 0) {
      storageTask.log.push(`[${new Date().toLocaleTimeString()}] Local setup complete. Syncing to other nodes...`);

      // Sync config + setup to other nodes
      for (const node of nodes) {
        const nodeIp = node.ip;
        try {
          storageTask.log.push(`[${new Date().toLocaleTimeString()}] Syncing to ${node.name} (${nodeIp})...`);
          // Push config update to other nodes' pg-monitor
          const postData = JSON.stringify(updates);
          await new Promise((resolve, reject) => {
            const req = http.request({
              hostname: nodeIp, port: PORT, path: '/api/storage/apply',
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
              timeout: 30000
            }, (res) => {
              let body = '';
              res.on('data', d => body += d);
              res.on('end', () => {
                storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: ${body.trim() || 'OK'}`);
                resolve();
              });
            });
            req.on('error', (e) => {
              storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: ${e.message}`);
              resolve();
            });
            req.on('timeout', () => { req.destroy(); resolve(); });
            req.write(postData);
            req.end();
          });
        } catch (e) {
          storageTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: sync failed`);
        }
      }

      storageTask.log.push(`[${new Date().toLocaleTimeString()}] TASK OK`);
    } else {
      storageTask.log.push(`[${new Date().toLocaleTimeString()}] TASK ERROR (exit code ${code})`);
    }
    storageTask.exitCode = code;
    storageTask.running = false;
  });

  child.on('error', (err) => {
    storageTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`);
    storageTask.exitCode = 1;
    storageTask.running = false;
  });

  res.json({ status: 'started', message: 'Setting up storage' });
});

// GET /api/storage/status — storage setup task log
app.get('/api/storage/status', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({
    running: storageTask.running,
    exitCode: storageTask.exitCode,
    startTime: storageTask.startTime,
    log: storageTask.log.slice(since),
    totalLines: storageTask.log.length
  });
});

// POST /api/storage/apply — called by leader node to sync config + run setup on this node
app.post('/api/storage/apply', (req, res) => {
  const updates = req.body;
  try {
    updateConfKeys(updates);

    const backupScript = findScript('setup-backup.sh');
    if (backupScript) {
      const child = spawn('bash', [backupScript], { stdio: 'ignore', detached: true });
      child.unref();
    }

    res.json({ status: 'ok', message: 'Config applied, setup running' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Remote Access — Cloudflare Tunnel status & setup
// ============================================================

// GET /api/tunnel — check cloudflared and tunnel status
app.get('/api/tunnel', (req, res) => {
  const result = { installed: false, version: null, running: false };

  // Check if cloudflared is installed
  try {
    const ver = require('child_process').execSync('cloudflared --version 2>&1').toString().trim();
    result.installed = true;
    result.version = ver.match(/cloudflared version ([\d.]+)/)?.[1] || ver;
  } catch {}

  // Check if cloudflared service is running
  try {
    const status = require('child_process').execSync('systemctl is-active cloudflared 2>/dev/null').toString().trim();
    result.running = status === 'active';
  } catch {}

  res.json(result);
});

// POST /api/tunnel/setup — install tunnel connector on ALL nodes using token
let tunnelTask = { running: false, log: [], exitCode: null, startTime: null };
app.post('/api/tunnel/setup', async (req, res) => {
  const { token } = req.body;

  if (tunnelTask.running) return res.status(409).json({ error: 'Tunnel setup already running' });
  if (!token || token.length < 20) return res.status(400).json({ error: 'Valid tunnel token is required' });

  // Save token to cluster.conf
  updateConfKeys({ TUNNEL_TOKEN: token });

  const scriptPath = findScript('setup-tunnel.sh');
  if (!scriptPath) {
    return res.status(404).json({ error: 'setup-tunnel.sh not found' });
  }

  tunnelTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
  res.json({ status: 'started' });

  // Step 1: Setup on this node
  tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] Setting up Cloudflare Tunnel on all nodes...`);
  tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] --- This node ---`);

  const localOk = await new Promise((resolve) => {
    const child = spawn('bash', [scriptPath, token], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TUNNEL_TOKEN: token }
    });
    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => {
        tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
      });
    });
    child.stderr.on('data', (data) => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => {
        tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
      });
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });

  if (!localOk) {
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] TASK ERROR — local setup failed`);
    tunnelTask.exitCode = 1;
    tunnelTask.running = false;
    return;
  }

  // Step 2: Setup on all other nodes
  const myIps = new Set();
  Object.values(os.networkInterfaces()).forEach(ifaces => ifaces.forEach(i => { if (i.family === 'IPv4') myIps.add(i.address); }));
  const otherNodes = nodes.filter(n => !myIps.has(n.ip));

  for (const node of otherNodes) {
    tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] --- ${node.name} (${node.ip}) ---`);
    await new Promise((resolve) => {
      const postData = JSON.stringify({ token });
      const req = http.request({
        hostname: node.ip, port: PORT, path: '/api/tunnel/apply',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 120000
      }, (resp) => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => {
          tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: ${body.trim() || 'OK'}`);
          resolve();
        });
      });
      req.on('error', (e) => {
        tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: ${e.message}`);
        resolve();
      });
      req.on('timeout', () => {
        tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] ${node.name}: timeout`);
        req.destroy();
        resolve();
      });
      req.write(postData);
      req.end();
    });
  }

  tunnelTask.log.push(`[${new Date().toLocaleTimeString()}] TASK OK — all nodes configured as tunnel connectors`);
  tunnelTask.exitCode = 0;
  tunnelTask.running = false;
});

// POST /api/tunnel/apply — called by leader to setup tunnel on this node
app.post('/api/tunnel/apply', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const scriptPath = findScript('setup-tunnel.sh');
  if (!scriptPath) return res.status(404).json({ error: 'setup-tunnel.sh not found' });

  const child = spawn('bash', [scriptPath, token], {
    stdio: 'ignore', detached: true,
    env: { ...process.env, TUNNEL_TOKEN: token }
  });
  child.unref();

  res.json({ message: 'Tunnel connector setup started' });
});

app.get('/api/tunnel/status', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({
    running: tunnelTask.running,
    exitCode: tunnelTask.exitCode,
    startTime: tunnelTask.startTime,
    log: tunnelTask.log.slice(since),
    totalLines: tunnelTask.log.length
  });
});

// ============================================================
// Hyperdrive — manage Cloudflare Hyperdrive configs per database
// ============================================================

const HYPERDRIVE_JSON = (() => {
  const candidates = [
    path.resolve(__dirname, 'hyperdrive.json'),
    path.resolve(__dirname, '..', 'hyperdrive.json')
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
})();

function readHyperdriveConfigs() {
  try {
    if (fs.existsSync(HYPERDRIVE_JSON)) return JSON.parse(fs.readFileSync(HYPERDRIVE_JSON, 'utf8'));
  } catch {}
  return {};
}

function writeHyperdriveConfigs(configs) {
  fs.writeFileSync(HYPERDRIVE_JSON, JSON.stringify(configs, null, 2));
}

// Fetch Hyperdrive configs from Cloudflare API
function fetchCloudflareHyperdrives() {
  const token = process.env.CLOUDFLARE_API_TOKEN || conf.CLOUDFLARE_API_TOKEN || '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || conf.CLOUDFLARE_ACCOUNT_ID || '';
  if (!token || !accountId) return Promise.resolve(null);

  return new Promise((resolve) => {
    const req = https.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 8000
    }, (resp) => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.success ? (data.result || []) : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// GET /api/hyperdrive — list all configs + databases with status
app.get('/api/hyperdrive', async (req, res) => {
  let configs = readHyperdriveConfigs();

  // Get database list from PostgreSQL
  let databases = [];
  try {
    const pool = new Pool({
      host: VIP || nodes[0].ip,
      port: parseInt(PG_PORT),
      user: 'postgres',
      password: PG_PASS,
      database: 'postgres',
      connectionTimeoutMillis: 3000,
      query_timeout: 5000
    });
    const result = await pool.query(`
      SELECT datname FROM pg_database
      WHERE datname NOT IN ('template0', 'template1')
      ORDER BY datname
    `);
    databases = result.rows.map(r => r.datname);
    await pool.end().catch(() => {});
  } catch {}

  // Fetch existing Hyperdrive configs from Cloudflare API and auto-merge
  let cfApiAvailable = false;
  const remoteConfigs = await fetchCloudflareHyperdrives();
  if (remoteConfigs) {
    cfApiAvailable = true;
    let changed = false;
    for (const hd of remoteConfigs) {
      const origin = hd.origin || {};
      const dbName = origin.database;
      if (!dbName) continue;

      // Check if we already have this config locally (by hyperdrive_id or database match)
      const existingByID = Object.values(configs).find(c => c.hyperdrive_id === hd.id);
      if (existingByID) continue;

      const existingByDB = Object.values(configs).find(c => c.database === dbName);
      if (existingByDB) {
        // Update hyperdrive_id if missing
        if (!existingByDB.hyperdrive_id && hd.id) {
          existingByDB.hyperdrive_id = hd.id;
          changed = true;
        }
        continue;
      }

      // New config detected from Cloudflare — auto-import if it matches a local database
      // or import it anyway so the user can see all their Hyperdrive configs
      const key = `${dbName}-${origin.user || 'unknown'}`;
      configs[key] = {
        hyperdrive_id: hd.id,
        hyperdrive_name: hd.name || '',
        database: dbName,
        username: origin.user || '',
        hostname: origin.host || '',
        access_client_id: '',
        created: hd.created_on || new Date().toISOString(),
        source: 'cloudflare-api'
      };
      changed = true;
    }
    if (changed) writeHyperdriveConfigs(configs);
  }

  // Check wrangler availability (quick — just check if binary exists)
  let wranglerInstalled = false;
  try {
    require('child_process').execSync('command -v wrangler >/dev/null 2>&1 || command -v npx >/dev/null 2>&1', { timeout: 2000 });
    wranglerInstalled = true;
  } catch {}

  // Merge databases with configs
  const entries = databases.map(db => {
    const cfg = Object.values(configs).find(c => c.database === db);
    return {
      database: db,
      configured: !!cfg,
      config: cfg || null
    };
  });

  // Include configs for databases not in the local cluster (external or dropped)
  Object.values(configs).forEach(cfg => {
    if (!databases.includes(cfg.database)) {
      entries.push({ database: cfg.database, configured: true, config: cfg, missing: !databases.length });
    }
  });

  res.json({ entries, wrangler_installed: wranglerInstalled, cf_api_available: cfApiAvailable });
});

// POST /api/hyperdrive/cloudflare-auth — save Cloudflare API credentials to cluster.conf
app.post('/api/hyperdrive/cloudflare-auth', (req, res) => {
  const { account_id, api_token } = req.body;
  if (!account_id || !api_token) return res.status(400).json({ error: 'account_id and api_token are required' });
  try {
    updateConfKeys({ CLOUDFLARE_ACCOUNT_ID: account_id, CLOUDFLARE_API_TOKEN: api_token });
    // Also set as env vars for the current process
    process.env.CLOUDFLARE_ACCOUNT_ID = account_id;
    process.env.CLOUDFLARE_API_TOKEN = api_token;
    res.json({ message: 'Cloudflare credentials saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hyperdrive/create-user — create a dedicated DB user for Hyperdrive
app.post('/api/hyperdrive/create-user', async (req, res) => {
  const { database, username, password } = req.body;
  if (!database || !username || !password) {
    return res.status(400).json({ error: 'database, username, and password are required' });
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) {
    return res.status(400).json({ error: 'Invalid database name format' });
  }

  const pool = new Pool({
    host: VIP || nodes[0].ip,
    port: parseInt(PG_PORT),
    user: 'postgres',
    password: PG_PASS,
    database: 'postgres',
    connectionTimeoutMillis: 5000
  });

  try {
    // Check if user exists
    const exists = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [username]);
    if (exists.rows.length > 0) {
      // Update password
      await pool.query(`ALTER USER ${username} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    } else {
      await pool.query(`CREATE USER ${username} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    }

    // Grant on database
    await pool.query(`GRANT ALL PRIVILEGES ON DATABASE ${database} TO ${username}`);

    // Grant on tables in the target database
    const dbPool = new Pool({
      host: VIP || nodes[0].ip,
      port: parseInt(PG_PORT),
      user: 'postgres',
      password: PG_PASS,
      database: database,
      connectionTimeoutMillis: 5000
    });
    try {
      await dbPool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${username}`);
      await dbPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${username}`);
    } finally {
      await dbPool.end().catch(() => {});
    }

    res.json({ message: `User ${username} configured with access to ${database}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end().catch(() => {});
  }
});

// POST /api/hyperdrive — create a new Hyperdrive config via wrangler
let hyperdriveTask = { running: false, log: [], exitCode: null, startTime: null };

app.post('/api/hyperdrive', (req, res) => {
  const { database, username, password, hostname, hyperdrive_name, access_client_id, access_client_secret } = req.body;

  if (!database || !username || !password || !hostname || !access_client_id || !access_client_secret) {
    return res.status(400).json({ error: 'All fields are required: database, username, password, hostname, access_client_id, access_client_secret' });
  }
  if (hyperdriveTask.running) return res.status(409).json({ error: 'A Hyperdrive setup is already running' });

  const hdName = hyperdrive_name || `${CLUSTER_NAME}-${database}`;

  hyperdriveTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
  hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] Creating Hyperdrive config "${hdName}"...`);
  hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] Host: ${hostname}, DB: ${database}, User: ${username}`);

  res.json({ status: 'started' });

  const cmd = `npx wrangler hyperdrive create "${hdName}" \
    --origin-host="${hostname}" \
    --origin-user="${username}" \
    --origin-password="${password.replace(/"/g, '\\"')}" \
    --database="${database}" \
    --access-client-id="${access_client_id}" \
    --access-client-secret="${access_client_secret}" 2>&1`;

  const child = spawn('bash', ['-c', cmd], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '' }
  });

  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    });
  });
  child.stderr.on('data', (data) => {
    output += data.toString();
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    });
  });

  child.on('close', (code) => {
    if (code === 0) {
      // Extract Hyperdrive ID from output
      const idMatch = output.match(/([0-9a-f]{32})/i) || output.match(/id:\s*(\S+)/i);
      const hyperdriveId = idMatch ? idMatch[1] : null;

      // Save to configs
      const configs = readHyperdriveConfigs();
      const configKey = `${database}-${username}`;
      configs[configKey] = {
        hyperdrive_id: hyperdriveId,
        hyperdrive_name: hdName,
        database,
        username,
        hostname,
        access_client_id,
        created: new Date().toISOString()
      };
      writeHyperdriveConfigs(configs);

      hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] Hyperdrive ID: ${hyperdriveId || 'see output above'}`);
      hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] TASK OK — config saved`);
    } else {
      hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] TASK ERROR (exit code ${code})`);
    }
    hyperdriveTask.exitCode = code;
    hyperdriveTask.running = false;
  });

  child.on('error', (err) => {
    hyperdriveTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`);
    hyperdriveTask.exitCode = 1;
    hyperdriveTask.running = false;
  });
});

// GET /api/hyperdrive/status — task log for hyperdrive create
app.get('/api/hyperdrive/status', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({
    running: hyperdriveTask.running,
    exitCode: hyperdriveTask.exitCode,
    startTime: hyperdriveTask.startTime,
    log: hyperdriveTask.log.slice(since),
    totalLines: hyperdriveTask.log.length
  });
});

// PUT /api/hyperdrive/:key — update a Hyperdrive config (e.g. rotate password)
app.put('/api/hyperdrive/:key', (req, res) => {
  const configs = readHyperdriveConfigs();
  const cfg = configs[req.params.key];
  if (!cfg) return res.status(404).json({ error: 'Config not found' });

  const { password } = req.body;
  if (!password || !cfg.hyperdrive_id) {
    return res.status(400).json({ error: 'password and existing hyperdrive_id required' });
  }

  const cmd = `npx wrangler hyperdrive update "${cfg.hyperdrive_id}" --origin-password="${password.replace(/"/g, '\\"')}" 2>&1`;
  const child = spawn('bash', ['-c', cmd], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '' }
  });

  let output = '';
  child.stdout.on('data', d => output += d);
  child.stderr.on('data', d => output += d);
  child.on('close', (code) => {
    if (code === 0) {
      configs[req.params.key].updated = new Date().toISOString();
      writeHyperdriveConfigs(configs);
      res.json({ message: 'Password updated', output: output.trim() });
    } else {
      res.status(500).json({ error: output.trim() || 'wrangler update failed' });
    }
  });
  child.on('error', (err) => res.status(500).json({ error: err.message }));
});

// DELETE /api/hyperdrive/:key — delete a Hyperdrive config
app.delete('/api/hyperdrive/:key', (req, res) => {
  const configs = readHyperdriveConfigs();
  const cfg = configs[req.params.key];
  if (!cfg) return res.status(404).json({ error: 'Config not found' });

  if (!cfg.hyperdrive_id) {
    // No remote config to delete, just remove local
    delete configs[req.params.key];
    writeHyperdriveConfigs(configs);
    return res.json({ message: 'Local config removed' });
  }

  const cmd = `npx wrangler hyperdrive delete "${cfg.hyperdrive_id}" 2>&1`;
  const child = spawn('bash', ['-c', cmd], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '' }
  });

  let output = '';
  child.stdout.on('data', d => output += d);
  child.stderr.on('data', d => output += d);
  child.on('close', (code) => {
    // Remove from local config regardless — if remote delete fails, user can recreate
    delete configs[req.params.key];
    writeHyperdriveConfigs(configs);
    if (code === 0) {
      res.json({ message: `Hyperdrive ${cfg.hyperdrive_name} deleted` });
    } else {
      res.json({ message: 'Local config removed, but wrangler delete may have failed', warning: output.trim() });
    }
  });
  child.on('error', (err) => res.status(500).json({ error: err.message }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cluster monitor running at http://0.0.0.0:${PORT}`);
});
