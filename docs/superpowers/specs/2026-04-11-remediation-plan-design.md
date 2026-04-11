# PostgreSQL Cluster Remediation Plan — Design Spec

**Date:** 2026-04-11
**Author:** Aditya Harsh
**Source document:** `postgresql-cluster-fixes.md` (1063 lines, 7 stages, ~25 fixes)
**Status:** Design approved; ready for implementation-plan generation

---

## Goal

Execute the full security/robustness remediation described in
`postgresql-cluster-fixes.md` as eight sequenced, test-driven stage groups
(one per fix commit, ~25 commits total) on a long-running branch, landing
on `main` only after the whole remediation is green in CI and smoke-tested
end-to-end.

## Non-goals

- Rewriting the fixes doc's recommended fixes. The doc is prescriptive
  and treated as the source of truth for *what* to change; this spec
  governs *how* the work is structured, tested, and rolled out.
- Architectural changes beyond what the doc calls for. No refactors,
  no new abstractions, no "while we're here" cleanup.
- Version bumps or tagging. Per the user's standing preference, version
  tagging is an explicit ask at the end, not implicit.

## Scope

**In scope** (from the fixes doc, organized into 8 stage groups across 7 stages; each group contains one commit per fix plus a stage-closing commit carrying the doc's prescribed message):

| Group | Stage | Fixes |
|---|---|---|
| 1 | **1 — Critical auth/injection** | 1.1 `INTERNAL_SECRET` + lock `INTERNAL_PATHS`; 1.2 archive-name validation in restore; 1.3 cloudflared tunnel token via `EnvironmentFile`; 1.4 `cluster.conf.example` additions |
| 2 | **2 — Crash + data loss** | 2.1 missing `https` import in `web/src/app.js`; 2.2 `02-setup-etcd.sh` data-wipe confirmation; 2.3 `03-setup-patroni.sh` data-wipe confirmation; 2.4 vip-manager template + `VIP_NETMASK` + **absorbs 6.3's vip-manager version centralization** |
| 3 | **3a — Injection hardening** | 3.1 SQL injection via `escapeIdentifier`/`escapeLiteral`; 3.2 regex-injection key validation in `updateConfKeys`; 3.3 timing-safe scrypt comparison; 3.4 etcd client certificate authentication |
| 4 | **3b — Drop dashboard to non-root** | 3.5 sudoers policy + `sudo` prefix on every privileged `spawn`/`execSync` + systemd `User=postgres`. Isolated from 3a for rollback safety |
| 5 | **4 — Backup creation hardening** | 4.1 disk-space pre-check; 4.2 reject empty `BORG_PASSPHRASE`; 4.3 `borg check` integrity verification; 4.4 `/etc/cron.d/pg-backup`; 4.5 logrotate (**absorbs 6.5**); 4.6 Patroni API auth in backup script |
| 6 | **5 — Backup recovery safety** | 5.1 restore confirmation + pre-restore safety backup + progress reporting; 5.2 React UI `ConfirmModal` wire-up; 5.3 `docs/DISASTER-RECOVERY.md` |
| 7 | **6 — Operational robustness** | 6.1 etcd `INITIAL_CLUSTER_STATE=existing` on rejoin; 6.2 shared PG connection pool; 6.4 Patroni REST API over HTTPS. (6.3 and 6.5 absorbed into earlier stages.) |
| 8 | **7 — Coverage verification** | Verify per-stage TDD produced the tests the fixes doc lists under 7.1, 7.2, 7.3; add anything missed; confirm CI job discovers the new test files |

**Out of scope:** WAL archiving / pgBackRest (the doc mentions it as a
limitation in 5.3's DR doc but does not fix it); non-security frontend
improvements; any change to the auto-upgrade mechanism itself.

## Branch + commit strategy

**Branch:** `remediation/security-fixes` off `main` at commit `ca2e5c7`
(current `main` head).

**Baseline commit** (before the branch): this spec lands on `main`
first. The branch is then cut from the spec commit so the design is
present in both histories.

**Commit cadence inside the branch:** **per fix, not per stage.** The
fixes doc suggests one commit per stage (8 stage commits); we will
produce one commit per fix (~25 commits) so rollback granularity
matches fix granularity. The final commit of each stage carries the
doc's prescribed stage commit message; intermediate commits have
fix-specific subject lines. The 8 "stage groups" in the scope table
above refer to these stage-closing commits; the work inside each
group is still decomposed per-fix.

**Merge to main:** `git merge --no-ff remediation/security-fixes` after
all stages are green. The `--no-ff` merge preserves the branch
boundary so `git revert -m 1 <merge-commit>` can atomically back out
the whole remediation, and per-fix reverts remain possible because
the branch history stays intact.

## Dependency graph

```
Stage 1 ─────────────────────────────┐
  1.1 INTERNAL_SECRET (foundational) │
  1.2 restore archive validation     │
  1.3 tunnel token EnvFile           │
  1.4 conf example                   │
        │                            │
        ▼                            │
Stage 2                              │
  2.1 https import                   │
  2.2 etcd confirm                   │
  2.3 patroni confirm                │
  2.4 vip-manager template ─┐        │
      (absorbs 6.3)         │        │
        │                   │        │
        ▼                   │        │
Stage 3a                    │        │
  3.1 SQL injection         │        │
  3.2 regex injection       │        │
  3.3 timing-safe hash      │        │
  3.4 etcd cert auth ───┐   │        │
        │               │   │        │
        ▼               │   │        │
Stage 3b (risk-gated)   │   │        │
  3.5 drop root         │   │        │
        │               │   │        │
        ▼               │   │        │
Stage 4                 │   │        │
  4.1–4.6 backup        │   │        │
    (4.5 absorbs 6.5)   │   │        │
        │               │   │        │
        ▼               │   │        │
Stage 5                 │   │        │
  5.1 restore safety ◄──┼───┼────────┘
      (builds on 1.2)   │   │
  5.2 UI confirm        │   │
  5.3 DR doc            │   │
        │               │   │
        ▼               │   │
Stage 6                 │   │
  6.1 etcd rejoin       │   │
  6.2 PG pool           │   │
  6.4 Patroni HTTPS ◄───┘   │
      (reuses 3.4 TLS pattern)
  (6.3 ✗ absorbed)          │
  (6.5 ✗ absorbed)          │
        │                   │
        ▼                   │
Stage 7                     │
  Coverage verification ◄───┘
```

**Hard ordering constraints:**

1. **1.1 must land before 6.4.** 6.4 (Patroni HTTPS) reuses the
   `X-Internal-Token` pattern established by 1.1.
2. **1.2 must land before 5.1.** 5.1 rewrites the restore handler and
   preserves 1.2's validation line — if 1.2 isn't there first, the
   rewrite regresses input validation.
3. **2.4 must land before 6.3's changes are possible.** Since 6.3 is
   absorbed into 2.4, this constraint is satisfied by construction.
4. **3a before 3b.** Dropping privilege (3b) while injection fixes
   (3a) are still unmerged widens the attack surface of the intermediate
   commits.
5. **Stage 7 after everything.** It verifies coverage of all prior
   stages.

**Soft ordering:** 6.4 benefits from landing after 3.4 so both reuse
the same cert-path + `rejectUnauthorized: false` convention.

## Doc reconciliations

| Issue in fixes doc | Resolution |
|---|---|
| 4.5 and 6.5 both install logrotate for `/var/log/pg-backup.log` | Keep in Stage 4 (4.5). Stage 6's plan explicitly drops 6.5 |
| 2.4 and 6.3 both rewrite `scripts/05-setup-vip-manager.sh` | Fold 6.3 into Stage 2 (2.4) so the file is touched once. Stage 6's plan drops 6.3 |
| 1.2 and 5.1 both touch the restore handler | 1.2 lands first as a one-liner; 5.1 rewrites the handler later, preserving the validation line |
| Line numbers in the doc reference pre-modularization code | Plans reference files by **symbol or stable anchor** (function name, `const INTERNAL_PATHS`, `router.post('/restore')`). Where a literal line number is needed, the plan runs `Grep` at write-time to find the current line |
| 3.5 sudoers includes wildcards like `systemctl stop *` | Plan replaces wildcards with exact full-argument forms (`systemctl restart pg-monitor`, etc.). Wildcard sudoers entries are an argv-injection vector |
| 3.5 `spawn('bash', ['-c', 'mount ...'])` shell-string form | Plan rewrites these as `spawn('sudo', ['mount', ...])` argv form, not shell strings |

## TDD boundaries

Per the test-cadence decision: TDD for everything with a test hook,
manual verification for the rest.

| Surface | Framework | TDD? |
|---|---|---|
| Express routes / middleware (`web/src/routes/*`, `web/src/middleware/*`, `web/src/app.js`) | Jest + Supertest | **Yes** — failing test in `web/__tests__/` first |
| `scripts/common.sh` functions (`validate_config`, `get_vip_etcd_endpoints`) | BATS in `tests/common.bats` | **Yes** — failing `@test` first |
| React components (`BackupsTab.jsx` restore confirmation) | Manual browser verification | **No formal TDD** — plan documents manual test steps |
| Shell scripts mutating host state (`02-setup-etcd.sh`, `03-setup-patroni.sh`, `05-setup-vip-manager.sh`, `setup-monitor.sh` sudoers) | `shellcheck` + `bash -n` + smoke test in throwaway path | **No formal TDD** — plan includes a verify-in-temp-dir step |
| Templates (`etcd.env`, `patroni.yml`, `vip-manager.yml`) | BATS snapshot via `process_template` | **Yes where feasible** — assert rendered output contains expected lines |
| Documentation (`DISASTER-RECOVERY.md`) | N/A | Prose review only |

## Risk gates

**Stage 1.1 gate** — before committing, verify manually:
1. `curl` each `INTERNAL_PATHS` endpoint without the header → expect `401`
2. `curl` same endpoints with the header → expect `200`
3. Node-to-node upgrade/restart round-trip works on a 3-node test setup
   (or single-node run simulating two IPs)

**Stage 3b gate (drop root)** — the highest-risk commit. All of the
following must pass on a throwaway/test environment before the commit
lands:
1. `sudo -u postgres sudo systemctl restart pg-monitor` succeeds
2. Dashboard `POST /api/restart/local` returns 200 and the service
   actually restarts
3. A backup triggered via the dashboard runs to completion and
   produces a borg archive
4. `PG_DASHBOARD_UPGRADE=1 bash update.sh` runs to completion with
   the postgres-user dashboard
5. `journalctl -u pg-monitor -n 200` shows no permission errors
6. If any of the above fails, **revert 3b before diagnosing**. Do not
   chain additional fixes onto a broken 3b commit

**Stage 5.1 gate** — restore is destructive. The plan includes a
smoke test against a **throwaway Docker Postgres or a dev node**, not
a live cluster. The pre-restore safety backup must be verifiable
(`borg list`) before the restore step is attempted.

## Per-stage Definition of Done

Every stage must satisfy all of:

- All TDD tests for the stage written and green
- `shellcheck scripts/*.sh` clean (pre-existing `SC1091`/`SC2034`
  warnings remain out of scope)
- `cd web && npm test` all green
- `bats tests/` all green
- `bash -n` clean on any modified shell script
- Stage 3b additionally requires the manual smoke-test sequence above
- CI run on the branch is green before the next stage begins

## Merge-to-main gate

Before merging `remediation/security-fixes` → `main`:

1. All seven stages committed; all eight stage-closing commits present on the branch
2. Final CI run on the branch is green
3. `CHANGELOG.md` updated with an entry describing the remediation
   under `[Unreleased]`
4. User confirmation to merge (per the standing "ask before pushing"
   pattern)
5. Merge command: `git merge --no-ff remediation/security-fixes`
6. Tagging is **not** automatic — user decides feature vs fix and
   whether to bump to `v0.2.0` post-merge

## Rollback strategy

- **Intra-stage:** `git reset --hard HEAD~N` on the branch to drop the
  last N per-fix commits
- **Inter-stage:** `git revert <stage-close-commit>` or reset to
  `remediation/security-fixes@{before-stage-N}`
- **Post-merge:** `git revert -m 1 <merge-commit>` reverts the entire
  remediation atomically; per-fix reverts still possible because
  `--no-ff` preserved the branch history

## Plan layout (per stage)

Each of the eight stage-group plans under `docs/superpowers/plans/`
(Stage 3 gets separate plans for 3a and 3b) will follow this structure:

1. **Preflight** — checkout branch, pull, confirm `npm test` and
   `bats tests/` are green before any change
2. **Per-fix tasks** in dependency order, each with writing-plans
   standard steps (failing test → verify fail → minimal implementation
   → verify pass → full-suite regression run → commit)
3. **Stage close-out** — `shellcheck scripts/*.sh`, `npm test`,
   `bats tests/`, risk-gate verification if applicable
4. **Stage commit message** — verbatim from the fixes doc for the
   final commit of the stage

## Open questions for implementation-plan phase

None blocking. The writing-plans phase will handle:

- Capturing current line numbers for each fix as it writes the tasks
- Deciding the exact set of BATS `@test` snapshots for each modified
  template
- Choosing the throwaway environment for Stage 3b's smoke test
  (likely a disposable LXC or a local Docker compose)

## References

- Source fixes document: `postgresql-cluster-fixes.md`
- Current HEAD: `ca2e5c7` (Repo hygiene: LICENSE, CONTRIBUTING,
  CHANGELOG, conf example)
- Prior remediation pattern: commits `f6d655b..ca2e5c7` (7-category
  improvements landed directly on `main`)
- Test entry points: `web/__tests__/server.test.js`,
  `tests/common.bats`
- CI workflow: `.github/workflows/ci.yml`
