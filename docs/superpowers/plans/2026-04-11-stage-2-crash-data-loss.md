# Stage 2: Crash Bugs and Data Loss Prevention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `https` import crash in the version-check endpoint, add data-wipe confirmations to the standalone etcd/Patroni scripts, and repair the vip-manager template + `VIP_NETMASK` handling (absorbing fix 6.3's vip-manager version centralization).

**Architecture:** The `web/src/app.js` crash is a one-line import fix with a Jest regression test. The shell-script data-wipe confirmations wrap existing `rm -rf` calls in interactive prompts gated by state checks. The vip-manager fix replaces inline config generation with a proper template + new `get_vip_etcd_endpoints()` helper in `common.sh`, adds `VIP_NETMASK` as a first-class config field, and reads `VIP_MANAGER_VERSION` from `versions.env` (fix 6.3 absorbed here).

**Tech Stack:** Node `https` module, Jest + Supertest, bash, BATS.

**Source spec:** `docs/superpowers/specs/2026-04-11-remediation-plan-design.md`
**Source fixes doc:** `postgresql-cluster-fixes.md` §2.1–2.4 (and §6.3 absorbed into 2.4)
**Stage-closing commit message:** `fix: prevent crash on version check, add data-wipe confirmations, fix vip-manager template`

---

## Preflight

- [ ] **Step 0.1: Confirm Stage 1 is complete and branch is clean**

Run:
```bash
cd /home/adityaharsh/applications/postgresql-cluster
git status
git log --oneline $(git merge-base main HEAD)..HEAD | head -10
(cd web && npm test)
bats tests/
```
Expected: working tree clean; 8 Stage 1 commits visible; all tests green. You should currently be on branch `remediation/security-fixes`.

---

## Task 1: Fix 2.1 — add missing `https` import to `web/src/app.js`

**Files:**
- Modify: `web/src/app.js` (line 2 area — the `require` block)
- Test: `web/__tests__/version-check.test.js` (new)

- [ ] **Step 1.1: Write a failing test**

Create `web/__tests__/version-check.test.js`:
```js
const request = require('supertest');
const { app } = require('../server');

describe('GET /api/version/check', () => {
  // The endpoint previously crashed with "ReferenceError: https is not defined"
  // because web/src/app.js imported http but not https, and the GitHub tag
  // lookup goes through https.get.
  test('does not crash (http status is returned, not a ReferenceError)', async () => {
    const res = await request(app).get('/api/version/check');
    // Any real HTTP status is fine (200 if GitHub reachable, 200 with .error
    // if not — the endpoint catches network errors). What matters is: no
    // process crash and no 500 from a ReferenceError.
    expect([200, 401, 500]).toContain(res.status);
    if (res.status === 500) {
      // If it IS 500, we want to see a ReferenceError-free body
      expect(JSON.stringify(res.body)).not.toMatch(/ReferenceError|https is not defined/);
    }
  });

  test('response shape has current version when auth is not required', async () => {
    const res = await request(app).get('/api/version/check');
    if (res.status === 200) {
      expect(res.body).toHaveProperty('current');
    }
  });
});
```

- [ ] **Step 1.2: Run the test to verify it exercises the bug**

Run: `cd web && npx jest __tests__/version-check.test.js`
Expected: the test likely FAILS or the test process reports an uncaught `ReferenceError: https is not defined` from inside `/api/version/check`'s handler. (Supertest may surface this as a rejected request or a 500.) Note the exact failure mode.

- [ ] **Step 1.3: Add the import**

In `web/src/app.js`, locate line 2:
```js
const http = require('http');
```

Insert immediately after:
```js
const https = require('https');
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `cd web && npx jest __tests__/version-check.test.js`
Expected: both tests pass. No `ReferenceError` in output.

- [ ] **Step 1.5: Run the full Jest suite**

Run: `cd web && npm test`
Expected: all tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add web/src/app.js web/__tests__/version-check.test.js
git commit -m "Import https module in web/src/app.js to fix version-check crash"
```

---

## Task 2: Fix 2.2 — add data-wipe confirmation to `02-setup-etcd.sh`

**Files:**
- Modify: `scripts/02-setup-etcd.sh` (line 24 — the unconditional `rm -rf`)

No BATS test — the script requires root and `systemctl` which can't run in a test env. Verify via `bash -n`, `shellcheck`, and a controlled smoke test.

- [ ] **Step 2.1: Replace the unconditional wipe**

In `scripts/02-setup-etcd.sh`, locate lines 23–24:
```bash
# Clear old etcd data for fresh cluster bootstrap
rm -rf /var/lib/etcd/default
```

Replace with:
```bash
# Clear old etcd data for fresh cluster bootstrap — prompt if non-empty
if [ -d /var/lib/etcd/default ] && [ -n "$(ls -A /var/lib/etcd/default 2>/dev/null)" ]; then
    echo ""
    echo "WARNING: etcd data directory is NOT empty."
    echo "Wiping it will destroy this node's cluster membership."
    read -rp "Wipe existing etcd data and re-bootstrap? (y/N): " WIPE_ETCD
    if [[ "${WIPE_ETCD}" != "y" && "${WIPE_ETCD}" != "Y" ]]; then
        echo "Keeping existing etcd data."
    else
        rm -rf /var/lib/etcd/default
    fi
else
    rm -rf /var/lib/etcd/default 2>/dev/null || true
fi
```

- [ ] **Step 2.2: Syntax check**

Run: `bash -n scripts/02-setup-etcd.sh`
Expected: clean.

- [ ] **Step 2.3: Shellcheck**

Run: `shellcheck scripts/02-setup-etcd.sh`
Expected: no new warnings beyond pre-existing `SC1091` (sourcing `common.sh`).

- [ ] **Step 2.4: Smoke test the prompt logic in a tmp dir**

Run:
```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/default"
touch "$TMP/default/keep-me"

# Simulate the "say no" branch
bash -c '
cd "'"$TMP"'"
WIPE_ETCD="n"
if [ -d ./default ] && [ -n "$(ls -A ./default 2>/dev/null)" ]; then
    if [[ "${WIPE_ETCD}" != "y" && "${WIPE_ETCD}" != "Y" ]]; then
        echo "Keeping existing etcd data."
    else
        rm -rf ./default
    fi
fi
'
[ -f "$TMP/default/keep-me" ] && echo "PASS: data preserved on 'n'" || echo "FAIL"

# Simulate the "say yes" branch
bash -c '
cd "'"$TMP"'"
WIPE_ETCD="y"
if [ -d ./default ] && [ -n "$(ls -A ./default 2>/dev/null)" ]; then
    if [[ "${WIPE_ETCD}" != "y" && "${WIPE_ETCD}" != "Y" ]]; then
        echo "Keeping existing etcd data."
    else
        rm -rf ./default
    fi
fi
'
[ ! -f "$TMP/default/keep-me" ] && echo "PASS: data wiped on 'y'" || echo "FAIL"

rm -rf "$TMP"
```
Expected: both `PASS` lines.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/02-setup-etcd.sh
git commit -m "Prompt before wiping etcd data directory in standalone script"
```

---

## Task 3: Fix 2.3 — add data-wipe confirmation to `03-setup-patroni.sh`

**Files:**
- Modify: `scripts/03-setup-patroni.sh` (lines 27–37 — the Node 1 branch and unconditional wipe)

- [ ] **Step 3.1: Replace the handling block**

In `scripts/03-setup-patroni.sh`, locate lines 26–37:
```bash
# Handle data directory
if [[ "$NODE_NUM" == "1" ]]; then
    echo ""
    echo "WARNING: This is Node 1 — it will become the initial primary."
    echo "If you have existing data you want to keep, press Ctrl+C NOW."
    echo "Patroni will reinitialize the data directory."
    echo "Waiting 10 seconds..."
    sleep 10
else
    echo "Clearing data directory on replica node..."
fi
rm -rf "${PG_DATA_DIR}"/*
```

Replace with:
```bash
# Handle data directory
if [[ "$NODE_NUM" == "1" ]]; then
    echo ""
    echo "WARNING: This is Node 1 — it will become the initial primary."
    echo "If you have existing data you want to keep, press Ctrl+C NOW."
    echo "Patroni will reinitialize the data directory."
    echo "Waiting 10 seconds..."
    sleep 10
else
    echo "This is a replica node."
fi

if [ -d "${PG_DATA_DIR}" ] && [ -n "$(ls -A "${PG_DATA_DIR}" 2>/dev/null)" ]; then
    if systemctl is-active patroni &>/dev/null; then
        echo "Patroni is currently running. Stop it first or use setup.sh which handles this safely."
        exit 1
    fi
    echo "WARNING: Data directory ${PG_DATA_DIR} is not empty."
    read -rp "Wipe and reinitialize? (y/N): " WIPE_PG
    if [[ "${WIPE_PG}" != "y" && "${WIPE_PG}" != "Y" ]]; then
        echo "Keeping existing data."
    else
        rm -rf "${PG_DATA_DIR:?}"/*
    fi
else
    rm -rf "${PG_DATA_DIR:?}"/* 2>/dev/null || true
fi
```

Note: `${PG_DATA_DIR:?}` refuses to expand if `PG_DATA_DIR` is unset or empty — a safety belt against `rm -rf /*`.

- [ ] **Step 3.2: Syntax check**

Run: `bash -n scripts/03-setup-patroni.sh`
Expected: clean.

- [ ] **Step 3.3: Shellcheck**

Run: `shellcheck scripts/03-setup-patroni.sh`
Expected: no new warnings.

- [ ] **Step 3.4: Smoke test the confirmation branches**

Run:
```bash
TMP=$(mktemp -d)
PG_DATA_DIR="$TMP/pgdata"
mkdir -p "$PG_DATA_DIR"
touch "$PG_DATA_DIR/important"

# Say "no"
WIPE_PG="n" bash -c '
if [ -d "'"$PG_DATA_DIR"'" ] && [ -n "$(ls -A "'"$PG_DATA_DIR"'" 2>/dev/null)" ]; then
    if [[ "${WIPE_PG}" != "y" && "${WIPE_PG}" != "Y" ]]; then
        echo "Keeping existing data."
    else
        rm -rf "'"$PG_DATA_DIR"'"/*
    fi
fi
'
[ -f "$PG_DATA_DIR/important" ] && echo "PASS: data preserved on 'n'" || echo "FAIL"

# Say "y"
WIPE_PG="y" bash -c '
if [ -d "'"$PG_DATA_DIR"'" ] && [ -n "$(ls -A "'"$PG_DATA_DIR"'" 2>/dev/null)" ]; then
    if [[ "${WIPE_PG}" != "y" && "${WIPE_PG}" != "Y" ]]; then
        echo "Keeping existing data."
    else
        rm -rf "'"$PG_DATA_DIR"'"/*
    fi
fi
'
[ ! -f "$PG_DATA_DIR/important" ] && echo "PASS: data wiped on 'y'" || echo "FAIL"

rm -rf "$TMP"
```
Expected: both `PASS`.

- [ ] **Step 3.5: Commit**

```bash
git add scripts/03-setup-patroni.sh
git commit -m "Prompt before wiping Patroni data directory in standalone script"
```

---

## Task 4: Fix 2.4a — add `get_vip_etcd_endpoints()` helper to `common.sh`

**Files:**
- Modify: `scripts/common.sh` (add helper after `get_etcd3_host_list`, around line 106)
- Test: `tests/common.bats` (add `@test`)

- [ ] **Step 4.1: Write a failing BATS test**

Append to `tests/common.bats` (after the existing `get_etcd3_host_list` test, before the `detect_node_number` section):
```bash
# ---- get_vip_etcd_endpoints ----

@test "get_vip_etcd_endpoints returns YAML list with 2-space indent" {
    result=$(get_vip_etcd_endpoints)
    [[ "$result" == *"  - https://10.0.0.1:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.2:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.3:2379"* ]]
    # must be 3 lines for a 3-node cluster
    [ "$(echo "$result" | wc -l)" -eq 3 ]
}

@test "get_vip_etcd_endpoints handles single-node cluster" {
    cat > "$TEST_DIR/cluster.conf" << 'SEOF'
NODE_COUNT=1
NODE_1_IP="192.168.1.1"
SEOF
    # shellcheck disable=SC1090
    source "$TEST_DIR/cluster.conf"
    result=$(get_vip_etcd_endpoints)
    [ "$result" = "  - https://192.168.1.1:2379" ]
}
```

- [ ] **Step 4.2: Run the test to verify it fails**

Run: `bats tests/common.bats`
Expected: the two new tests FAIL with "command not found" or "get_vip_etcd_endpoints: command not found".

- [ ] **Step 4.3: Add the helper to `scripts/common.sh`**

Locate `get_etcd3_host_list` (lines 102–106):
```bash
# Build YAML list of etcd hosts for Patroni etcd3 config (host:port format)
get_etcd3_host_list() {
    for i in $(seq 1 "${NODE_COUNT}"); do
        echo "    - https://$(get_node_ip "$i"):2379"
    done
}
```

Insert immediately after:
```bash
# Build YAML list of etcd endpoints for vip-manager (2-space indent, not 4)
get_vip_etcd_endpoints() {
    for i in $(seq 1 "${NODE_COUNT}"); do
        echo "  - https://$(get_node_ip "$i"):2379"
    done
}
```

- [ ] **Step 4.4: Run the test to verify it passes**

Run: `bats tests/common.bats`
Expected: all tests pass, including the two new ones.

- [ ] **Step 4.5: Commit**

```bash
git add scripts/common.sh tests/common.bats
git commit -m "Add get_vip_etcd_endpoints helper for vip-manager YAML list"
```

---

## Task 5: Fix 2.4b — add `VIP_NETMASK` config field and `VIP_ETCD_ENDPOINTS` template substitution

**Files:**
- Modify: `scripts/common.sh` (`process_template` function around lines 175–200; `validate_config` around lines 13–73)
- Modify: `configure.sh` (add prompt + emission)
- Modify: `cluster.conf.example`
- Test: `tests/common.bats` (add `@test`)

- [ ] **Step 5.1: Write a failing BATS test for the template substitution**

Append to `tests/common.bats`:
```bash
# ---- process_template: VIP_ETCD_ENDPOINTS and VIP_NETMASK ----

@test "process_template substitutes VIP_ETCD_ENDPOINTS (multi-line)" {
    cat > "$TEST_DIR/templates/vip.tmpl" << 'TEOF'
dcs-endpoints:
{{VIP_ETCD_ENDPOINTS}}
TEOF
    result=$(process_template "$TEST_DIR/templates/vip.tmpl")
    [[ "$result" == *"  - https://10.0.0.1:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.2:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.3:2379"* ]]
    # placeholder must be fully replaced
    [[ "$result" != *"{{VIP_ETCD_ENDPOINTS}}"* ]]
}

@test "process_template substitutes VIP_NETMASK" {
    VIP_NETMASK="24"
    cat > "$TEST_DIR/templates/vip-mask.tmpl" << 'TEOF'
netmask: {{VIP_NETMASK}}
TEOF
    result=$(process_template "$TEST_DIR/templates/vip-mask.tmpl")
    [[ "$result" == *"netmask: 24"* ]]
    [[ "$result" != *"{{VIP_NETMASK}}"* ]]
}
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `bats tests/common.bats`
Expected: the two new tests FAIL (template placeholders remain unreplaced).

- [ ] **Step 5.3: Wire `VIP_ETCD_ENDPOINTS` and `VIP_NETMASK` into `process_template`**

In `scripts/common.sh`, locate the multi-line replacement block inside `process_template` (around lines 175–179):
```bash
    # Multi-line replacements (must be done before sed)
    local etcd3_hosts
    etcd3_hosts=$(get_etcd3_host_list)
    content="${content//\{\{ETCD3_HOST_LIST\}\}/$etcd3_hosts}"
```

Replace with:
```bash
    # Multi-line replacements (must be done before sed)
    local etcd3_hosts vip_etcd_endpoints
    etcd3_hosts=$(get_etcd3_host_list)
    content="${content//\{\{ETCD3_HOST_LIST\}\}/$etcd3_hosts}"
    vip_etcd_endpoints=$(get_vip_etcd_endpoints)
    content="${content//\{\{VIP_ETCD_ENDPOINTS\}\}/$vip_etcd_endpoints}"
```

Then locate the sed block (around lines 181–200) and add the `VIP_NETMASK` line alongside `VIP_ADDRESS`/`VIP_INTERFACE`:
```bash
        -e "s|{{VIP_ADDRESS}}|${VIP_ADDRESS}|g" \
        -e "s|{{VIP_INTERFACE}}|${VIP_INTERFACE}|g" \
```

Replace with:
```bash
        -e "s|{{VIP_ADDRESS}}|${VIP_ADDRESS}|g" \
        -e "s|{{VIP_NETMASK}}|${VIP_NETMASK:-24}|g" \
        -e "s|{{VIP_INTERFACE}}|${VIP_INTERFACE}|g" \
```

The `:-24` default keeps the template renderable even when `VIP_NETMASK` is unset — important for existing cluster.conf files during the migration window before `install.sh` backfills it.

- [ ] **Step 5.4: Add `VIP_NETMASK` to `validate_config`'s VIP section**

In `scripts/common.sh`, locate the `validate_config` function's VIP block (lines 58–65):
```bash
    # If VIP enabled, VIP fields must be set
    if [[ "${ENABLE_VIP:-}" == "Y" || "${ENABLE_VIP:-}" == "y" ]]; then
        for var in VIP_ADDRESS VIP_INTERFACE; do
            if [ -z "${!var:-}" ]; then
                echo "ERROR: ${var} is required when ENABLE_VIP=Y" >&2
                errors=$((errors + 1))
            fi
        done
    fi
```

Do **not** add `VIP_NETMASK` to this required loop. Instead, append after the existing block:
```bash
    # VIP_NETMASK is optional (defaults to 24) but if set must be numeric 1-32
    if [ -n "${VIP_NETMASK:-}" ] && ! [[ "${VIP_NETMASK}" =~ ^[0-9]+$ && "${VIP_NETMASK}" -ge 1 && "${VIP_NETMASK}" -le 32 ]]; then
        echo "ERROR: VIP_NETMASK must be an integer 1-32, got '${VIP_NETMASK}'" >&2
        errors=$((errors + 1))
    fi
```

This is soft enforcement — backward-compatible with existing `cluster.conf` files that don't have `VIP_NETMASK`, but catches typos when set.

- [ ] **Step 5.5: Run the BATS tests to verify they pass**

Run: `bats tests/common.bats`
Expected: all tests pass.

- [ ] **Step 5.6: Add `VIP_NETMASK` to `configure.sh`**

Find the VIP prompt section in `configure.sh`:
```bash
grep -n "VIP_INTERFACE\|VIP_ADDRESS" configure.sh
```

You should see the wizard block where `VIP_ADDRESS` and `VIP_INTERFACE` are prompted for (typically inside `if [[ "${ENABLE_VIP,,}" == "y" ]]`). Add a prompt immediately after the `VIP_INTERFACE` prompt:
```bash
read -rp "  VIP netmask (CIDR bits, default 24): " VIP_NETMASK
VIP_NETMASK="${VIP_NETMASK:-24}"
```

Then in the `cat > "${CONF_FILE}"` here-doc block (around lines 265–268 where `VIP_INTERFACE` is emitted):
```bash
# --- Virtual IP ---
ENABLE_VIP="${ENABLE_VIP}"
VIP_ADDRESS="${VIP_ADDRESS}"
VIP_INTERFACE="${VIP_INTERFACE}"
```

Replace with:
```bash
# --- Virtual IP ---
ENABLE_VIP="${ENABLE_VIP}"
VIP_ADDRESS="${VIP_ADDRESS}"
VIP_NETMASK="${VIP_NETMASK:-24}"
VIP_INTERFACE="${VIP_INTERFACE}"
```

- [ ] **Step 5.7: Add `VIP_NETMASK` to `cluster.conf.example`**

In `cluster.conf.example`, locate the VIP block (around lines 23–28):
```
# --- Virtual IP ---
# Set ENABLE_VIP="N" to skip vip-manager entirely. When enabled,
# both VIP_ADDRESS and VIP_INTERFACE are required.
ENABLE_VIP="Y"
VIP_ADDRESS="10.0.0.10"
VIP_INTERFACE="eth0"
```

Replace with:
```
# --- Virtual IP ---
# Set ENABLE_VIP="N" to skip vip-manager entirely. When enabled,
# both VIP_ADDRESS and VIP_INTERFACE are required. VIP_NETMASK is
# optional and defaults to 24 if not set.
ENABLE_VIP="Y"
VIP_ADDRESS="10.0.0.10"
VIP_NETMASK="24"
VIP_INTERFACE="eth0"
```

- [ ] **Step 5.8: Add `VIP_NETMASK` migration to `install.sh`**

In `install.sh`, after the `INTERNAL_SECRET` migration block added in Stage 1 Task 4, add:
```bash
        # Add VIP_NETMASK if missing (defaults to 24)
        if ! grep -q '^VIP_NETMASK=' cluster.conf 2>/dev/null; then
            if grep -q '^ENABLE_VIP="[Yy]"' cluster.conf 2>/dev/null; then
                # Insert VIP_NETMASK="24" immediately after VIP_ADDRESS line
                sed -i '/^VIP_ADDRESS=/a VIP_NETMASK="24"' cluster.conf
                echo "Added VIP_NETMASK=24 to cluster.conf"
            fi
        fi
```

- [ ] **Step 5.9: Syntax + shellcheck sweep**

Run:
```bash
bash -n configure.sh install.sh scripts/common.sh
shellcheck configure.sh install.sh scripts/common.sh
```
Expected: all clean.

- [ ] **Step 5.10: Commit**

```bash
git add scripts/common.sh tests/common.bats configure.sh cluster.conf.example install.sh
git commit -m "Add VIP_NETMASK config field and VIP_ETCD_ENDPOINTS template substitution"
```

---

## Task 6: Fix 2.4c — rewrite `templates/vip-manager.yml` to use new placeholders

**Files:**
- Modify: `templates/vip-manager.yml`
- Test: `tests/common.bats` (snapshot-style assertion)

- [ ] **Step 6.1: Write a failing snapshot test**

Append to `tests/common.bats`:
```bash
# ---- templates/vip-manager.yml ----

@test "vip-manager.yml renders with per-line etcd endpoints and netmask" {
    VIP_NETMASK="24"
    VIP_ADDRESS="10.0.0.100"
    VIP_INTERFACE="eth0"
    result=$(process_template "$BATS_TEST_DIRNAME/../templates/vip-manager.yml" 1)
    # Each etcd endpoint must be on its own line with 2-space indent
    [[ "$result" == *"  - https://10.0.0.1:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.2:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.3:2379"* ]]
    # Netmask must be substituted
    [[ "$result" == *"netmask: 24"* ]]
    # VIP address must be substituted
    [[ "$result" == *"ip: 10.0.0.100"* ]]
    # trigger-value must be the node name
    [[ "$result" == *"trigger-value: \"node-01\""* ]]
    # No placeholders remain
    [[ "$result" != *"{{"* ]]
}
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `bats tests/common.bats`
Expected: the new test FAILS because the current template uses `- {{ETCD_ENDPOINTS}}` (single-string) and hardcoded `netmask: 24`.

- [ ] **Step 6.3: Replace `templates/vip-manager.yml`**

Current contents:
```yaml
ip: {{VIP_ADDRESS}}
netmask: 24
interface: {{VIP_INTERFACE}}

trigger-key: /service/{{CLUSTER_NAME}}/leader
trigger-value: "{{NODE_NAME}}"

dcs-type: etcd
dcs-endpoints:
  - {{ETCD_ENDPOINTS}}

hosting-type: basic
retry-after: 2
retry-num: 3
```

Replace with:
```yaml
ip: {{VIP_ADDRESS}}
netmask: {{VIP_NETMASK}}
interface: {{VIP_INTERFACE}}

trigger-key: /service/{{CLUSTER_NAME}}/leader
trigger-value: "{{NODE_NAME}}"

dcs-type: etcd
dcs-endpoints:
{{VIP_ETCD_ENDPOINTS}}

hosting-type: basic
retry-after: 2
retry-num: 3
```

- [ ] **Step 6.4: Run the test to verify it passes**

Run: `bats tests/common.bats`
Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add templates/vip-manager.yml tests/common.bats
git commit -m "Use per-line etcd endpoints and VIP_NETMASK in vip-manager template"
```

---

## Task 7: Fix 2.4d — rewrite `05-setup-vip-manager.sh` to use the template (absorbs 6.3)

**Files:**
- Modify: `scripts/05-setup-vip-manager.sh`
- Modify: `versions.env` (add `VIP_MANAGER_VERSION`)

This task absorbs fix 6.3 (centralize vip-manager version in `versions.env`) per the spec's doc reconciliation table.

- [ ] **Step 7.1: Add `VIP_MANAGER_VERSION` to `versions.env`**

In `versions.env`, the current content is:
```bash
ETCD_VERSION="3.5.21"
```

Replace with:
```bash
ETCD_VERSION="3.5.21"
VIP_MANAGER_VERSION="2.6.0"
```

- [ ] **Step 7.2: Rewrite `scripts/05-setup-vip-manager.sh`**

Current file (lines 1–87) generates the config inline and hardcodes the version. Replace the **entire file** with:
```bash
#!/bin/bash
# ================================================================
# Set up vip-manager on a database node (auto-detects which node)
# Run on each DB node: sudo ./scripts/05-setup-vip-manager.sh
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"
# shellcheck disable=SC1091
[ -f "${BASE_DIR}/versions.env" ] && source "${BASE_DIR}/versions.env"
load_config

if [[ "${ENABLE_VIP}" != "Y" && "${ENABLE_VIP}" != "y" ]]; then
    echo "VIP is not enabled in cluster.conf. Skipping."
    exit 0
fi

NODE_NUM=$(get_current_node)
NODE_NAME=$(get_node_name "$NODE_NUM")
NODE_IP=$(get_node_ip "$NODE_NUM")

echo "=== Setting up vip-manager on ${NODE_NAME} (${NODE_IP}) ==="
echo "    Virtual IP:   ${VIP_ADDRESS}"
echo "    Netmask:      ${VIP_NETMASK:-24}"
echo "    Interface:    ${VIP_INTERFACE}"

# Auto-detect interface if the configured one doesn't exist, then export
# VIP_INTERFACE so process_template picks it up.
IFACE="${VIP_INTERFACE}"
if ! ip link show "${IFACE}" &>/dev/null; then
    DETECTED=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo | head -1)
    echo "Interface '${IFACE}' not found. Using detected: ${DETECTED}"
    IFACE="${DETECTED}"
    export VIP_INTERFACE="${IFACE}"
fi

# Install vip-manager
VIP_VERSION="${VIP_MANAGER_VERSION:-2.6.0}"
apt-get update
apt-get install -y vip-manager2 || {
    echo "vip-manager2 not in apt repos, installing from GitHub release v${VIP_VERSION}..."
    wget -q "https://github.com/cybertec-postgresql/vip-manager/releases/download/v${VIP_VERSION}/vip-manager_${VIP_VERSION}_linux_amd64.deb" -O /tmp/vip-manager.deb
    dpkg -i /tmp/vip-manager.deb
    rm /tmp/vip-manager.deb
}

# Render config from the template
process_template "${TEMPLATES_DIR}/vip-manager.yml" "$NODE_NUM" > /etc/default/vip-manager.yml

echo "vip-manager config written to /etc/default/vip-manager.yml"

# Always override the systemd service to use our YAML config
mkdir -p /etc/systemd/system/vip-manager.service.d
cat > /etc/systemd/system/vip-manager.service.d/override.conf << 'SVCEOF'
[Service]
ExecStart=
ExecStart=/usr/bin/vip-manager --config /etc/default/vip-manager.yml
SVCEOF

systemctl daemon-reload
systemctl enable vip-manager
systemctl start vip-manager

echo ""
echo "=== vip-manager started on ${NODE_NAME} ==="
echo ""
echo "Check: systemctl status vip-manager"
echo "Check: ip addr show ${IFACE} | grep ${VIP_ADDRESS}"
echo "Test:  psql -h ${VIP_ADDRESS} -U postgres -c 'SELECT inet_server_addr();'"
```

- [ ] **Step 7.3: Syntax check**

Run: `bash -n scripts/05-setup-vip-manager.sh versions.env`
Expected: clean.

- [ ] **Step 7.4: Shellcheck**

Run: `shellcheck scripts/05-setup-vip-manager.sh`
Expected: no new warnings beyond pre-existing `SC1091`.

- [ ] **Step 7.5: Smoke test the rendered config**

Run:
```bash
TMP=$(mktemp -d)
cp -r scripts templates versions.env "$TMP/"
cat > "$TMP/cluster.conf" << 'EOF'
CLUSTER_NAME="smoke-test"
NODE_COUNT=3
NODE_1_NAME="n1"
NODE_1_IP="10.0.0.1"
NODE_2_NAME="n2"
NODE_2_IP="10.0.0.2"
NODE_3_NAME="n3"
NODE_3_IP="10.0.0.3"
ENABLE_VIP="Y"
VIP_ADDRESS="10.0.0.100"
VIP_NETMASK="24"
VIP_INTERFACE="eth0"
PG_HBA_SUBNET="10.0.0.0/24"
PG_VERSION="16"
PG_PORT="5432"
PG_DATA_DIR="/var/lib/postgresql/16/main"
PG_BIN_DIR="/usr/lib/postgresql/16/bin"
PG_MAX_CONN="100"
PG_SUPERUSER_PASS="x"
PG_REPLICATOR_PASS="x"
PG_ADMIN_PASS="x"
ETCD_TOKEN="abc"
EOF
(
  cd "$TMP"
  BASE_DIR="$TMP"
  CONF_FILE="$TMP/cluster.conf"
  TEMPLATES_DIR="$TMP/templates"
  # shellcheck disable=SC1090
  source "$TMP/cluster.conf"
  source "$TMP/scripts/common.sh"
  process_template "$TMP/templates/vip-manager.yml" 1
)
rm -rf "$TMP"
```
Expected output contains `ip: 10.0.0.100`, `netmask: 24`, `  - https://10.0.0.1:2379` on its own line, and no `{{…}}` placeholders.

- [ ] **Step 7.6: Stage-closing commit — uses the fixes doc's prescribed message**

```bash
git add scripts/05-setup-vip-manager.sh versions.env
git commit -m "fix: prevent crash on version check, add data-wipe confirmations, fix vip-manager template

Stage 2 of the remediation plan. This commit rewrites 05-setup-vip-manager.sh
to use the fixed template and sources VIP_MANAGER_VERSION from versions.env
(absorbing fix 6.3 per the spec's doc reconciliation). Preceding commits in
this stage group:

- 2.1 import https module in web/src/app.js (crash fix)
- 2.2 prompt before wiping etcd data in standalone script
- 2.3 prompt before wiping Patroni data in standalone script
- 2.4a add get_vip_etcd_endpoints helper
- 2.4b add VIP_NETMASK config field and VIP_ETCD_ENDPOINTS substitution
- 2.4c rewrite vip-manager.yml template
- 2.4d (this commit) rewrite 05-setup-vip-manager.sh to use the template"
```

---

## Stage 2 close-out

- [ ] **Step 8.1: Full regression sweep**

Run:
```bash
(cd web && npm test)
bats tests/
shellcheck scripts/*.sh configure.sh install.sh update.sh
bash -n configure.sh install.sh scripts/*.sh versions.env
```
Expected: all tests green; no new shellcheck warnings; all `bash -n` clean.

- [ ] **Step 8.2: Final sanity check**

```bash
git log --oneline $(git merge-base main HEAD)..HEAD
```
Expected: Stage 1's 8 commits followed by Stage 2's 7 commits (one per Task 1–7; Task 7 is the stage-closer carrying the fixes doc's prescribed message). 15 commits total on the branch so far.

Stage 2 is complete. Proceed to Stage 3a only after the above is green.
