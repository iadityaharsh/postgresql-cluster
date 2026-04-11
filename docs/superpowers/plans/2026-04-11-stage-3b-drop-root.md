# Stage 3b: Drop Dashboard to Non-Root — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the pg-monitor dashboard as `postgres` instead of root. All shell commands that need root get a sudoers allowlist and `sudo` prefix.

**Architecture:** The systemd unit gains `User=postgres` / `Group=postgres`. A sudoers drop-in at `/etc/sudoers.d/pg-monitor` grants `postgres` passwordless access to specific `systemctl`, `mount`, `mountpoint`, and `bash <script>` commands. Every `spawn`/`execSync` call in the Express app that invokes a privileged command is prefixed with `sudo` (or `sudo` is prepended to the argv array). The fixes doc's sudoers has wildcards like `systemctl stop *` — the spec explicitly requires replacing those with exact full-argument forms to prevent argv injection.

**Tech Stack:** systemd, sudoers, bash, Node `child_process.spawn`/`execSync`.

**Source spec:** `docs/superpowers/specs/2026-04-11-remediation-plan-design.md` (risk gate 3b)
**Source fixes doc:** `postgresql-cluster-fixes.md` §3.5
**Stage-closing commit message (3b half):** `fix: drop dashboard to non-root with sudoers policy`

**RISK GATE:** This is the highest-risk commit in the remediation. All six checks from the spec must pass on a throwaway/test environment before this commit lands. If any check fails, **revert 3b before diagnosing** — do not chain fixes on a broken 3b.

---

## Preflight

- [ ] **Step 0.1: Confirm Stage 3a is complete and branch is clean**

Run:
```bash
cd /home/adityaharsh/applications/postgresql-cluster
git status
git log --oneline $(git merge-base main HEAD)..HEAD | head -25
(cd web && npm test)
bats tests/
```
Expected: working tree clean; 19 commits visible (8+7+4); all tests green.

---

## Task 1: Write the sudoers policy

**Files:**
- Modify: `scripts/setup-monitor.sh`

- [ ] **Step 1.1: Add the sudoers drop-in before the systemd unit**

In `scripts/setup-monitor.sh`, locate the section between `npm install` and `# Create systemd service` (around lines 44–46):
```bash
cd /opt/pg-monitor
npm install --production --silent 2>/dev/null

# Create systemd service
```

Insert between them:
```bash
# Grant postgres user limited sudo for service management
# IMPORTANT: no wildcards — each command is fully specified to prevent argv injection
cat > /etc/sudoers.d/pg-monitor << 'SUDOEOF'
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart pg-monitor
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart cloudflared
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop cloudflared
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start cloudflared
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-enabled *
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-active *
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload
postgres ALL=(ALL) NOPASSWD: /usr/bin/mount /mnt/pg-backup
postgres ALL=(ALL) NOPASSWD: /usr/bin/mount -a
postgres ALL=(ALL) NOPASSWD: /usr/bin/mountpoint -q /mnt/pg-backup
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemd-detect-virt --container
postgres ALL=(ALL) NOPASSWD: /usr/bin/apt-get update*
postgres ALL=(ALL) NOPASSWD: /usr/bin/apt-get install*
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-backup/pg-backup.sh
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-monitor/scripts/setup-tunnel.sh *
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-monitor/scripts/setup-backup.sh
postgres ALL=(ALL) NOPASSWD: /usr/bin/borg *
postgres ALL=(ALL) NOPASSWD: /usr/bin/psql *
SUDOEOF
chmod 440 /etc/sudoers.d/pg-monitor

# Ensure postgres owns the app directory
chown -R postgres:postgres /opt/pg-monitor
```

Note on `is-enabled *` and `is-active *`: these read-only systemctl subcommands are safe to allow with wildcards because they only query state and cannot modify services. The restart/stop/start entries are fully specified per-service.

- [ ] **Step 1.2: Add `User=postgres` to the systemd unit**

In the same file, replace the systemd service heredoc:
```bash
cat > /etc/systemd/system/pg-monitor.service << EOF
[Unit]
Description=PostgreSQL Cluster Monitor
After=network.target patroni.service

[Service]
Type=simple
WorkingDirectory=/opt/pg-monitor
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=MONITOR_PORT=${MONITOR_PORT}

[Install]
WantedBy=multi-user.target
EOF
```

Replace with:
```bash
cat > /etc/systemd/system/pg-monitor.service << EOF
[Unit]
Description=PostgreSQL Cluster Monitor
After=network.target patroni.service

[Service]
Type=simple
User=postgres
Group=postgres
WorkingDirectory=/opt/pg-monitor
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=MONITOR_PORT=${MONITOR_PORT}

[Install]
WantedBy=multi-user.target
EOF
```

- [ ] **Step 1.3: Syntax + shellcheck**

Run:
```bash
bash -n scripts/setup-monitor.sh
shellcheck scripts/setup-monitor.sh
```
Expected: clean.

- [ ] **Step 1.4: Commit**

```bash
git add scripts/setup-monitor.sh
git commit -m "Add sudoers policy and User=postgres to pg-monitor systemd unit"
```

---

## Task 2: Prefix all privileged `spawn`/`execSync` calls with `sudo`

**Files:**
- Modify: `web/src/app.js`
- Modify: `web/src/routes/cluster.js`
- Modify: `web/src/routes/backup.js`
- Modify: `web/src/routes/cloudflare.js`

This is the bulk of the change. Every `spawn` or `execSync` call that runs a command requiring root must be prefixed. There are ~30 call sites. The spec explicitly requires argv form (`spawn('sudo', ['systemctl', ...])`) over shell-string form (`spawn('bash', ['-c', 'sudo mount ...'])`).

- [ ] **Step 2.1: Update `web/src/app.js`**

Each change below corresponds to a specific line from the spawn/execSync grep output. Apply all changes in the file.

**Line ~252: `spawn('systemctl', ['restart', 'pg-monitor'], ...)`**
Change to: `spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], ...)`

**Line ~262: same pattern (inside `res.on('finish', ...)`)**
Change to: `spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], ...)`

**Line ~259: upgrade/apply `spawn('bash', ['-c', ...])`**
This runs git + bash as a privileged deploy. Change `cmd = 'bash'` to `cmd = 'sudo'` and adjust the args:
```js
const child = spawn('sudo', ['bash', '-c', `cd ${repoDir} && git fetch origin --tags -f 2>&1 && git pull origin main 2>&1 && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1`], { stdio: 'ignore', detached: true, env: { ...process.env, PG_DASHBOARD_UPGRADE: '1' } });
```

**Line ~210–213: `runLocalUpdate` function**
The `cmd` and `args` variables already fork between cloned-from-scratch and existing-repo paths. In both cases, prepend `sudo`:
```js
if (!repoDir) {
  cmd = 'sudo'; args = ['bash', '-c', 'cd /root && [ ! -d postgresql-cluster/.git ] && rm -rf postgresql-cluster; git clone https://github.com/iadityaharsh/postgresql-cluster.git 2>&1 && cd postgresql-cluster && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1'];
} else {
  cmd = 'sudo'; args = ['bash', '-c', `cd ${repoDir} && git fetch origin --tags -f 2>&1 && git pull origin main 2>&1 && PG_DASHBOARD_UPGRADE=1 PG_UPDATE_PHASE=deploy bash update.sh 2>&1`];
}
```

**Line ~278: `execSync('systemctl is-active mnt-pg...')`**
Change to: `require('child_process').execSync('sudo systemctl is-active mnt-pg\\\\x2dbackup.automount 2>/dev/null || echo inactive', ...)`

**Line ~280: `execSync('mountpoint -q /mnt/pg-backup ...')`**
Change to: `require('child_process').execSync('sudo mountpoint -q /mnt/pg-backup 2>/dev/null && echo yes || echo no', ...)`

**Line ~287: `spawn('bash', ['-c', 'mount /mnt/pg-backup ...')`**
Change to: `spawn('sudo', ['bash', '-c', 'mount /mnt/pg-backup 2>&1 || mount -a 2>&1'], ...)`

**Line ~290: `execSync('mountpoint -q /mnt/pg-backup ...')` (inside child.on close)**
Change to: `require('child_process').execSync('sudo mountpoint -q /mnt/pg-backup && echo yes || echo no', ...)`

**Line ~297: `spawn('bash', ['-c', 'command -v showmount ... apt-get install ...' ])`**
Change to: `spawn('sudo', ['bash', '-c', \`command -v showmount >/dev/null 2>&1 || apt-get install -y -qq nfs-common >/dev/null 2>&1; showmount -e ${server} --no-headers 2>&1\`], ...)`

**Line ~318: `spawn('bash', [script], ...)`** (setup-backup.sh)
Change to: `spawn('sudo', ['bash', script], ...)`

**Line ~336: `spawn('bash', [backupScript], ...)`** (/api/storage/apply)
Change to: `spawn('sudo', ['bash', backupScript], ...)`

- [ ] **Step 2.2: Update `web/src/routes/cluster.js`**

**Line ~220: `execSync(\`systemctl is-enabled ${svc} ...\`)`**
Change to: `require('child_process').execSync(\`sudo systemctl is-enabled ${svc} 2>/dev/null\`, ...)`

**Line ~221: `execSync(\`systemctl restart ${svc}\`, ...)`**
Change to: `require('child_process').execSync(\`sudo systemctl restart ${svc}\`, ...)`

**Line ~279: `spawn('systemctl', ['restart', 'pg-monitor'], ...)`**
Change to: `spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], ...)`

**Line ~286: same pattern**
Change to: `spawn('sudo', ['systemctl', 'restart', 'pg-monitor'], ...)`

- [ ] **Step 2.3: Update `web/src/routes/backup.js`**

**Line ~17: `execFile('borg', args, ...)`** (in `runBorg`)
Change to: `execFile('sudo', ['borg', ...args], ...)`

Wait — `execFile('sudo', ['borg', ...args], ...)` requires adjusting the function signature. Better approach:

In the `runBorg` helper (lines 14–22):
```js
function runBorg(args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, BORG_PASSPHRASE: conf.BORG_PASSPHRASE || '', BORG_REPO };
      execFile('borg', args, { env, timeout }, (err, stdout, stderr) => {
```

Change to:
```js
function runBorg(args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, BORG_PASSPHRASE: conf.BORG_PASSPHRASE || '', BORG_REPO };
      execFile('sudo', ['-E', 'borg', ...args], { env, timeout }, (err, stdout, stderr) => {
```

The `-E` flag preserves the environment (so `BORG_PASSPHRASE` is passed through sudo to borg).

**Line ~50: `spawn('bash', [BACKUP_SCRIPT], ...)`**
Change to: `spawn('sudo', ['bash', BACKUP_SCRIPT], ...)`

**Line ~80: `spawn('borg', ['extract', '--stdout', ...])`**
Change to: `spawn('sudo', ['-E', 'borg', 'extract', '--stdout', \`${BORG_REPO}::${archive}\`], { env })`

**Line ~81: `spawn('psql', ['-h', host, ...])`**
Change to: `spawn('sudo', ['-E', 'psql', '-h', host, '-p', PG_PORT, '-U', 'postgres', '-f', '-'], { env })`

**Line ~116: `execSync('systemd-detect-virt --container ...')`**
Change to: `require('child_process').execSync('sudo systemd-detect-virt --container 2>/dev/null || true', ...)`

**Line ~131: `execSync('systemctl is-active mnt-pg...')`**
Change to: `require('child_process').execSync('sudo systemctl is-active mnt-pg\\\\x2dbackup.automount 2>/dev/null || echo inactive', ...)`

**Line ~134: `execSync('mountpoint -q /mnt/pg-backup ...')`**
Change to: `require('child_process').execSync('sudo mountpoint -q /mnt/pg-backup 2>/dev/null && echo yes || echo no', ...)`

- [ ] **Step 2.4: Update `web/src/routes/cloudflare.js`**

**Line ~83: `execSync('cloudflared --version 2>&1')`**
`cloudflared --version` is readable by any user — no sudo needed. Skip.

**Line ~87: `execSync('systemctl is-active cloudflared ...')`**
Change to: `require('child_process').execSync('sudo systemctl is-active cloudflared 2>/dev/null', ...)`

**Line ~111: `spawn('bash', [scriptPath, token], ...)`**
Change to: `spawn('sudo', ['bash', scriptPath, token], ...)`

**Line ~189: `spawn('bash', [scriptPath, token], ...)`** (detached)
Change to: `spawn('sudo', ['bash', scriptPath, token], ...)`

**Line ~349: `execSync('command -v wrangler ...')`**
This just checks for a binary in PATH — no privilege needed. Skip.

- [ ] **Step 2.5: Verify all files parse**

Run:
```bash
cd web && node -c src/app.js && node -c src/routes/cluster.js && node -c src/routes/backup.js && node -c src/routes/cloudflare.js
```
Expected: no output (clean).

- [ ] **Step 2.6: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass. The existing tests run without root anyway, so `sudo` in spawn calls just means the spawn target changes — in the test env, these calls are never actually invoked (health check tests, etc. don't trigger privileged paths).

- [ ] **Step 2.7: Grep for any missed unprefixed privileged calls**

Run:
```bash
grep -n "spawn('systemctl'" web/src/app.js web/src/routes/*.js
grep -n "spawn('bash'" web/src/app.js web/src/routes/*.js
grep -n "execSync('systemctl " web/src/app.js web/src/routes/*.js
grep -n "execSync('mount" web/src/app.js web/src/routes/*.js
grep -n "execFile('borg'" web/src/routes/backup.js
```
Expected: no matches. Every call should now go through `sudo`.

Also confirm nothing calls `spawn('bash', ['-c', ...)` with shell-string sudo (we want argv form):
```bash
grep -n "spawn('bash'.*sudo" web/src/app.js web/src/routes/*.js
```
Expected: no matches (we replaced those with `spawn('sudo', ['bash', ...])` form).

- [ ] **Step 2.8: Commit**

```bash
git add web/src/app.js web/src/routes/cluster.js web/src/routes/backup.js web/src/routes/cloudflare.js
git commit -m "fix: drop dashboard to non-root with sudoers policy

Stage 3b of the remediation plan. This is the stage-closing commit for
the second half of Stage 3 (risk-gated per spec).

- 3.5a sudoers policy and User=postgres in systemd unit (prev commit)
- 3.5b (this commit) prefix all privileged spawn/execSync calls with sudo

RISK GATE: all six manual checks from the spec must pass on a
throwaway environment before this commit is considered landed."
```

---

## Stage 3b Risk Gate

This MUST be verified on a **throwaway or test environment** before proceeding to Stage 4. Deploy the branch to the test environment and run:

- [ ] **Gate check 1:** `sudo -u postgres sudo systemctl restart pg-monitor` succeeds
- [ ] **Gate check 2:** Dashboard `POST /api/restart/local` returns 200 and the service actually restarts
- [ ] **Gate check 3:** A backup triggered via the dashboard runs to completion and produces a borg archive
- [ ] **Gate check 4:** `PG_DASHBOARD_UPGRADE=1 bash update.sh` runs to completion with the postgres-user dashboard
- [ ] **Gate check 5:** `journalctl -u pg-monitor -n 200` shows no permission errors
- [ ] **Gate check 6:** If any check fails, revert 3b immediately:
```bash
git revert HEAD HEAD~1
```
Do NOT chain additional fixes. Diagnose from a clean state.

---

## Stage 3b close-out

- [ ] **Step 3.1: Full regression sweep**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/*.sh configure.sh install.sh update.sh
```
Expected: all green.

- [ ] **Step 3.2: Final sanity check**

```bash
git log --oneline $(git merge-base main HEAD)..HEAD
```
Expected: 21 commits on the branch (8+7+4+2). The last commit is the Stage 3b stage-closing commit.

Stage 3b is complete. Proceed to Stage 4 only after the risk gate passes.
