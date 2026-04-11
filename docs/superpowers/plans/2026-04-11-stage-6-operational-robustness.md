# Stage 6: Operational Robustness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix etcd rejoin state, replace per-request PG connection pools with a shared pool, and enable Patroni REST API over HTTPS. (Fixes 6.3 and 6.5 were already absorbed into Stages 2 and 4 respectively.)

**Architecture:** The etcd rejoin fix is a 3-line sed in `setup.sh` gated by `$ETCD_HAS_DATA`. The shared pool replaces three identical `new Pool({...})` calls in `cluster.js` with one at the router scope. The Patroni HTTPS fix adds TLS cert paths to `patroni.yml`, makes `fetchJSON` protocol-aware (`http` vs `https`), updates all Patroni API URLs to `https://`, and adds `-k` to the backup script's curl.

**Tech Stack:** bash, Node `https` module, `pg` Pool, Jest.

**Source spec:** `docs/superpowers/specs/2026-04-11-remediation-plan-design.md`
**Source fixes doc:** `postgresql-cluster-fixes.md` §6.1, 6.2, 6.4 (6.3 absorbed into 2.4, 6.5 absorbed into 4.5)
**Stage-closing commit message:** `fix: etcd rejoin state, shared PG pool, enable Patroni HTTPS`

---

## Preflight

- [ ] **Step 0.1: Confirm Stage 5 is complete**

Run:
```bash
cd /home/adityaharsh/applications/postgresql-cluster
git status
git log --oneline $(git merge-base main HEAD)..HEAD | head -35
(cd web && npm test)
bats tests/
```
Expected: working tree clean; 30 commits on branch; all tests green.

---

## Task 1: Fix 6.1 — set `ETCD_INITIAL_CLUSTER_STATE=existing` on re-join

**Files:**
- Modify: `scripts/setup.sh` (after the `process_template` call for etcd config, around line 199)

- [ ] **Step 1.1: Add the sed override**

In `scripts/setup.sh`, locate lines 198–200:
```bash
# Generate etcd config
process_template "${TEMPLATES_DIR}/etcd.env" "$NODE_NUM" > /etc/default/etcd
echo "etcd config written to /etc/default/etcd"
```

Insert immediately after:
```bash

# If re-joining (existing data), switch bootstrap mode
if [ "$ETCD_HAS_DATA" = true ] && [ "$FORCE" != true ]; then
    sed -i 's/ETCD_INITIAL_CLUSTER_STATE="new"/ETCD_INITIAL_CLUSTER_STATE="existing"/' /etc/default/etcd
    echo "Set ETCD_INITIAL_CLUSTER_STATE=existing (re-joining cluster)"
fi
```

- [ ] **Step 1.2: Syntax + shellcheck**

Run:
```bash
bash -n scripts/setup.sh
shellcheck scripts/setup.sh
```
Expected: clean.

- [ ] **Step 1.3: Commit**

```bash
git add scripts/setup.sh
git commit -m "Set ETCD_INITIAL_CLUSTER_STATE=existing when re-joining with data"
```

---

## Task 2: Fix 6.2 — shared PG connection pool in `cluster.js`

**Files:**
- Modify: `web/src/routes/cluster.js` (lines 10–12 for pool creation, lines 92–139 for the three endpoints)
- Modify: `web/server.js` (add graceful shutdown)
- Test: `web/__tests__/shared-pool.test.js` (new — lightweight structural test)

- [ ] **Step 2.1: Write a failing test**

Create `web/__tests__/shared-pool.test.js`:
```js
const request = require('supertest');
const { app } = require('../server');

describe('shared PG pool', () => {
  // These endpoints create a new Pool per request today. After the fix,
  // they share one pool. We can't easily test "it's the same pool" in
  // a unit test, but we CAN verify the endpoints still respond
  // correctly and don't crash when pg is unavailable.

  test('GET /api/databases returns array or empty on pg-unavailable', async () => {
    const res = await request(app).get('/api/databases');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  test('GET /api/replication returns array or empty', async () => {
    const res = await request(app).get('/api/replication');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  test('GET /api/connections returns object or empty', async () => {
    const res = await request(app).get('/api/connections');
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('by_state');
    }
  });
});
```

- [ ] **Step 2.2: Run the test — should pass (baseline)**

Run: `cd web && npx jest __tests__/shared-pool.test.js`
Expected: all 3 tests pass (they exercise the endpoints which already work — this is a regression guard).

- [ ] **Step 2.3: Replace per-request pools with a shared pool**

In `web/src/routes/cluster.js`, locate the module function body (line 10–12):
```js
module.exports = function createClusterRouter(ctx) {
  const router = express.Router();
  const { nodes, conf, fetchJSON, CLUSTER_NAME, VIP, PG_PORT, PG_PASS, PORT, PATRONI_API_USER, PATRONI_API_PASS, findScript } = ctx;
```

Insert immediately after the destructure:
```js

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
```

Then replace each of the three endpoint handlers:

**`GET /api/databases` (lines 92–106):**
Replace with:
```js
  router.get('/databases', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT datname, pg_database_size(datname) as size_bytes, numbackends as connections
        FROM pg_stat_database WHERE datname NOT IN ('template0', 'template1') ORDER BY datname
      `);
      res.json(result.rows);
    } catch { res.json([]); }
  });
```

**`GET /api/replication` (lines 108–123):**
Replace with:
```js
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
```

**`GET /api/connections` (lines 125–139):**
Replace with:
```js
  router.get('/connections', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT state, count(*) as count FROM pg_stat_activity GROUP BY state ORDER BY count DESC
      `);
      const max = await pool.query('SHOW max_connections');
      res.json({ by_state: result.rows, max_connections: parseInt(max.rows[0].max_connections) });
    } catch { res.json({ by_state: [], max_connections: 0 }); }
  });
```

Then, before `return router;` at the end of the function, add:
```js
  router._pool = pool;
```

- [ ] **Step 2.4: Add graceful shutdown to `web/server.js`**

In `web/server.js`, at the end of the file (after the `if (require.main === module)` block), add:
```js

process.on('SIGTERM', () => {
  process.exit(0);
});
```

- [ ] **Step 2.5: Run the test to verify it passes**

Run: `cd web && npx jest __tests__/shared-pool.test.js`
Expected: all 3 tests pass.

- [ ] **Step 2.6: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass.

- [ ] **Step 2.7: Commit**

```bash
git add web/src/routes/cluster.js web/server.js web/__tests__/shared-pool.test.js
git commit -m "Replace per-request PG pools with shared pool in cluster.js"
```

---

## Task 3: Fix 6.4a — add TLS cert paths to Patroni REST API template

**Files:**
- Modify: `templates/patroni.yml` (the `restapi` section, lines 5–10)
- Test: `tests/common.bats` (add snapshot test)

- [ ] **Step 3.1: Write a failing BATS test**

Append to `tests/common.bats`:
```bash
# ---- templates/patroni.yml: restapi TLS ----

@test "patroni.yml template has restapi TLS cert paths" {
    local t="$BATS_TEST_DIRNAME/../templates/patroni.yml"
    grep -q '  certfile: /etc/patroni/ssl/server.crt' "$t"
    grep -q '  keyfile: /etc/patroni/ssl/server.key' "$t"
}
```

- [ ] **Step 3.2: Run the test — expect it to fail**

Run: `bats tests/common.bats`
Expected: the new test FAILS (current restapi section has no certfile/keyfile).

- [ ] **Step 3.3: Add TLS cert paths to the template**

In `templates/patroni.yml`, locate the restapi section (lines 5–10):
```yaml
restapi:
  listen: {{NODE_IP}}:8008
  connect_address: {{NODE_IP}}:8008
  authentication:
    username: {{PATRONI_API_USER}}
    password: {{PATRONI_API_PASS}}
```

Replace with:
```yaml
restapi:
  listen: {{NODE_IP}}:8008
  connect_address: {{NODE_IP}}:8008
  authentication:
    username: {{PATRONI_API_USER}}
    password: {{PATRONI_API_PASS}}
  certfile: /etc/patroni/ssl/server.crt
  keyfile: /etc/patroni/ssl/server.key
```

- [ ] **Step 3.4: Run the BATS test**

Run: `bats tests/common.bats`
Expected: all tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add templates/patroni.yml tests/common.bats
git commit -m "Add TLS cert paths to Patroni REST API template"
```

---

## Task 4: Fix 6.4b — make `fetchJSON` protocol-aware and update all Patroni API URLs to HTTPS

**Files:**
- Modify: `web/src/app.js` (`fetchJSON` function, lines 73–85; all `http://...8008` URLs)
- Modify: `web/src/routes/cluster.js` (all `http://...8008` URLs; switchover `http.request` → `https.request`)
- Modify: `scripts/pg-backup.sh` (add `-k` to curl for self-signed certs)

- [ ] **Step 4.1: Make `fetchJSON` protocol-aware**

In `web/src/app.js`, locate `fetchJSON` (lines 73–85):
```js
  function fetchJSON(url, timeout = 3000, auth) {
    const opts = { timeout };
    if (auth) opts.headers = { 'Authorization': 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') };
    return new Promise((resolve) => {
      const req = http.get(url, opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
```

Replace with:
```js
  function fetchJSON(url, timeout = 3000, auth) {
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
```

`rejectUnauthorized: false` because the Patroni certs are self-signed (generated by `03-setup-patroni.sh`).

- [ ] **Step 4.2: Update Patroni API URLs in `web/src/app.js`**

Find the healthz endpoint (around line 98):
```js
      const cluster = await fetchJSON(`http://${nodes[0].ip}:8008/cluster`, 2000, pAuth);
```

Replace `http://` with `https://`:
```js
      const cluster = await fetchJSON(`https://${nodes[0].ip}:8008/cluster`, 2000, pAuth);
```

- [ ] **Step 4.3: Update Patroni API URLs in `web/src/routes/cluster.js`**

Search for `http://${node.ip}:8008` and `http://${nodes[0].ip}:8008` — there should be several occurrences (lines ~24, 29, 48, 158). Replace all with `https://`:

```bash
# Preview changes:
grep -n 'http://${node' web/src/routes/cluster.js
grep -n 'http://${nodes' web/src/routes/cluster.js
```

Each `http://` before `:8008` becomes `https://`.

- [ ] **Step 4.4: Update the switchover `http.request` to `https.request`**

In `web/src/routes/cluster.js`, locate the switchover request (around line 69):
```js
        const r = http.request({
          hostname: leaderNode.ip, port: 8008, path: '/switchover',
          method: 'POST', headers: switchHeaders, timeout: 15000
        }, (resp) => {
```

Replace with:
```js
        const r = https.request({
          hostname: leaderNode.ip, port: 8008, path: '/switchover',
          method: 'POST', headers: switchHeaders, timeout: 15000,
          rejectUnauthorized: false
        }, (resp) => {
```

Verify `https` is imported at the top of `cluster.js` — it already is (line 3).

- [ ] **Step 4.5: Add `-k` to curl in `pg-backup.sh`**

In `scripts/pg-backup.sh`, locate the CURL_ARGS (around line 45):
```bash
    CURL_ARGS=(-s --max-time 5)
```

Replace with:
```bash
    CURL_ARGS=(-s -k --max-time 5)
```

The `-k` flag accepts self-signed certs (matching the `rejectUnauthorized: false` pattern in Node).

Also update the URL in line 49 from `http://` to `https://`:
```bash
    CLUSTER_JSON=$(curl "${CURL_ARGS[@]}" "https://${NODE_IP}:8008/cluster" 2>/dev/null || true)
```

- [ ] **Step 4.6: Verify all files parse**

Run:
```bash
cd web && node -c src/app.js && node -c src/routes/cluster.js
bash -n scripts/pg-backup.sh
```
Expected: clean.

- [ ] **Step 4.7: Run the full test suite**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/pg-backup.sh
```
Expected: all tests pass.

- [ ] **Step 4.8: Stage-closing commit**

```bash
git add web/src/app.js web/src/routes/cluster.js scripts/pg-backup.sh
git commit -m "fix: etcd rejoin state, shared PG pool, enable Patroni HTTPS

Stage 6 of the remediation plan. This commit enables Patroni REST API
over HTTPS and updates all callers. Fixes 6.3 (vip-manager version
centralization) and 6.5 (logrotate) were absorbed into Stages 2 and 4.
Preceding commits in this stage group:

- 6.1 set ETCD_INITIAL_CLUSTER_STATE=existing on re-join
- 6.2 shared PG connection pool in cluster.js
- 6.4a TLS cert paths in patroni.yml template
- 6.4b (this commit) protocol-aware fetchJSON + HTTPS URLs everywhere"
```

---

## Stage 6 close-out

- [ ] **Step 5.1: Full regression sweep**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/*.sh configure.sh install.sh update.sh
bash -n scripts/*.sh configure.sh install.sh
```
Expected: all green.

- [ ] **Step 5.2: Final sanity check**

```bash
git log --oneline $(git merge-base main HEAD)..HEAD
```
Expected: 34 commits total (8+7+4+2+6+3+4). The last commit is the Stage 6 stage-closer.

Stage 6 is complete. Proceed to Stage 7.
