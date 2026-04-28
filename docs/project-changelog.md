# Changelog

All notable changes are documented here.

---

## [0.1] - 2026-04-28

Initial release.

### Cluster

- Automated PostgreSQL HA cluster setup with Patroni + etcd + vip-manager on Debian/Ubuntu
- Streaming replication with automatic failover — Patroni promotes a replica within seconds of primary failure
- Floating virtual IP (vip-manager) that always points to the current primary — no connection string changes needed
- Any number of nodes, any PostgreSQL version — auto-detects installed version or installs your choice
- Interactive configuration wizard (`configure.sh`) — one run generates a complete `cluster.conf`, zero hardcoded values
- Single-command full setup (`scripts/cluster-setup.sh`) — auto-detects node role by IP, runs all five steps in order
- Join mode — new nodes can join an existing live cluster by fetching config from the primary
- etcd TLS with mutual peer authentication and client certificate auth
- Patroni REST API secured with HTTP basic auth
- Synchronous replication mode with one synchronous standby
- Numbered scripts runnable individually: `01-packages`, `02-etcd`, `03-patroni`, `04-verify`, `05-vip`

### Monitoring Dashboard

- Real-time React web UI on every node, accessible via the floating VIP on port `8080`
- HTTPS only — auto-generates a self-signed cert with SAN if no Patroni cert is available
- Session auth with scrypt password hashing (N=16384)
- CSRF protection via Double Submit Cookie pattern
- Sliding-window login rate limiter (5 attempts per 60 s per IP)
- Four themes: dark, light, Nord Dark, Nord Light
- Summary tab — nodes up/total, leader, uptime, database count, system resources
- Nodes tab — per-node role, state, version, timeline, replication lag
- Node detail — memory, CPU, load, connection breakdown
- Databases tab — size, cache hit ratio, connections, deadlocks, object counts
- Backups tab — Borg archive list, create / delete / restore from UI
- Settings tab — config editing, password change, appearance, config export, version check
- Switchover and failover controls
- Database creation from the dashboard
- Polling pauses when the tab is hidden (Page Visibility API)

### Backups

- Borg backup with `repokey-blake2` encryption
- NFS and SMB/CIFS offsite storage, configurable from the dashboard
- Configurable daily/weekly/monthly retention
- Pre-restore safety backup before any restore
- Archive integrity verification after each backup
- `flock` prevents concurrent cron runs from corrupting the Borg repo
- Majority-vote leader detection across all Patroni nodes before backup runs
- `PGSSLMODE=require` for all PostgreSQL connections

### Remote Access

- Cloudflare Tunnel with HA token-based connectors on all nodes
- Cloudflare Hyperdrive edge connection pooling for Workers
- Zero Trust Access policy support

### Operations & Security

- `update.sh` — config-preserving upgrade with pre-deploy snapshot and automatic rollback on failure
- Structured daily log files with credential redaction
- Task state persistence survives dashboard restarts
- Per-database connection pool caching
- Graceful HTTPS server shutdown on SIGTERM/SIGINT
- GitHub Actions CI: ShellCheck, YAML lint, JS syntax, BATS, Jest
- Dependabot for npm, pip, and GitHub Actions dependencies
