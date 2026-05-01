const express = require('express');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { spawn } = require('child_process');

const DB_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_DB_NAMES = new Set(['postgres', 'template0', 'template1', 'template_postgis']);
const SYSTEM_DB_NAMES = new Set(['template0', 'template1']);

function ident(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

let restoreInProgress = false;

// Pool cache — one pool per database, reused across requests instead of opening per-request
const dbPoolCache = new Map();

function getDbPool(dbName, host, port, user, password) {
  if (!dbPoolCache.has(dbName)) {
    dbPoolCache.set(dbName, new Pool({
      host, port: parseInt(port), user, password, database: dbName,
      max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    }));
  }
  return dbPoolCache.get(dbName);
}

module.exports = function createClusterRouter(ctx) {
  const router = express.Router();
  const { nodes, conf, fetchJSON, CLUSTER_NAME, VIP, PG_PORT, PG_PASS, PORT, PATRONI_API_USER, PATRONI_API_PASS, findScript, SELF_PROTO, internalLib, internalOpts } = ctx;

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
      const nodeResults = await Promise.allSettled(
        nodes.map(node =>
          fetchJSON(`https://${node.ip}:8008/patroni`, 2000, pAuth())
            .then(status => ({ name: node.name, ip: node.ip, patroni: status }))
        )
      );
      const nodeStatuses = nodeResults.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { name: nodes[i].name, ip: nodes[i].ip, patroni: null }
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
      if (!leader) return res.status(503).json({ error: 'No leader found in cluster' });
      // Validate target is in cluster.conf (not just in Patroni's view)
      if (!target || !nodes.find(n => n.name === target)) {
        return res.status(400).json({ error: `Target "${target}" not found in cluster configuration` });
      }
      const targetName = target;
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
      function patroniPost(lib, opts, data) {
        return new Promise((resolve, reject) => {
          const r = lib.request(opts, (resp) => {
            let body = '';
            resp.on('data', d => body += d);
            resp.on('end', () => resolve({ status: resp.statusCode, body }));
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
          r.write(data);
          r.end();
        });
      }
      const reqOpts = { hostname: leaderNode.ip, port: 8008, path: '/switchover', method: 'POST', headers: switchHeaders, timeout: 15000, rejectUnauthorized: false };
      const switchRes = await patroniPost(https, reqOpts, postData);
      if (switchRes.status === 200 || switchRes.status === 202) {
        res.json({ status: 'ok', message: `${targetName} is now the leader` });
      } else {
        res.status(switchRes.status).json({ error: `Patroni returned ${switchRes.status}: ${switchRes.body}` });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cluster/reinit — reinitialize a replica that has diverged timelines
  router.post('/cluster/reinit', async (req, res) => {
    const { node: nodeName } = req.body || {};
    if (!nodeName) return res.status(400).json({ error: 'node name is required' });
    const targetNode = nodes.find(n => n.name === nodeName);
    if (!targetNode) return res.status(404).json({ error: `Node ${nodeName} not found in cluster config` });
    try {
      const { execFile } = require('child_process');
      await new Promise((resolve, reject) => {
        execFile('patronictl', ['-c', '/etc/patroni/config.yml', 'reinit', CLUSTER_NAME, nodeName, '--force'],
          { timeout: 60000 },
          (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
          });
      });
      res.json({ status: 'ok', message: `Reinit triggered for ${nodeName}. It will re-sync from the primary.` });
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

  // POST /api/databases
  router.post('/databases', async (req, res) => {
    const { database, owner, password } = req.body || {};
    if (!database || !owner || !password) {
      return res.status(400).json({ error: 'database, owner, and password are required' });
    }
    if (!DB_NAME_REGEX.test(database)) {
      return res.status(400).json({ error: 'Invalid database name. Must match ^[a-z][a-z0-9_]{0,62}$' });
    }
    if (!DB_NAME_REGEX.test(owner)) {
      return res.status(400).json({ error: 'Invalid owner name. Must match ^[a-z][a-z0-9_]{0,62}$' });
    }
    if (RESERVED_DB_NAMES.has(database)) {
      return res.status(400).json({ error: `Database name "${database}" is reserved` });
    }
    if (RESERVED_DB_NAMES.has(owner)) {
      return res.status(400).json({ error: `Owner name "${owner}" is reserved` });
    }
    try {
      const dbExists = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      if (dbExists.rows.length > 0) {
        return res.status(409).json({ error: `Database "${database}" already exists` });
      }
      const userExists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [owner]);
      if (userExists.rows.length > 0) {
        return res.status(409).json({ error: `User "${owner}" already exists` });
      }
      await pool.query(`CREATE USER ${ident(owner)} WITH PASSWORD $1`, [password]);
      let dbCreated = false;
      try {
        await pool.query(`CREATE DATABASE ${ident(database)} WITH OWNER ${ident(owner)}`);
        dbCreated = true;
        await pool.query(`GRANT ALL PRIVILEGES ON DATABASE ${ident(database)} TO ${ident(owner)}`);

        const dbPool = new Pool({
          host: VIP || nodes[0].ip,
          port: parseInt(PG_PORT),
          user: 'postgres',
          password: PG_PASS,
          database: database,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 1000,
          max: 1,
        });
        try {
          await dbPool.query(`GRANT ALL ON SCHEMA public TO ${ident(owner)}`);
          await dbPool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT ALL ON TABLES TO ${ident(owner)}`);
          await dbPool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT ALL ON SEQUENCES TO ${ident(owner)}`);
        } finally {
          await dbPool.end();
        }
      } catch (innerErr) {
        try {
          if (dbCreated) await pool.query(`DROP DATABASE ${ident(database)}`);
          await pool.query(`DROP ROLE ${ident(owner)}`);
        } catch {}
        throw innerErr;
      }
      res.json({ status: 'created', database, owner });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/databases/:name
  router.get('/databases/:name', async (req, res) => {
    const { name } = req.params;
    if (!DB_NAME_REGEX.test(name)) {
      return res.status(400).json({ error: 'Invalid database name' });
    }
    if (SYSTEM_DB_NAMES.has(name)) {
      return res.status(400).json({ error: `"${name}" is a system database` });
    }
    try {
      const [dbRow, statRow] = await Promise.all([
        pool.query(`
          SELECT d.datname, pg_database_size(d.datname) AS size_bytes,
                 pg_encoding_to_char(d.encoding) AS encoding,
                 d.datcollate AS collation, d.datctype AS ctype,
                 r.rolname AS owner, age(d.datfrozenxid) AS xid_age
          FROM pg_database d
          JOIN pg_roles r ON r.oid = d.datdba
          WHERE d.datname = $1
        `, [name]),
        pool.query(`
          SELECT numbackends, xact_commit, xact_rollback,
                 blks_hit, blks_read, deadlocks
          FROM pg_stat_database WHERE datname = $1
        `, [name]),
      ]);
      if (dbRow.rows.length === 0) {
        return res.status(404).json({ error: `Database "${name}" not found` });
      }

      const dbPool = getDbPool(name, VIP || nodes[0].ip, PG_PORT, 'postgres', PG_PASS);
      let objectRow = { table_count: 0, index_count: 0, dead_tup_sum: 0, last_autovacuum: null };
      const [classRes, vacRes] = await Promise.all([
        dbPool.query(`
          SELECT
            COUNT(*) FILTER (WHERE relkind = 'r') AS table_count,
            COUNT(*) FILTER (WHERE relkind = 'i') AS index_count
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        `),
        dbPool.query(`
          SELECT COALESCE(SUM(n_dead_tup), 0) AS dead_tup_sum,
                 MAX(last_autovacuum) AS last_autovacuum
          FROM pg_stat_user_tables
        `),
      ]);
      objectRow = {
        table_count: parseInt(classRes.rows[0].table_count),
        index_count: parseInt(classRes.rows[0].index_count),
        dead_tup_sum: parseInt(vacRes.rows[0].dead_tup_sum),
        last_autovacuum: vacRes.rows[0].last_autovacuum,
      };

      const db = dbRow.rows[0];
      const stat = statRow.rows[0] || {};
      res.json({
        datname: db.datname,
        size_bytes: parseInt(db.size_bytes),
        encoding: db.encoding,
        collation: db.collation,
        ctype: db.ctype,
        owner: db.owner,
        xid_age: parseInt(db.xid_age),
        numbackends: parseInt(stat.numbackends || 0),
        xact_commit: parseInt(stat.xact_commit || 0),
        xact_rollback: parseInt(stat.xact_rollback || 0),
        blks_hit: parseInt(stat.blks_hit || 0),
        blks_read: parseInt(stat.blks_read || 0),
        deadlocks: parseInt(stat.deadlocks || 0),
        ...objectRow,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
        const data = await fetchJSON(`${SELF_PROTO}://${node.ip}:${PORT}/api/system/local`);
        return { name: node.name, ip: node.ip, ...(data || { hostname: node.name, error: true }) };
      })
    );
    res.json(results);
  });

  // GET /api/config
  router.get('/config', (req, res) => {
    res.json({ cluster_name: CLUSTER_NAME, node_count: nodes.length, pg_port: PG_PORT, vip: VIP, monitor_port: PORT, nodes });
  });

  // GET /api/config/backup — TrueNAS-style full config backup (tar.gz, credentials included)
  router.get('/config/backup', async (req, res) => {
    const { execFileSync } = require('child_process');
    const confPath = ctx.confPath;
    if (!fs.existsSync(confPath)) return res.status(404).json({ error: 'cluster.conf not found' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cluster-backup-'));
    try {
      // Collect Patroni configs from all reachable nodes
      const patroniConfigs = {};
      for (const node of nodes) {
        try {
          const data = await fetchJSON(`https://${node.ip}:8008/config`, 5000, pAuth());
          patroniConfigs[node.name] = data || { error: 'unreachable' };
        } catch { patroniConfigs[node.name] = { error: 'unreachable' }; }
      }

      // Write bundle files
      fs.writeFileSync(path.join(tmpDir, 'cluster.conf'), fs.readFileSync(confPath, 'utf8'));

      const auth = require('../middleware/auth');
      if (auth.AUTH_PATH && fs.existsSync(auth.AUTH_PATH)) {
        fs.writeFileSync(path.join(tmpDir, 'auth.json'), fs.readFileSync(auth.AUTH_PATH, 'utf8'));
      }

      fs.writeFileSync(path.join(tmpDir, 'patroni-configs.json'), JSON.stringify(patroniConfigs, null, 2));

      const versionFile = path.join(__dirname, '..', '..', 'VERSION');
      const LOCAL_VERSION = fs.existsSync(versionFile)
        ? fs.readFileSync(versionFile, 'utf8').trim()
        : 'unknown';
      fs.writeFileSync(path.join(tmpDir, 'backup-meta.json'), JSON.stringify({
        generator: 'pg-cluster-monitor',
        version: LOCAL_VERSION,
        timestamp: new Date().toISOString(),
        cluster_name: CLUSTER_NAME,
        node_count: nodes.length,
      }, null, 2));

      const date = new Date().toISOString().slice(0, 10);
      const tarName = `cluster-${CLUSTER_NAME}-${date}.tar.gz`;
      const tarPath = path.join(os.tmpdir(), tarName);
      execFileSync('tar', ['-czf', tarPath, '-C', tmpDir, '.'], { timeout: 15000 });

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${tarName}"`);
      const stream = fs.createReadStream(tarPath);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(tarPath); } catch {}
      });
    } finally {
      try { execFileSync('rm', ['-rf', tmpDir], { timeout: 5000 }); } catch {}
    }
  });

  // POST /api/config/restore — upload a cluster backup tar.gz and restore
  router.post('/config/restore', require('express').raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
    const { execFileSync } = require('child_process');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No file uploaded or wrong Content-Type (expected application/octet-stream)' });
    }
    if (restoreInProgress) {
      return res.status(409).json({ error: 'A restore is already in progress' });
    }
    restoreInProgress = true;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-restore-'));
    const tarPath = path.join(tmpDir, 'restore.tar.gz');
    try {
      fs.writeFileSync(tarPath, req.body);

      // Check for path traversal before extracting
      let entries;
      try {
        entries = execFileSync('tar', ['-tzf', tarPath], { timeout: 5000 }).toString().trim().split('\n');
      } catch {
        restoreInProgress = false;
        return res.status(400).json({ error: 'Invalid archive — could not read tar.gz' });
      }
      const unsafe = entries.find(e => e.includes('..') || path.isAbsolute(e));
      if (unsafe) {
        restoreInProgress = false;
        return res.status(400).json({ error: 'Invalid archive — contains unsafe path' });
      }

      try {
        execFileSync('tar', ['--no-same-owner', '--no-overwrite-dir', '-xzf', tarPath, '-C', tmpDir], { timeout: 15000 });
      } catch {
        restoreInProgress = false;
        return res.status(400).json({ error: 'Invalid archive — could not extract tar.gz' });
      }

      // Validate it's a pg-cluster backup
      const metaPath = path.join(tmpDir, 'backup-meta.json');
      if (!fs.existsSync(metaPath)) {
        return res.status(400).json({ error: 'Invalid backup file — missing backup-meta.json' });
      }
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {
        return res.status(400).json({ error: 'Invalid backup file — backup-meta.json is not valid JSON' });
      }
      if (meta.generator !== 'pg-cluster-monitor') {
        return res.status(400).json({ error: 'Invalid backup file — not a pg-cluster-monitor backup' });
      }

      const confPath = ctx.confPath;
      const auth = require('../middleware/auth');

      // Pre-restore safety copy
      const safetyDir = path.join(os.tmpdir(), `pg-cluster-pre-restore-${Date.now()}`);
      fs.mkdirSync(safetyDir, { recursive: true });
      if (fs.existsSync(confPath)) fs.copyFileSync(confPath, path.join(safetyDir, 'cluster.conf'));
      if (auth.AUTH_PATH && fs.existsSync(auth.AUTH_PATH)) fs.copyFileSync(auth.AUTH_PATH, path.join(safetyDir, 'auth.json'));

      // Apply restored files
      const restoredConf = path.join(tmpDir, 'cluster.conf');
      const restoredAuth = path.join(tmpDir, 'auth.json');
      if (fs.existsSync(restoredConf)) fs.copyFileSync(restoredConf, confPath);
      if (fs.existsSync(restoredAuth) && auth.AUTH_PATH) fs.copyFileSync(restoredAuth, auth.AUTH_PATH);

      ctx.reloadConf();

      restoreInProgress = false;
      res.json({ status: 'restarting', message: 'Config restored. Service restarting in 3s.', delay: 10, safety_backup: safetyDir });
      res.on('finish', () => {
        setTimeout(() => {
          require('child_process').spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], { detached: true, stdio: 'ignore' }).unref();
        }, 3000);
      });
    } catch (err) {
      restoreInProgress = false;
      throw err;
    } finally {
      try { execFileSync('rm', ['-rf', tmpDir], { timeout: 5000 }); } catch {}
    }
  });

  // GET /api/config/join-config — generate a join-config.json for adding a new node
  router.get('/config/join-config', (req, res) => {
    const conf = ctx.conf;
    const { node_ip, node_name, node_number } = req.query;
    if (!node_ip || !node_name || !node_number) {
      return res.status(400).json({ error: 'node_ip, node_name, and node_number are required' });
    }
    const num = parseInt(node_number, 10);
    if (isNaN(num) || num < 1) {
      return res.status(400).json({ error: 'node_number must be a positive integer' });
    }
    const ipParts = node_ip.split('.');
    if (ipParts.length !== 4 || ipParts.some(p => {
      const n = parseInt(p, 10);
      return isNaN(n) || n < 0 || n > 255 || String(n) !== p;
    })) {
      return res.status(400).json({ error: 'node_ip must be a valid IPv4 address' });
    }
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/.test(node_name)) {
      return res.status(400).json({ error: 'node_name must be a valid hostname (letters, digits, hyphens, dots)' });
    }

    const etcdPeers = nodes.map(n => n.ip);

    const joinConfig = {
      mode: 'join',
      cluster_name: CLUSTER_NAME,
      this_node: num,
      this_node_name: node_name,
      this_node_ip: node_ip,
      etcd_peers: etcdPeers,
      patroni_api_user: conf.PATRONI_API_USER || '',
      patroni_api_pass: conf.PATRONI_API_PASS || '',
      pg_repl_pass: conf.PG_REPLICATOR_PASS || '',
      pg_superuser_pass: conf.PG_SUPERUSER_PASS || '',
      pg_admin_pass: conf.PG_ADMIN_PASS || '',
      internal_secret: conf.INTERNAL_SECRET || '',
      pg_port: conf.PG_PORT || '5432',
      pg_version: conf.PG_VERSION || '17',
      pg_data_dir: conf.PG_DATA_DIR || '',
      pg_bin_dir: conf.PG_BIN_DIR || '',
      pg_max_conn: conf.PG_MAX_CONN || '200',
      pg_hba_subnet: conf.PG_HBA_SUBNET || '',
      etcd_token: conf.ETCD_TOKEN || '',
      enable_vip: conf.ENABLE_VIP || 'false',
      vip_address: conf.VIP_ADDRESS || '',
      vip_netmask: conf.VIP_NETMASK || '24',
      vip_interface: conf.VIP_INTERFACE || '',
      monitor_port: conf.MONITOR_PORT || '8080',
    };

    res.setHeader('Content-Disposition', `attachment; filename="join-config-node-${num}.json"`);
    res.json(joinConfig);
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
          const r = internalLib.request({ hostname: node.ip, port: PORT, path: '/api/restart/local', method: 'POST', timeout: 60000, ...internalOpts, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': conf.INTERNAL_SECRET || '' } }, (resp) => {
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
          const r = internalLib.request({ hostname: node.ip, port: PORT, path: '/api/restart/monitor', method: 'POST', timeout: 15000, ...internalOpts, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': conf.INTERNAL_SECRET || '' } }, (resp) => {
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
