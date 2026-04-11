# Stage 4: Backup Creation Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backup creation more reliable: disk space pre-check, reject empty passphrases, integrity verification after archive, proper cron file, log rotation (absorbs fix 6.5), and fix Patroni API auth in the backup script.

**Architecture:** All six fixes are changes to `scripts/pg-backup.sh` and `scripts/setup-backup.sh`. No Express or UI changes. No TDD tests — these are root-mutating scripts. Verification via `bash -n`, shellcheck, and targeted smoke tests.

**Tech Stack:** bash, borg, systemd cron, logrotate.

**Source spec:** `docs/superpowers/specs/2026-04-11-remediation-plan-design.md`
**Source fixes doc:** `postgresql-cluster-fixes.md` §4.1–4.6 (absorbs §6.5)
**Stage-closing commit message:** `fix: harden backup creation with space checks, encryption validation, integrity verification`

---

## Preflight

- [ ] **Step 0.1: Confirm Stage 3b is complete and branch is clean**

Run:
```bash
cd /home/adityaharsh/applications/postgresql-cluster
git status
git log --oneline $(git merge-base main HEAD)..HEAD | head -25
(cd web && npm test)
bats tests/
```
Expected: working tree clean; 21 commits on branch; all tests green.

---

## Task 1: Fix 4.1 — disk space pre-check in `pg-backup.sh`

**Files:**
- Modify: `scripts/pg-backup.sh` (before the pg_dumpall call, around line 88)

- [ ] **Step 1.1: Add the space check**

In `scripts/pg-backup.sh`, locate the block before pg_dumpall (around lines 86–89):
```bash
ARCHIVE_NAME="${CLUSTER_NAME}-$(date '+%Y-%m-%d_%H%M%S')"

# Run pg_dumpall first, then archive — so we catch connection failures before creating an archive
log "Running pg_dumpall on ${BACKUP_HOST}:${PG_PORT}..."
```

Insert between the `ARCHIVE_NAME` line and the `# Run pg_dumpall` comment:
```bash

# Pre-check: is there enough /tmp space for the dump?
log "Checking available disk space..."
ESTIMATED_SIZE=$(PGPASSWORD="${PG_SUPERUSER_PASS}" psql -h "${BACKUP_HOST}" -p "${PG_PORT}" -U postgres -t -c \
    "SELECT sum(pg_database_size(datname)) FROM pg_database WHERE datname NOT IN ('template0','template1');" 2>/dev/null | tr -d ' ')
AVAILABLE_SPACE=$(df --output=avail /tmp 2>/dev/null | tail -1 | tr -d ' ')

if [ -n "${ESTIMATED_SIZE}" ] && [ -n "${AVAILABLE_SPACE}" ]; then
    AVAILABLE_BYTES=$((AVAILABLE_SPACE * 1024))
    if [ "${AVAILABLE_BYTES}" -lt "${ESTIMATED_SIZE}" ]; then
        log "ERROR: Insufficient /tmp space for dump. Need ~$(numfmt --to=iec "${ESTIMATED_SIZE}"), have $(numfmt --to=iec "${AVAILABLE_BYTES}")."
        log "Tip: Set TMPDIR to a directory with more space."
        exit 1
    fi
    log "Space OK: ~$(numfmt --to=iec "${ESTIMATED_SIZE}") needed, $(numfmt --to=iec "${AVAILABLE_BYTES}") available."
fi
```

- [ ] **Step 1.2: Syntax + shellcheck**

Run:
```bash
bash -n scripts/pg-backup.sh
shellcheck scripts/pg-backup.sh
```
Expected: clean.

- [ ] **Step 1.3: Commit**

```bash
git add scripts/pg-backup.sh
git commit -m "Add disk space pre-check before pg_dumpall in backup script"
```

---

## Task 2: Fix 4.2 — reject empty `BORG_PASSPHRASE`

**Files:**
- Modify: `scripts/setup-backup.sh` (before borg init, around line 146)
- Modify: `scripts/pg-backup.sh` (after BORG_PASSPHRASE export, around line 83)

- [ ] **Step 2.1: Add the check in `setup-backup.sh`**

In `scripts/setup-backup.sh`, locate the borg init block (around lines 143–148):
```bash
    BORG_REPO="${MOUNT_POINT}/borg-repo"
    export BORG_PASSPHRASE="${BORG_PASSPHRASE:-}"
    if [ ! -d "${BORG_REPO}" ]; then
        echo "Initializing Borg repository (encrypted with repokey-blake2)..."
        borg init --encryption=repokey-blake2 "${BORG_REPO}"
```

Insert immediately before the `export BORG_PASSPHRASE` line:
```bash
    if [ -z "${BORG_PASSPHRASE:-}" ]; then
        echo "ERROR: BORG_PASSPHRASE is empty in cluster.conf."
        echo "Generate one with: openssl rand -base64 32"
        echo "Then add it to cluster.conf as BORG_PASSPHRASE=\"<value>\""
        exit 1
    fi
```

- [ ] **Step 2.2: Add the check in `pg-backup.sh`**

In `scripts/pg-backup.sh`, locate lines 83–84:
```bash
export BORG_PASSPHRASE="${BORG_PASSPHRASE:-}"
export BORG_REPO
```

Insert immediately after `export BORG_PASSPHRASE`:
```bash
if [ -z "${BORG_PASSPHRASE}" ]; then
    log "ERROR: BORG_PASSPHRASE is empty. Cannot access encrypted Borg repo."
    exit 1
fi
```

- [ ] **Step 2.3: Syntax + shellcheck**

Run:
```bash
bash -n scripts/setup-backup.sh scripts/pg-backup.sh
shellcheck scripts/setup-backup.sh scripts/pg-backup.sh
```
Expected: clean.

- [ ] **Step 2.4: Commit**

```bash
git add scripts/setup-backup.sh scripts/pg-backup.sh
git commit -m "Reject empty BORG_PASSPHRASE in backup and setup scripts"
```

---

## Task 3: Fix 4.3 — backup integrity verification

**Files:**
- Modify: `scripts/pg-backup.sh` (after the borg create block, around line 114)

- [ ] **Step 3.1: Add the borg check**

In `scripts/pg-backup.sh`, locate the line after borg create (around line 114):
```bash
log "Archive created: ${ARCHIVE_NAME}"
```

Insert immediately after:
```bash

# Verify the archive we just created
log "Verifying archive integrity..."
if borg check --archives-only --last 1 "${BORG_REPO}" 2>&1 | tee -a "${LOG_FILE}"; then
    log "Archive integrity verified."
else
    log "WARNING: Archive verification failed. The backup may be corrupted."
fi
```

- [ ] **Step 3.2: Syntax + shellcheck**

Run:
```bash
bash -n scripts/pg-backup.sh
shellcheck scripts/pg-backup.sh
```
Expected: clean.

- [ ] **Step 3.3: Commit**

```bash
git add scripts/pg-backup.sh
git commit -m "Verify backup archive integrity after borg create"
```

---

## Task 4: Fix 4.4 — use `/etc/cron.d/pg-backup` instead of appending to `/etc/crontab`

**Files:**
- Modify: `scripts/setup-backup.sh` (lines 174–182)

- [ ] **Step 4.1: Replace the cron setup block**

In `scripts/setup-backup.sh`, locate lines 174–182:
```bash
# Setup cron (only runs backup on the leader node)
CRON_SCHEDULE="${BACKUP_SCHEDULE:-0 2 * * *}"
CRON_LINE="${CRON_SCHEDULE} root /opt/pg-backup/pg-backup.sh >> /var/log/pg-backup.log 2>&1"

# Remove old cron entry if present
sed -i '/pg-backup/d' /etc/crontab 2>/dev/null || true

echo "${CRON_LINE}" >> /etc/crontab
echo "Cron job added: ${CRON_SCHEDULE}"
```

Replace with:
```bash
# Setup cron (only runs backup on the leader node)
CRON_SCHEDULE="${BACKUP_SCHEDULE:-0 2 * * *}"

# Clean up legacy crontab entry if present
sed -i '/pg-backup/d' /etc/crontab 2>/dev/null || true

# Use a dedicated cron file
cat > /etc/cron.d/pg-backup << CRONEOF
# PostgreSQL Borg Backup — managed by postgresql-cluster
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BORG_PASSPHRASE=${BORG_PASSPHRASE}
${CRON_SCHEDULE} root /opt/pg-backup/pg-backup.sh >> /var/log/pg-backup.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/pg-backup
echo "Cron file written to /etc/cron.d/pg-backup (schedule: ${CRON_SCHEDULE})"
```

- [ ] **Step 4.2: Syntax + shellcheck**

Run:
```bash
bash -n scripts/setup-backup.sh
shellcheck scripts/setup-backup.sh
```
Expected: clean.

- [ ] **Step 4.3: Commit**

```bash
git add scripts/setup-backup.sh
git commit -m "Use /etc/cron.d/pg-backup instead of appending to /etc/crontab"
```

---

## Task 5: Fix 4.5 — add logrotate (absorbs fix 6.5)

**Files:**
- Modify: `scripts/setup-backup.sh` (at the end, before the summary output)

- [ ] **Step 5.1: Add the logrotate block**

In `scripts/setup-backup.sh`, locate the summary block at the end (around lines 184–199):
```bash
echo ""
echo "--- Borg Backup setup complete ---"
```

Insert immediately before the summary:
```bash
# Install logrotate config
cat > /etc/logrotate.d/pg-backup << 'LOGEOF'
/var/log/pg-backup.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    create 640 root root
}
LOGEOF
```

- [ ] **Step 5.2: Syntax + shellcheck**

Run:
```bash
bash -n scripts/setup-backup.sh
shellcheck scripts/setup-backup.sh
```
Expected: clean.

- [ ] **Step 5.3: Commit**

```bash
git add scripts/setup-backup.sh
git commit -m "Add logrotate for pg-backup.log (absorbs fix 6.5)"
```

---

## Task 6: Fix 4.6 — fix Patroni API auth in backup script

**Files:**
- Modify: `scripts/pg-backup.sh` (lines 45–49)

The current code uses `curl -sf` which silently fails on 401. Fix: replace `-sf` with `-s --max-time 5` and keep the auth header logic.

- [ ] **Step 6.1: Replace the curl args block**

In `scripts/pg-backup.sh`, locate lines 45–49:
```bash
    CURL_ARGS=(-sf)
    if [ -n "${PATRONI_API_USER:-}" ] && [ -n "${PATRONI_API_PASS:-}" ]; then
        CURL_ARGS+=(-u "${PATRONI_API_USER}:${PATRONI_API_PASS}")
    fi
    CLUSTER_JSON=$(curl "${CURL_ARGS[@]}" "http://${NODE_IP}:8008/cluster" 2>/dev/null || true)
```

Replace with:
```bash
    CURL_ARGS=(-s --max-time 5)
    if [ -n "${PATRONI_API_USER:-}" ] && [ -n "${PATRONI_API_PASS:-}" ]; then
        CURL_ARGS+=(-u "${PATRONI_API_USER}:${PATRONI_API_PASS}")
    fi
    CLUSTER_JSON=$(curl "${CURL_ARGS[@]}" "http://${NODE_IP}:8008/cluster" 2>/dev/null || true)
```

- [ ] **Step 6.2: Syntax + shellcheck**

Run:
```bash
bash -n scripts/pg-backup.sh
shellcheck scripts/pg-backup.sh
```
Expected: clean.

- [ ] **Step 6.3: Stage-closing commit**

```bash
git add scripts/pg-backup.sh
git commit -m "fix: harden backup creation with space checks, encryption validation, integrity verification

Stage 4 of the remediation plan. This commit fixes Patroni API auth in the
backup script (curl -sf silently ignored 401s). Preceding commits in this
stage group:

- 4.1 disk space pre-check before pg_dumpall
- 4.2 reject empty BORG_PASSPHRASE in both scripts
- 4.3 borg check integrity verification after archive creation
- 4.4 use /etc/cron.d/pg-backup instead of /etc/crontab
- 4.5 logrotate for pg-backup.log (absorbs fix 6.5)
- 4.6 (this commit) fix Patroni API auth in backup script"
```

---

## Stage 4 close-out

- [ ] **Step 7.1: Full regression sweep**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/*.sh configure.sh install.sh update.sh
bash -n scripts/*.sh
```
Expected: all green.

- [ ] **Step 7.2: Final sanity check**

```bash
git log --oneline $(git merge-base main HEAD)..HEAD
```
Expected: 27 commits total (8+7+4+2+6). The last commit is the Stage 4 stage-closer.

Stage 4 is complete. Proceed to Stage 5 only after the above is green.
