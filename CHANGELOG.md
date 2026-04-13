# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- Lock down internal endpoints with `X-Internal-Token` authentication (1.1)
- Validate archive name in restore endpoint to prevent command injection (1.2)
- Move cloudflared tunnel token to mode-600 EnvironmentFile (1.3)
- Use escapeIdentifier/escapeLiteral in Hyperdrive create-user SQL (3.1)
- Validate config keys in updateConfKeys to block regex injection (3.2)
- Use timing-safe hash comparison for login authentication (3.3)
- Enable etcd client certificate authentication (3.4)
- Drop dashboard from root to postgres with sudoers policy (3.5)
- Reject empty BORG_PASSPHRASE in backup scripts (4.2)

### Fixed
- Add missing `https` import to fix version-check crash (2.1)
- Add data-wipe confirmations to standalone etcd/Patroni scripts (2.2, 2.3)
- Fix vip-manager template etcd endpoints and add VIP_NETMASK (2.4)
- Add disk space pre-check before pg_dumpall (4.1)
- Add backup integrity verification after borg create (4.3)
- Fix Patroni API auth in backup script (4.6)
- Set ETCD_INITIAL_CLUSTER_STATE=existing on node re-join (6.1)
- Enable Patroni REST API over HTTPS (6.4)

### Added

- LICENSE (MIT), CONTRIBUTING.md, CHANGELOG.md, and `cluster.conf.example`
  for repo hygiene.
- `requirements.txt` pins Patroni and `psycopg2-binary` to known-good versions.
- `versions.env` is now the single source of truth for the etcd
  GitHub-release version, replacing duplicated literals across scripts.
- `setup.sh --dry-run` prints a plan and exits without changing host state.
- `update.sh --dry-run` lists the commits and files that would be pulled.
- `update.sh` deploy phase now installs an EXIT trap that resets the repo
  to the pre-pull commit if any post-pull step fails.
- `validate_config()` in `scripts/common.sh` runs after sourcing
  `cluster.conf` and fails fast on missing fields or invalid IPs.
- Restore endpoint requires explicit confirmation and creates pre-restore safety backup (5.1)
- React restore UI shows stronger confirmation warning (5.2)
- Disaster recovery documentation (5.3)
- Shared PG connection pool in cluster.js (6.2)
- Use /etc/cron.d/pg-backup instead of appending to /etc/crontab (4.4)
- Add logrotate for pg-backup.log (4.5)
- Centralize vip-manager version in versions.env (6.3, absorbed into 2.4)
- Comprehensive test coverage for validation, backup, and auth (7.1-7.3)

### Changed

- `setup.sh` no longer wipes etcd data or `PG_DATA_DIR` on re-runs when
  the cluster is already healthy. Use `--force` to override.
- Web dashboard refactored: `server.js` is now a 38-line wrapper around
  `web/src/app.js`. Express routes are mounted as separate routers.
- React frontend is built with Vite instead of inline Babel-Standalone.
  Source lives under `web/src/components/`; built assets go to `web/dist/`
  (preferred) and fall back to `web/public/` if `dist/` is absent.
- All Patroni installs now use `pip install -r requirements.txt` instead
  of pulling the latest packages at install time.

### Security

- etcd peer/client TLS via a generated CA, with SANs for each node.
- Borg backup repo encryption (`repokey-blake2`) with auto-generated
  passphrase stored in `cluster.conf`.
- Patroni REST API protected with HTTP basic auth.
- Dashboard runs over HTTPS when PostgreSQL SSL certs are present.
- All third-party CDN assets pinned with SRI hashes.

### Tests / CI

- BATS suite for `scripts/common.sh` (13 tests).
- Jest + Supertest suite for the dashboard API (8 tests).
- GitHub Actions workflow runs both suites + `shellcheck` on every push.
- Dependabot configured for `npm` and `github-actions` ecosystems.

## [0.1.0] - 2026-04-04

### Added

- Initial release: Patroni + etcd + vip-manager bootstrap, monitoring
  dashboard, Borg backups, Cloudflare Tunnel and Hyperdrive integration.
