# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
