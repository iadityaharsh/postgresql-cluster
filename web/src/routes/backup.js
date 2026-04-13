const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

module.exports = function createBackupRouter(ctx) {
  const router = express.Router();
  const { nodes, conf, VIP, PG_PORT, PG_PASS, PORT, findScript, confPath, reloadConf, updateConfKeys } = ctx;

  const BORG_REPO = '/mnt/pg-backup/borg-repo';
  const BACKUP_SCRIPT = '/opt/pg-backup/pg-backup.sh';

  function runBorg(args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, BORG_PASSPHRASE: conf.BORG_PASSPHRASE || '', BORG_REPO };
      execFile('sudo', ['-E', 'borg', ...args], { env, timeout }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  // GET /api/backups
  router.get('/', async (req, res) => {
    try {
      const output = await runBorg(['list', '--json', BORG_REPO]);
      const data = JSON.parse(output);
      const archives = (data.archives || []).map(a => ({ name: a.name, start: a.start, time: a.time || a.start, id: a.id })).reverse();
      res.json({ available: true, archives });
    } catch (err) {
      if (err.message.includes('No such file') || err.message.includes('not a valid')) {
        res.json({ available: false, archives: [], error: 'Borg repo not found. Run setup-backup.sh first.' });
      } else {
        res.json({ available: false, archives: [], error: err.message });
      }
    }
  });

  let backupTask = { running: false, log: [], exitCode: null, startTime: null };

  // POST /api/backups
  router.post('/', (req, res) => {
    if (backupTask.running) return res.status(409).json({ error: 'A backup is already running' });
    if (!fs.existsSync(BACKUP_SCRIPT)) return res.status(404).json({ error: 'Backup script not found. Run setup-backup.sh first.' });

    backupTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    backupTask.log.push(`[${new Date().toLocaleTimeString()}] Starting backup task...`);

    const child = spawn('sudo', ['bash', BACKUP_SCRIPT], {
      env: { ...process.env, BORG_PASSPHRASE: conf.BORG_PASSPHRASE || '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { backupTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
    child.stderr.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { backupTask.log.push(`[${new Date().toLocaleTimeString()}] ${line}`); }); });
    child.on('close', (code) => { backupTask.exitCode = code; backupTask.log.push(`[${new Date().toLocaleTimeString()}] ${code === 0 ? 'TASK OK' : `TASK ERROR (exit code ${code})`}`); backupTask.running = false; });
    child.on('error', (err) => { backupTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`); backupTask.exitCode = 1; backupTask.running = false; });

    res.json({ status: 'started', message: 'Backup started' });
  });

  // GET /api/backups/status
  router.get('/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: backupTask.running, exitCode: backupTask.exitCode, startTime: backupTask.startTime, log: backupTask.log.slice(since), totalLines: backupTask.log.length });
  });

  // POST /api/backups/restore
  let restoreTask = { running: false, log: [], exitCode: null, startTime: null };
  router.post('/restore', (req, res) => {
    const { archive, confirm } = req.body;
    if (!archive || !/^[\w.-]+$/.test(archive)) return res.status(400).json({ error: 'Invalid archive name' });
    if (!confirm) {
      return res.status(400).json({
        error: 'Restore requires explicit confirmation',
        warning: 'This will DROP and recreate all databases on the live production cluster. A pre-restore safety backup will be created automatically. Send { archive, confirm: true } to proceed.'
      });
    }
    if (restoreTask.running) return res.status(409).json({ error: 'A restore is already running' });

    const host = VIP || nodes[0].ip;
    const ts = () => new Date().toLocaleTimeString();
    restoreTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };

    res.json({ status: 'started', message: `Restoring ${archive} (with pre-restore safety backup)` });

    (async () => {
      const env = { ...process.env, BORG_PASSPHRASE: conf.BORG_PASSPHRASE || '', PGPASSWORD: PG_PASS };

      // Step 1: Create a safety backup before restoring
      restoreTask.log.push(`[${ts()}] Creating pre-restore safety backup...`);
      const safetyName = `pre-restore-${Date.now()}`;

      const safetyOk = await new Promise((resolve) => {
        const child = spawn('sudo', ['-E', 'bash', '-c',
          `pg_dumpall -h ${host} -p ${PG_PORT} -U postgres --clean | borg create --stdin-name pg_dumpall.sql --compression zstd,6 "${BORG_REPO}::${safetyName}" -`
        ], { env, timeout: 600000 });
        child.stderr.on('data', (data) => {
          data.toString().split('\n').filter(l => l.trim()).forEach(line => {
            restoreTask.log.push(`[${ts()}] safety: ${line}`);
          });
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });

      if (!safetyOk) {
        restoreTask.log.push(`[${ts()}] WARNING: Pre-restore safety backup failed. Proceeding anyway.`);
      } else {
        restoreTask.log.push(`[${ts()}] Safety backup created: ${safetyName}`);
      }

      // Step 2: Restore with progress reporting
      restoreTask.log.push(`[${ts()}] Starting restore of "${archive}" to ${host}...`);

      const { PassThrough } = require('stream');
      const meter = new PassThrough();
      let bytesProcessed = 0;
      const progressInterval = setInterval(() => {
        if (bytesProcessed > 0) {
          restoreTask.log.push(`[${ts()}] Progress: ${(bytesProcessed / 1024 / 1024).toFixed(0)} MB restored`);
        }
      }, 15000);

      const borgExtract = spawn('sudo', ['-E', 'borg', 'extract', '--stdout', `${BORG_REPO}::${archive}`], { env });
      const psqlRestore = spawn('sudo', ['-E', 'psql', '-h', host, '-p', PG_PORT, '-U', 'postgres', '-f', '-'], { env });

      meter.on('data', (chunk) => { bytesProcessed += chunk.length; });
      borgExtract.stdout.pipe(meter).pipe(psqlRestore.stdin);

      borgExtract.stderr.on('data', (data) => {
        data.toString().split('\n').filter(l => l.trim()).forEach(line => {
          restoreTask.log.push(`[${ts()}] borg: ${line}`);
        });
      });
      psqlRestore.stderr.on('data', (data) => {
        data.toString().split('\n').filter(l => l.trim()).forEach(line => {
          restoreTask.log.push(`[${ts()}] psql: ${line}`);
        });
      });

      borgExtract.on('error', (err) => {
        clearInterval(progressInterval);
        psqlRestore.kill();
        restoreTask.log.push(`[${ts()}] ERROR: borg extract failed: ${err.message}`);
        restoreTask.exitCode = 1;
        restoreTask.running = false;
      });

      borgExtract.on('close', (code) => {
        if (code !== 0) {
          clearInterval(progressInterval);
          psqlRestore.kill();
          restoreTask.log.push(`[${ts()}] ERROR: borg extract exited with code ${code}`);
          restoreTask.exitCode = code;
          restoreTask.running = false;
        }
      });

      psqlRestore.on('close', (code) => {
        clearInterval(progressInterval);
        restoreTask.exitCode = code;
        restoreTask.log.push(`[${ts()}] Restore ${code === 0 ? 'completed successfully' : `failed (exit code ${code})`}. ${(bytesProcessed / 1024 / 1024).toFixed(0)} MB total.`);
        if (safetyOk) {
          restoreTask.log.push(`[${ts()}] Safety backup available as: ${safetyName}`);
        }
        restoreTask.log.push(`[${ts()}] ${code === 0 ? 'TASK OK' : 'TASK ERROR'}`);
        restoreTask.running = false;
      });
    })();
  });

  router.get('/restore/status', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json({ running: restoreTask.running, exitCode: restoreTask.exitCode, startTime: restoreTask.startTime, log: restoreTask.log.slice(since), totalLines: restoreTask.log.length });
  });

  // GET /api/backups/:name
  router.get('/:name', async (req, res) => {
    try {
      const output = await runBorg(['info', '--json', `${BORG_REPO}::${req.params.name}`]);
      res.json(JSON.parse(output));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // DELETE /api/backups/:name
  router.delete('/:name', async (req, res) => {
    const name = req.params.name;
    if (!name || !/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid archive name' });
    try {
      await runBorg(['delete', `${BORG_REPO}::${name}`]);
      res.json({ message: `Archive ${name} deleted` });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Storage endpoints
  function isLxcContainer() {
    try {
      const virt = require('child_process').execSync('sudo systemd-detect-virt --container 2>/dev/null || true').toString().trim();
      if (virt === 'lxc') return true;
      if (fs.existsSync('/proc/1/environ')) {
        const env = fs.readFileSync('/proc/1/environ', 'utf8');
        if (env.includes('container=lxc')) return true;
      }
      return false;
    } catch { return false; }
  }

  router.get('/storage', (req, res) => {
    try {
      reloadConf();
      let mounted = false;
      try {
        const automountActive = require('child_process').execSync('sudo systemctl is-active mnt-pg\\\\x2dbackup.automount 2>/dev/null || echo inactive', { timeout: 3000 }).toString().trim() === 'active';
        if (automountActive) { mounted = true; }
        else if (fs.existsSync('/mnt/pg-backup')) {
          mounted = require('child_process').execSync('sudo mountpoint -q /mnt/pg-backup 2>/dev/null && echo yes || echo no', { timeout: 5000 }).toString().trim() === 'yes';
        }
      } catch {}
      res.json({
        enabled: conf.ENABLE_BACKUP === 'Y' || conf.ENABLE_BACKUP === 'y',
        type: conf.NFS_SERVER ? 'nfs' : (conf.SMB_SHARE ? 'smb' : 'none'),
        nfs_server: conf.NFS_SERVER || '', nfs_path: conf.NFS_PATH || '',
        smb_share: conf.SMB_SHARE || '', smb_user: conf.SMB_USER || '', smb_domain: conf.SMB_DOMAIN || '',
        schedule: conf.BACKUP_SCHEDULE || '0 2 * * *', retention: conf.BACKUP_LOCAL_RETENTION || '7',
        is_lxc: isLxcContainer(), mounted
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Note: additional storage endpoints (POST /api/storage, mount, nfs-exports, apply)
  // remain in server.js for now as they share the /api/storage prefix which overlaps
  // with /api/backups/storage. They are mounted separately.

  return router;
};
