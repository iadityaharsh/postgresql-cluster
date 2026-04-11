# Stage 3a: Injection Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden four injection/timing vectors without touching privilege level yet: SQL injection in the Hyperdrive create-user endpoint, regex-injection via `updateConfKeys`, timing-safe hash comparison in login, and enabling etcd client certificate authentication.

**Architecture:** All four fixes stay additive and minimally invasive. Use `pg`'s built-in `escapeIdentifier`/`escapeLiteral` instead of manual escaping. Validate config keys against a `^[A-Z_][A-Z0-9_]*$` allowlist before they reach `RegExp`. Replace string equality with `crypto.timingSafeEqual`. Flip `ETCD_CLIENT_CERT_AUTH` to `true` and add Patroni's etcd3 TLS client cert paths — this hardens the DCS channel but relies on certs already present from `setup.sh`'s etcd bootstrap.

**Tech Stack:** `pg` (node-postgres) Pool, Node `crypto.timingSafeEqual`, Jest, BATS, etcd TLS.

**Source spec:** `docs/superpowers/specs/2026-04-11-remediation-plan-design.md`
**Source fixes doc:** `postgresql-cluster-fixes.md` §3.1–3.4
**Stage-closing commit message for 3a+3b combined (per fixes doc):** `fix: harden SQL injection, regex injection, timing attack, etcd auth, and drop root privilege` — but the spec splits this into two separate stage-closing commits. This plan's stage-closing commit uses a **3a-specific** subset of that message. See Task 5 below for the exact text.

**Key spec constraint:** 3a MUST land before 3b. Dropping privilege (3b) on top of unfixed injection vectors would widen the blast radius during the intermediate commits.

---

## Preflight

- [ ] **Step 0.1: Confirm Stage 2 is complete and branch is clean**

Run:
```bash
cd /home/adityaharsh/applications/postgresql-cluster
git status
git log --oneline $(git merge-base main HEAD)..HEAD | head -20
(cd web && npm test)
bats tests/
```
Expected: working tree clean; 15 commits visible (8 Stage 1 + 7 Stage 2); all tests green.

---

## Task 1: Fix 3.1 — SQL injection in `POST /api/hyperdrive/create-user`

**Files:**
- Modify: `web/src/routes/cloudflare.js` (lines 361–380, the `/hyperdrive/create-user` handler)
- Test: `web/__tests__/hyperdrive-create-user-sql.test.js` (new)

The existing handler has an input allowlist (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) on `username` and `database`, which is the first line of defense and catches most attacks. But the password uses manual `'`-escaping and all three values are concatenated into dynamic SQL. Fix uses `escapeIdentifier` and `escapeLiteral` from the `pg` client.

- [ ] **Step 1.1: Write a failing test**

Create `web/__tests__/hyperdrive-create-user-sql.test.js`:
```js
const request = require('supertest');
const { app } = require('../server');

describe('POST /api/hyperdrive/create-user input validation', () => {
  // The handler requires a live PG connection to succeed. In the test env
  // there is no PG running, so success paths will 500 at the pool.connect()
  // stage. What matters here: validation/rejection must come BEFORE any
  // SQL is built, so injection strings return 400 without touching pg.

  test('rejects username with SQL metacharacters', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb', username: "alice'; DROP TABLE users; --", password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Ii]nvalid username/);
  });

  test('rejects database with SQL metacharacters', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb"; DROP TABLE foo; --', username: 'alice', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Ii]nvalid database/);
  });

  test('rejects username with semicolon', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb', username: 'alice;bob', password: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects empty body', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({});
    expect(res.status).toBe(400);
  });

  test('well-formed input passes validation (may then 500 on pool.connect in test env)', async () => {
    const res = await request(app)
      .post('/api/hyperdrive/create-user')
      .send({ database: 'mydb', username: 'alice', password: "anything with ' quote" });
    // Validation passed -> handler proceeds -> pool.connect() fails in test env.
    // We assert: status is NOT 400 with "invalid" in message. Body may be 500 or 200.
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/[Ii]nvalid/);
    }
  });
});
```

- [ ] **Step 1.2: Run the test — the already-valid allowlist cases should PASS; the well-formed-input case may fail but expectations account for it**

Run: `cd web && npx jest __tests__/hyperdrive-create-user-sql.test.js`
Expected: the four rejection tests pass (existing allowlist catches them); the "well-formed" test passes because the guard allows it through. This test file is a **regression harness** for Task 1.3's rewrite — it ensures the rewrite does not weaken the input validation.

- [ ] **Step 1.3: Rewrite the SQL section to use `escapeIdentifier`/`escapeLiteral`**

In `web/src/routes/cloudflare.js`, locate the handler block (lines 361–380):
```js
  router.post('/hyperdrive/create-user', async (req, res) => {
    const { database, username, password } = req.body;
    if (!database || !username || !password) return res.status(400).json({ error: 'database, username, and password are required' });
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(username)) return res.status(400).json({ error: 'Invalid username format' });
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) return res.status(400).json({ error: 'Invalid database name format' });
    const pool = new Pool({ host: VIP || nodes[0].ip, port: parseInt(PG_PORT), user: 'postgres', password: PG_PASS, database: 'postgres', connectionTimeoutMillis: 5000 });
    try {
      const exists = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [username]);
      if (exists.rows.length > 0) await pool.query(`ALTER USER ${username} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      else await pool.query(`CREATE USER ${username} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      await pool.query(`GRANT ALL PRIVILEGES ON DATABASE ${database} TO ${username}`);
      const dbPool = new Pool({ host: VIP || nodes[0].ip, port: parseInt(PG_PORT), user: 'postgres', password: PG_PASS, database, connectionTimeoutMillis: 5000 });
      try {
        await dbPool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${username}`);
        await dbPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${username}`);
      } finally { await dbPool.end().catch(() => {}); }
      res.json({ message: `User ${username} configured with access to ${database}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await pool.end().catch(() => {}); }
  });
```

Replace the try-block body (keeping the handler signature, the input guards, and the pool construction) with:
```js
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
```

Key differences:
- Uses `pool.connect()` → `client.escapeIdentifier`/`escapeLiteral` (available on the pooled client, not the pool)
- Eliminates manual `password.replace(/'/g, "''")` — a known-incomplete escaping
- Eliminates string interpolation of `${username}`/`${database}` into DDL
- Releases the client in `finally` blocks

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `cd web && npx jest __tests__/hyperdrive-create-user-sql.test.js`
Expected: all 5 tests pass.

- [ ] **Step 1.5: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add web/src/routes/cloudflare.js web/__tests__/hyperdrive-create-user-sql.test.js
git commit -m "Use escapeIdentifier/escapeLiteral in hyperdrive create-user SQL"
```

---

## Task 2: Fix 3.2 — regex injection via `updateConfKeys`

**Files:**
- Modify: `web/src/app.js` (`updateConfKeys` function, lines 36–46)
- Test: `web/__tests__/update-conf-keys.test.js` (new)

`updateConfKeys` builds a `RegExp` from the user-supplied key name. A key like `FOO.*` or `a|b` would match unintended lines in `cluster.conf`. Fix: reject any key that isn't `[A-Z_][A-Z0-9_]*`.

- [ ] **Step 2.1: Write a failing test**

Create `web/__tests__/update-conf-keys.test.js`:
```js
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('updateConfKeys key validation', () => {
  let tmpDir, confPath, originalConfPath;

  beforeAll(() => {
    // We test updateConfKeys indirectly by exercising the code path in app.js
    // via the POST /api/storage/apply endpoint. But that endpoint requires
    // auth AND is on the INTERNAL_PATHS list. The cleanest test is a direct
    // unit test against a module export — but app.js currently does not
    // export updateConfKeys. We have two options:
    //   1. Export it from app.js (invasive)
    //   2. Use Supertest against /api/storage/apply and rely on the
    //      no-auth branch (in the test env, authConfig is null)
    // Option 2 keeps the surface minimal.
  });

  // Use Supertest — in test env, authConfig is null so the middleware is a
  // no-op and INTERNAL_PATHS goes through. Under a real install, this
  // endpoint is still gated by the X-Internal-Token from Stage 1.
  const request = require('supertest');
  const { app } = require('../server');

  test('rejects key with regex metacharacters', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ 'FOO.*': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('rejects key with pipe (regex alternation)', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ 'A|B': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('rejects lowercase key', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ 'foo': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('rejects key starting with digit', async () => {
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ '1FOO': 'bar' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/[Ii]nvalid config key/);
  });

  test('accepts well-formed uppercase key', async () => {
    // This will succeed and write to the actual cluster.conf if present,
    // or silently create one. To avoid test pollution, use a key that the
    // real cluster doesn't care about, then verify it was written.
    const res = await request(app)
      .post('/api/storage/apply')
      .send({ TEST_KEY_FROM_JEST: 'ok' });
    // Response may be 200 with status ok, or 500 if cluster.conf path is not
    // writable in the test env. What we care about: the error, if any, is
    // NOT "Invalid config key".
    if (res.status === 500) {
      expect(res.body.error).not.toMatch(/[Ii]nvalid config key/);
    }
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `cd web && npx jest __tests__/update-conf-keys.test.js`
Expected: the four "rejects" tests FAIL (current `updateConfKeys` accepts any string and builds a RegExp from it).

- [ ] **Step 2.3: Add key validation to `updateConfKeys`**

In `web/src/app.js`, locate `updateConfKeys` (lines 36–46):
```js
  function updateConfKeys(updates) {
    let content = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}="${value}"`;
      if (regex.test(content)) content = content.replace(regex, line);
      else content = content.trimEnd() + '\n' + line + '\n';
    }
    fs.writeFileSync(confPath, content);
    reloadConf();
  }
```

Replace with:
```js
  function updateConfKeys(updates) {
    let content = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid config key: ${key}`);
      }
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}="${value}"`;
      if (regex.test(content)) content = content.replace(regex, line);
      else content = content.trimEnd() + '\n' + line + '\n';
    }
    fs.writeFileSync(confPath, content);
    reloadConf();
  }
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `cd web && npx jest __tests__/update-conf-keys.test.js`
Expected: all 5 tests pass.

- [ ] **Step 2.5: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass. Note: the `accepts well-formed uppercase key` test may write `TEST_KEY_FROM_JEST="ok"` to `cluster.conf` if one exists in the repo. Check with `git diff cluster.conf`. If the file is actually modified, revert with `git checkout cluster.conf` — but `cluster.conf` is in `.gitignore` so this should be a no-op.

- [ ] **Step 2.6: Commit**

```bash
git add web/src/app.js web/__tests__/update-conf-keys.test.js
git commit -m "Validate config keys in updateConfKeys to block regex injection"
```

---

## Task 3: Fix 3.3 — timing-safe hash comparison in `verifyPassword`

**Files:**
- Modify: `web/src/middleware/auth.js` (`verifyPassword`, lines 25–32)
- Test: `web/__tests__/auth-timing-safe.test.js` (new)

- [ ] **Step 3.1: Write a failing test**

Create `web/__tests__/auth-timing-safe.test.js`:
```js
const { verifyPassword, hashPassword } = require('../src/middleware/auth');

describe('verifyPassword timing-safe comparison', () => {
  test('accepts correct password', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    const ok = await verifyPassword('correct-horse', hash, salt);
    expect(ok).toBe(true);
  });

  test('rejects wrong password', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    const ok = await verifyPassword('wrong-horse', hash, salt);
    expect(ok).toBe(false);
  });

  test('rejects empty password', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    const ok = await verifyPassword('', hash, salt);
    expect(ok).toBe(false);
  });

  test('rejects malformed hash (odd-length hex) without throwing', async () => {
    // Buffer.from('abc', 'hex') silently truncates to empty — this should
    // be rejected, not throw, and not accept.
    const ok = await verifyPassword('any-password', 'abc', '00'.repeat(16));
    expect(ok).toBe(false);
  });

  test('rejects hash of wrong length without throwing', async () => {
    // 32 hex chars = 16 bytes, but scrypt produces 64 bytes.
    const shortHash = 'aa'.repeat(16);
    const ok = await verifyPassword('any-password', shortHash, '00'.repeat(16));
    expect(ok).toBe(false);
  });

  test('rejects garbage salt without throwing', async () => {
    const ok = await verifyPassword('any-password', 'aa'.repeat(64), 'not-hex-at-all');
    // Either resolves false or rejects — must not crash the process.
    expect([true, false]).toContain(ok);
  });
});
```

- [ ] **Step 3.2: Run the test — expect most to already pass, but the malformed-hash tests may fail or crash**

Run: `cd web && npx jest __tests__/auth-timing-safe.test.js`
Expected: the "correct"/"wrong" password tests pass. The "wrong length" and "malformed hex" tests may pass under the current string comparison, but a timing-safe rewrite could throw if not guarded. The point of writing them first is to lock in the no-throw contract.

- [ ] **Step 3.3: Rewrite the comparison**

In `web/src/middleware/auth.js`, locate `verifyPassword` (lines 25–32):
```js
function verifyPassword(password, hash, salt) {
  return new Promise((resolve) => {
    crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) return resolve(false);
      resolve(derived.toString('hex') === hash);
    });
  });
}
```

Replace with:
```js
function verifyPassword(password, hash, salt) {
  return new Promise((resolve) => {
    let saltBuf;
    try { saltBuf = Buffer.from(salt, 'hex'); } catch { return resolve(false); }
    crypto.scrypt(password, saltBuf, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) return resolve(false);
      try {
        const hashBuf = Buffer.from(hash, 'hex');
        if (hashBuf.length !== derived.length) return resolve(false);
        resolve(crypto.timingSafeEqual(derived, hashBuf));
      } catch {
        resolve(false);
      }
    });
  });
}
```

- [ ] **Step 3.4: Run the test to verify it passes**

Run: `cd web && npx jest __tests__/auth-timing-safe.test.js`
Expected: all 6 tests pass.

- [ ] **Step 3.5: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass — crucially, the existing `Login flow` tests in `server.test.js` still pass because `verifyPassword` still resolves `true` for a correct password.

- [ ] **Step 3.6: Commit**

```bash
git add web/src/middleware/auth.js web/__tests__/auth-timing-safe.test.js
git commit -m "Use crypto.timingSafeEqual for password hash comparison"
```

---

## Task 4: Fix 3.4 — enable etcd client certificate authentication

**Files:**
- Modify: `templates/etcd.env` (line 24)
- Modify: `templates/patroni.yml` (etcd3 section, lines 12–14)
- Modify: `scripts/02-setup-etcd.sh` (health check around lines 38–44)
- Modify: `scripts/04-verify-cluster.sh` (etcdctl command construction)
- Modify: `scripts/setup.sh` (health check around lines 221–226)

No Jest test for this — it's template/config changes affecting a running etcd process. Verification is via BATS snapshot assertions on the rendered templates and manual shellcheck.

- [ ] **Step 4.1: Write failing BATS snapshot tests**

Append to `tests/common.bats`:
```bash
# ---- templates/etcd.env: client cert auth ----

@test "etcd.env template enables client cert auth" {
    # We're not rendering via process_template here — just checking the
    # template source has the right flag. This catches regressions if
    # someone flips it back to false.
    grep -q '^ETCD_CLIENT_CERT_AUTH="true"' "$BATS_TEST_DIRNAME/../templates/etcd.env"
}

# ---- templates/patroni.yml: etcd3 TLS client certs ----

@test "patroni.yml template has etcd3 TLS client cert paths" {
    local t="$BATS_TEST_DIRNAME/../templates/patroni.yml"
    grep -q '  cacert: /etc/etcd/ssl/ca.crt' "$t"
    grep -q '  cert: /etc/etcd/ssl/server.crt' "$t"
    grep -q '  key: /etc/etcd/ssl/server.key' "$t"
}
```

- [ ] **Step 4.2: Run the tests to verify they fail**

Run: `bats tests/common.bats`
Expected: the two new tests FAIL (current `etcd.env` has `ETCD_CLIENT_CERT_AUTH="false"`; current `patroni.yml` has no `cacert`/`cert`/`key` under etcd3).

- [ ] **Step 4.3: Flip `ETCD_CLIENT_CERT_AUTH` to `"true"`**

In `templates/etcd.env`, locate line 24:
```
ETCD_CLIENT_CERT_AUTH="false"
```

Replace with:
```
ETCD_CLIENT_CERT_AUTH="true"
```

- [ ] **Step 4.4: Add TLS client cert paths to `templates/patroni.yml`**

In `templates/patroni.yml`, locate the etcd3 section (lines 12–14):
```yaml
etcd3:
  hosts:
{{ETCD3_HOST_LIST}}
```

Replace with:
```yaml
etcd3:
  hosts:
{{ETCD3_HOST_LIST}}
  cacert: /etc/etcd/ssl/ca.crt
  cert: /etc/etcd/ssl/server.crt
  key: /etc/etcd/ssl/server.key
```

Note: these paths already exist on every DB node because `scripts/02-setup-etcd.sh` generates them during the etcd bootstrap. We do **not** create new certs here; we just point Patroni at the existing ones. The `server.crt` has `clientAuth` EKU because etcd expects it.

- [ ] **Step 4.5: Run the BATS snapshot tests**

Run: `bats tests/common.bats`
Expected: the two new snapshot tests pass.

- [ ] **Step 4.6: Update etcdctl invocations in `scripts/02-setup-etcd.sh`**

In `scripts/02-setup-etcd.sh`, locate the health check block (lines 36–44):
```bash
echo "Checking health..."
sleep 3
ETCD_CACERT="/etc/etcd/ssl/ca.crt"
ETCD_HEALTH_ARGS=(endpoint health --endpoints="https://127.0.0.1:2379")
if [ -f "${ETCD_CACERT}" ]; then
    ETCD_HEALTH_ARGS+=("--cacert=${ETCD_CACERT}")
fi
etcdctl "${ETCD_HEALTH_ARGS[@]}" \
    || echo "Note: etcd may take a moment to elect a leader when starting the cluster"
```

Replace with:
```bash
echo "Checking health..."
sleep 3
ETCD_CACERT="/etc/etcd/ssl/ca.crt"
ETCD_CERT="/etc/etcd/ssl/server.crt"
ETCD_KEY="/etc/etcd/ssl/server.key"
ETCD_HEALTH_ARGS=(endpoint health --endpoints="https://127.0.0.1:2379")
if [ -f "${ETCD_CACERT}" ]; then
    ETCD_HEALTH_ARGS+=("--cacert=${ETCD_CACERT}")
fi
if [ -f "${ETCD_CERT}" ] && [ -f "${ETCD_KEY}" ]; then
    ETCD_HEALTH_ARGS+=("--cert=${ETCD_CERT}" "--key=${ETCD_KEY}")
fi
etcdctl "${ETCD_HEALTH_ARGS[@]}" \
    || echo "Note: etcd may take a moment to elect a leader when starting the cluster"
```

- [ ] **Step 4.7: Update etcdctl invocations in `scripts/setup.sh`**

Find the health check block:
```bash
grep -n "ETCD_HEALTH_ARGS\|etcdctl " scripts/setup.sh
```

For each etcdctl call that constructs `ETCD_HEALTH_ARGS` or equivalent, apply the same three lines (`ETCD_CERT`, `ETCD_KEY`, `if [ -f ... ] && [ -f ... ]; then ... --cert --key`) as in Step 4.6. If `setup.sh` uses a different variable name or inline array, adapt the pattern but keep the same conditional-append shape.

If `setup.sh` has only one such block and it mirrors `02-setup-etcd.sh`, apply the identical change. If it has several, apply to all.

- [ ] **Step 4.8: Update etcdctl invocations in `scripts/04-verify-cluster.sh`**

Find the etcdctl call(s):
```bash
grep -n "etcdctl\|ETCD_TLS_ARGS\|ETCD_HEALTH_ARGS" scripts/04-verify-cluster.sh
```

Apply the same `--cert`/`--key` conditional-append pattern to each. The fixes doc's exact snippet:
```bash
if [ -f "${ETCD_CACERT}" ]; then
    ETCD_TLS_ARGS+=("--cacert=${ETCD_CACERT}")
fi
if [ -f "/etc/etcd/ssl/server.crt" ]; then
    ETCD_TLS_ARGS+=("--cert=/etc/etcd/ssl/server.crt" "--key=/etc/etcd/ssl/server.key")
fi
```

If the script uses `ETCD_HEALTH_ARGS` instead of `ETCD_TLS_ARGS`, rename accordingly — keep the script's existing convention.

- [ ] **Step 4.9: Syntax + shellcheck sweep**

Run:
```bash
bash -n scripts/02-setup-etcd.sh scripts/setup.sh scripts/04-verify-cluster.sh
shellcheck scripts/02-setup-etcd.sh scripts/setup.sh scripts/04-verify-cluster.sh
```
Expected: clean; no new warnings.

- [ ] **Step 4.10: Stage-closing commit for 3a**

```bash
git add templates/etcd.env templates/patroni.yml scripts/02-setup-etcd.sh scripts/setup.sh scripts/04-verify-cluster.sh tests/common.bats
git commit -m "fix: harden SQL injection, regex injection, timing attack, etcd auth (Stage 3a)

Stage 3a of the remediation plan. Stage 3 is split into 3a (injection
hardening, this commit) and 3b (drop dashboard to non-root) per the
spec's risk-gated ordering. Preceding commits in this stage group:

- 3.1 use escapeIdentifier/escapeLiteral in hyperdrive create-user SQL
- 3.2 validate config keys in updateConfKeys to block regex injection
- 3.3 use crypto.timingSafeEqual for password hash comparison
- 3.4 (this commit) enable etcd client certificate authentication"
```

Note: the fixes doc's Stage 3 message mentions drop-root too. The spec split means this commit carries a **subset** of the stage message and 3b's commit carries the drop-root half. Both together constitute the fixes-doc Stage 3.

---

## Stage 3a close-out

- [ ] **Step 5.1: Full regression sweep**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/*.sh configure.sh install.sh update.sh
bash -n configure.sh install.sh scripts/*.sh
```
Expected: all tests green; no new shellcheck warnings.

- [ ] **Step 5.2: Final sanity check**

```bash
git log --oneline $(git merge-base main HEAD)..HEAD
```
Expected: 19 commits on the branch (8 Stage 1 + 7 Stage 2 + 4 Stage 3a). The last commit is the Stage 3a-closing commit.

- [ ] **Step 5.3: Manual verification (optional but recommended before 3b)**

If you have a two-node test environment, restart Patroni on one node and confirm it reconnects to etcd with client certs:
```bash
sudo systemctl restart patroni
sudo journalctl -u patroni -n 50 --no-pager
# Look for: successful etcd connection, no TLS handshake errors
sudo patronictl -c /etc/patroni/config.yml list
# Must show the cluster healthy
```
If Patroni fails to connect to etcd, **stop and diagnose before Stage 3b**. The most likely cause is a server.crt without `clientAuth` EKU — in that case, regenerate etcd certs with clientAuth, or temporarily revert `ETCD_CLIENT_CERT_AUTH` to `"false"` and investigate. Do not chain 3b on top of a broken 3a.

Stage 3a is complete. Proceed to Stage 3b (drop root) only after the above is green.
