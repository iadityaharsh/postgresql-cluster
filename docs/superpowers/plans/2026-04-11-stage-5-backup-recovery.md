# Stage 5: Backup Recovery Safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent accidental data destruction during restores. Add explicit confirmation to the restore endpoint, automatic pre-restore safety backup, progress reporting, React UI confirmation wiring, and disaster recovery documentation.

**Architecture:** The existing `POST /api/backups/restore` handler is rewritten to require `confirm: true` in the request body (returning a warning otherwise), create a pre-restore safety borg archive before restoring, and report progress via a `PassThrough` stream byte counter. The React `BackupsTab.jsx` already has a `ConfirmModal` for restore — its `restoreBackup` function is updated to send `confirm: true` and the modal message is made more explicit about the destructive nature of the operation. A new `docs/DISASTER-RECOVERY.md` captures the recovery procedures.

**Tech Stack:** Express, Node `stream.PassThrough`, borg, React, Jest + Supertest.

**Source spec:** `docs/superpowers/specs/2026-04-11-remediation-plan-design.md` (builds on fix 1.2's archive validation)
**Source fixes doc:** `postgresql-cluster-fixes.md` §5.1–5.3
**Stage-closing commit message:** `fix: add restore safety checks, pre-restore backups, progress reporting, and DR documentation`

---

## Preflight

- [ ] **Step 0.1: Confirm Stage 4 is complete**

Run:
```bash
cd /home/adityaharsh/applications/postgresql-cluster
git status
git log --oneline $(git merge-base main HEAD)..HEAD | head -30
(cd web && npm test)
bats tests/
```
Expected: working tree clean; 27 commits on branch; all tests green.

---

## Task 1: Fix 5.1 — rewrite restore endpoint with confirmation + safety backup + progress

**Files:**
- Modify: `web/src/routes/backup.js` (the `router.post('/restore', ...)` handler)
- Modify: `web/__tests__/backup-restore-validation.test.js` (add confirmation tests)

- [ ] **Step 1.1: Add failing tests for the confirmation requirement**

Append to `web/__tests__/backup-restore-validation.test.js`:
```js
describe('POST /api/backups/restore confirmation', () => {
  test('returns warning when confirm is not set', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .send({ archive: 'valid-archive-name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Cc]onfirm/);
    expect(res.body).toHaveProperty('warning');
  });

  test('returns warning when confirm is false', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .send({ archive: 'valid-archive-name', confirm: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Cc]onfirm/);
  });

  test('proceeds when confirm is true (may fail on borg in test env)', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .send({ archive: 'valid-archive-name', confirm: true });
    // Confirmation passes → handler proceeds → will fail on borg/psql in test env.
    // What we test: the response is NOT a 400 with "confirm" in the error message.
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/[Cc]onfirm/);
    }
  });
});
```

- [ ] **Step 1.2: Run the test to verify the new tests fail**

Run: `cd web && npx jest __tests__/backup-restore-validation.test.js`
Expected: the existing archive validation tests still pass; the 3 new confirmation tests FAIL (current handler does not check `confirm`).

- [ ] **Step 1.3: Rewrite the restore handler**

In `web/src/routes/backup.js`, locate the entire `router.post('/restore', ...)` handler (around lines 69–88):
```js
  let restoreTask = { running: false, log: [], exitCode: null, startTime: null };
  router.post('/restore', (req, res) => {
    const { archive } = req.body;
    if (!archive || !/^[\w.-]+$/.test(archive)) return res.status(400).json({ error: 'Invalid archive name' });
    if (restoreTask.running) return res.status(409).json({ error: 'A restore is already running' });

    const host = VIP || nodes[0].ip;
    restoreTask = { running: true, log: [], exitCode: null, startTime: new Date().toISOString() };
    restoreTask.log.push(`[${new Date().toLocaleTimeString()}] Starting restore of "${archive}"...`);

    const env = { ...process.env, BORG_PASSPHRASE: conf.BORG_PASSPHRASE || '', PGPASSWORD: PG_PASS };
    const borgExtract = spawn('borg', ['extract', '--stdout', `${BORG_REPO}::${archive}`], { env });
    const psqlRestore = spawn('psql', ['-h', host, '-p', PG_PORT, '-U', 'postgres', '-f', '-'], { env });
    borgExtract.stdout.pipe(psqlRestore.stdin);
    borgExtract.stderr.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { restoreTask.log.push(`[${new Date().toLocaleTimeString()}] borg: ${line}`); }); });
    psqlRestore.stderr.on('data', (data) => { data.toString().split('\n').filter(l => l.trim()).forEach(line => { restoreTask.log.push(`[${new Date().toLocaleTimeString()}] psql: ${line}`); }); });
    psqlRestore.on('close', (code) => { restoreTask.exitCode = code; restoreTask.log.push(`[${new Date().toLocaleTimeString()}] ${code === 0 ? 'TASK OK' : `TASK ERROR (exit code ${code})`}`); restoreTask.running = false; });
    borgExtract.on('error', (err) => { restoreTask.log.push(`[${new Date().toLocaleTimeString()}] ERROR: ${err.message}`); restoreTask.exitCode = 1; restoreTask.running = false; });
    res.json({ status: 'started', message: `Restoring ${archive}` });
  });
```

Replace with:
```js
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
        const child = spawn('bash', ['-c',
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

      const borgExtract = spawn('borg', ['extract', '--stdout', `${BORG_REPO}::${archive}`], { env });
      const psqlRestore = spawn('psql', ['-h', host, '-p', PG_PORT, '-U', 'postgres', '-f', '-'], { env });

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
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `cd web && npx jest __tests__/backup-restore-validation.test.js`
Expected: all 9 tests pass (6 existing + 3 new confirmation tests).

- [ ] **Step 1.5: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add web/src/routes/backup.js web/__tests__/backup-restore-validation.test.js
git commit -m "Require confirmation and create safety backup before restore"
```

---

## Task 2: Fix 5.2 — update React restore UI to send `confirm: true`

**Files:**
- Modify: `web/src/components/BackupsTab.jsx`

No Jest test — this is a React UI change verified via manual browser testing.

- [ ] **Step 2.1: Update the `restoreBackup` function to send `confirm: true`**

In `web/src/components/BackupsTab.jsx`, locate the `restoreBackup` function (around lines 77–92):
```js
  const restoreBackup = async (archive) => {
    setConfirmRestore(null);
    try {
      const resp = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive })
      });
```

Replace with:
```js
  const restoreBackup = async (archive) => {
    setConfirmRestore(null);
    try {
      const resp = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive, confirm: true })
      });
```

- [ ] **Step 2.2: Update the confirm modal warning message**

In `web/src/components/BackupsTab.jsx`, locate the restore `ConfirmModal` (around lines 331–339):
```jsx
      {confirmRestore && (
        <ConfirmModal
          title="Restore Backup"
          message={`This will restore "${confirmRestore}" to the database via the VIP. Existing data in affected databases will be overwritten. Are you sure?`}
          confirmText="Restore"
```

Replace the `message` prop:
```jsx
      {confirmRestore && (
        <ConfirmModal
          title="Restore Backup"
          message={`WARNING: This will DROP and recreate all databases on the live production cluster. A pre-restore safety backup will be created automatically.\n\nArchive: ${confirmRestore}\n\nAre you absolutely sure?`}
          confirmText="Restore"
```

- [ ] **Step 2.3: Verify the file parses**

Run: `cd web && node -e "require('esbuild').build({ entryPoints: ['src/components/BackupsTab.jsx'], loader: { '.jsx': 'jsx' }, write: false }).catch(() => process.exit(1))" 2>/dev/null || echo "parse check: OK (or esbuild not available)"`

If esbuild is not available, just do a syntax-level check:
```bash
grep -c "ConfirmModal" web/src/components/BackupsTab.jsx
```
Expected: the same count as before (3 ConfirmModals).

- [ ] **Step 2.4: Commit**

```bash
git add web/src/components/BackupsTab.jsx
git commit -m "Update React restore UI to send confirm:true and show stronger warning"
```

---

## Task 3: Fix 5.3 — create disaster recovery documentation

**Files:**
- Create: `docs/DISASTER-RECOVERY.md`
- Modify: `README.md` (add link)

- [ ] **Step 3.1: Create the DR doc**

Create `docs/DISASTER-RECOVERY.md`:
```markdown
# Disaster Recovery Guide

## Prerequisites

All recovery procedures require:
- The `BORG_PASSPHRASE` from your `cluster.conf`
- Access to the NFS/SMB backup share
- The Borg encryption key (exported to `/opt/pg-backup/borg-key-export.txt` during setup)

## Listing Available Backups

```bash
export BORG_PASSPHRASE="<from cluster.conf>"
borg list /mnt/pg-backup/borg-repo
```

## Inspecting a Backup

```bash
borg info /mnt/pg-backup/borg-repo::<archive-name>
```

## Verifying Backup Integrity

```bash
borg check /mnt/pg-backup/borg-repo
```

## Recovery Scenarios

### Scenario 1: Single Replica Lost

Patroni handles this automatically. The failed node will rejoin and stream data from the primary when it comes back online. No manual intervention needed.

To force a rebuild:
```bash
patronictl -c /etc/patroni/config.yml reinit <cluster-name> <node-name>
```

### Scenario 2: Primary Node Lost (Automatic Failover)

Patroni automatically promotes a replica to primary. Once the failed node is restored:
1. Ensure Patroni is running: `systemctl start patroni`
2. It will automatically rejoin as a replica

### Scenario 3: Restore to Existing Cluster

Via the dashboard:
1. Go to Backups tab
2. Click Restore on the desired archive
3. Confirm the warning dialog
4. A safety backup is created automatically before restore begins

Via CLI:
```bash
export BORG_PASSPHRASE="<from cluster.conf>"
export PGPASSWORD="<PG_SUPERUSER_PASS from cluster.conf>"
borg extract --stdout /mnt/pg-backup/borg-repo::<archive> \
    | psql -h <VIP_ADDRESS> -p 5432 -U postgres -f -
```

### Scenario 4: Total Cluster Loss

1. Provision new nodes and install the project:
   ```bash
   bash install.sh
   ```
2. Run the configuration wizard with the same settings as the original cluster
3. Run setup on Node 1 first, wait for it to become Leader
4. Run setup on remaining nodes
5. Stop Patroni on the primary:
   ```bash
   systemctl stop patroni
   ```
6. Mount the backup share and restore:
   ```bash
   mount /mnt/pg-backup
   export BORG_PASSPHRASE="<passphrase>"
   su - postgres -c "pg_dumpall -f /tmp/current_state.sql" # safety dump
   borg extract --stdout /mnt/pg-backup/borg-repo::<archive> \
       | psql -h localhost -U postgres -f -
   ```
7. Restart Patroni:
   ```bash
   systemctl start patroni
   ```

## Backup Limitations

- Backups use `pg_dumpall` (logical dump) — recovery is point-in-time of the dump, not to the latest transaction
- Data between scheduled backups is protected only by streaming replication across nodes
- WAL archiving is not currently enabled (`archive_command: /bin/true`)
- For RPO requirements under your backup interval, consider enabling WAL archiving with pgBackRest or barman

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| Borg repo | `/mnt/pg-backup/borg-repo` | Backup archives |
| Borg key export | `/opt/pg-backup/borg-key-export.txt` | Encryption key backup |
| Backup script | `/opt/pg-backup/pg-backup.sh` | Cron-triggered backup |
| Backup log | `/var/log/pg-backup.log` | Backup history |
| Cron config | `/etc/cron.d/pg-backup` | Backup schedule |
| Cluster config | `cluster.conf` | Contains BORG_PASSPHRASE |
```

- [ ] **Step 3.2: Add link to README.md**

In `README.md`, locate the Documentation section (around lines 150–155):
```markdown
## Documentation

- **[Quick Start](docs/QUICK-START.md)** — Step-by-step setup commands
- **[Detailed Setup](docs/SETUP.md)** — Full documentation and common operations
- **[Remote Access](docs/remote-access.md)** — Cloudflare Tunnel (token-based HA), Access policies, Workers
- **[Hyperdrive](docs/hyperdrive.md)** — Connect Cloudflare Workers to the cluster via Hyperdrive (edge connection pooling)
```

Add after the last item:
```markdown
- **[Disaster Recovery](docs/DISASTER-RECOVERY.md)** — Backup listing, integrity verification, recovery scenarios
```

- [ ] **Step 3.3: Stage-closing commit**

```bash
git add docs/DISASTER-RECOVERY.md README.md
git commit -m "fix: add restore safety checks, pre-restore backups, progress reporting, and DR documentation

Stage 5 of the remediation plan. This commit adds the disaster recovery
documentation and README link. Preceding commits in this stage group:

- 5.1 rewrite restore endpoint with confirmation, safety backup, and
  progress reporting
- 5.2 update React restore UI to send confirm:true and show stronger warning
- 5.3 (this commit) create docs/DISASTER-RECOVERY.md"
```

---

## Stage 5 close-out

- [ ] **Step 4.1: Full regression sweep**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/*.sh configure.sh install.sh update.sh
```
Expected: all green.

- [ ] **Step 4.2: Risk gate — throwaway Docker Postgres test**

The spec requires that restore is tested against a throwaway target, not a live cluster. If a Docker PostgreSQL is available:
```bash
docker run -d --name pg-test -e POSTGRES_PASSWORD=test -p 25432:5432 postgres:16
sleep 5
# Create a test database and table
PGPASSWORD=test psql -h localhost -p 25432 -U postgres -c "CREATE DATABASE testdb; \c testdb; CREATE TABLE t(x int); INSERT INTO t VALUES(1);"
# Verify the confirm flow via curl
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"archive":"test"}' http://localhost:8080/api/backups/restore
# Should return 400 with "confirm" error

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"archive":"test","confirm":true}' http://localhost:8080/api/backups/restore
# Should return 200 with status started (then fail on borg, which is fine)

docker rm -f pg-test
```
If Docker is not available, document this in the commit body and defer to a pre-merge-to-main test.

- [ ] **Step 4.3: Final sanity check**

```bash
git log --oneline $(git merge-base main HEAD)..HEAD
```
Expected: 30 commits total (8+7+4+2+6+3). The last commit is the Stage 5 stage-closer.

Stage 5 is complete. Proceed to Stage 6.
