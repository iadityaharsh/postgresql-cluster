# Contributing

Thanks for your interest in `postgresql-cluster`. This project automates a
production PostgreSQL HA stack — patches that improve reliability,
documentation, or test coverage are very welcome.

## Reporting issues

Open an issue with:

- Distro and version (`lsb_release -a`)
- PostgreSQL and Patroni versions
- A minimal reproduction (config snippet, command run, observed output)
- Relevant logs: `journalctl -u patroni -n 200`, `journalctl -u etcd -n 200`

If the bug only appears under failover or restart, include the steps used to
trigger the failover and the output of `patronictl list` before and after.

## Development setup

```bash
git clone https://github.com/iadityaharsh/postgresql-cluster.git
cd postgresql-cluster
cd web && npm install
```

## Tests

Two suites must pass before opening a PR:

```bash
# Shell tests (BATS — exercises scripts/cluster-common.sh)
bats tests/

# Web API tests (Jest + Supertest — exercises web/server.js routes)
cd web && npm test
```

Both also run automatically in CI on every push and PR.

## Coding style

- **Shell:** `set -euo pipefail` at the top, `shellcheck`-clean. Prefer
  `[ ... ]` over `[[ ... ]]` unless you need bash-only features.
- **JavaScript:** match the existing style in `web/src/`. The dashboard is
  React 18 with Vite. No build step is required for `web/server.js` —
  it ships as a thin wrapper around `web/src/app.js`.
- **Idempotency:** any script that mutates host state must be safe to
  re-run. Guard destructive operations behind `--force` and provide a
  `--dry-run` plan output where it makes sense.

## Commit messages

- Single-purpose commits — one concern per commit.
- Imperative subject line (`Add ...`, `Fix ...`, `Refactor ...`),
  72 chars max.
- Body explains *why* the change is needed, not just *what* changed.
- Sole author is Aditya Harsh — do not add `Co-Authored-By` trailers.

## Release process

1. Update `project-changelog.md` under a new version heading.
2. Bump `VERSION`.
3. Tag with `git tag -a vX.Y.Z -m "vX.Y.Z"` and push tags.
4. The dashboard's "Check for Updates" button reads tags from GitHub.
