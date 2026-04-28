# Cluster Quick Start

## Overview

Automated setup for a highly available PostgreSQL cluster using Patroni, etcd, and vip-manager. Supports any number of nodes, any IPs, and built-in monitoring.

## Setup

### 1. Configure (on any node)

```bash
./configure.sh
```

### 2. Copy to all other nodes

```bash
scp -r postgresql-cluster/ root@<NODE_IP>:/root/
```

### 3. Run setup on each node

Start with **Node 1 first**, then the remaining nodes:

```bash
sudo ./postgresql-cluster/scripts/cluster-setup.sh
```

The script auto-detects the node role and handles everything — packages, etcd, Patroni, VIP, and the monitoring dashboard.

## Access Points

| Service          | URL / Address         | Credentials   |
|------------------|-----------------------|---------------|
| Database VIP     | `<VIP>:5432`          | your db creds |
| Monitor Dashboard| `http://<VIP>:8080`   | (no auth)     |

## Common Operations

```bash
# Check cluster status
patronictl -c /etc/patroni/config.yml list

# Planned switchover (promote a replica)
patronictl -c /etc/patroni/config.yml switchover

# Emergency failover (primary is down)
patronictl -c /etc/patroni/config.yml failover

# Restart PostgreSQL on a node
patronictl -c /etc/patroni/config.yml restart <cluster-name> <node-name>

# Reload PostgreSQL config
patronictl -c /etc/patroni/config.yml reload <cluster-name>

# View logs
journalctl -u patroni -f
journalctl -u etcd -f
journalctl -u pg-monitor -f
```

## Updating

Use the **Check for Updates** button in the dashboard header — upgrades all nodes automatically.

Or manually:

```bash
cd ~/postgresql-cluster && git fetch origin --tags -f && git pull origin main && bash update.sh
```

## Files

```
postgresql-cluster/
├── configure.sh              — Interactive config wizard (run first)
├── cluster.conf              — Generated settings (sourced by all scripts)
├── install.sh                — One-line installer
├── update.sh                 — Config-preserving upgrade script
├── docs/
│   ├── cluster-quick-start.md
│   ├── cluster-setup.md
│   └── cloudflare-tunnel.md      — Cloudflare Tunnel & Workers guide
├── scripts/
│   ├── cluster-setup.sh              — Unified setup (run this on each node)
│   ├── cluster-common.sh             — Shared functions & config loader
│   ├── 01-packages.sh
│   ├── 02-etcd.sh
│   ├── 03-patroni.sh
│   ├── 04-verify.sh
│   ├── 05-vip.sh
│   ├── cluster-monitor.sh      — Dashboard installer
│   ├── backup-setup.sh       — Borg backup with NFS/SMB
│   ├── cloudflare-tunnel.sh       — Cloudflare Tunnel setup
│   ├── backup-run.sh          — Backup cron script
│   └── templates/            — Config templates rendered at deploy time
│       ├── etcd.env
│       ├── patroni.yml
│       └── vip-manager.yml
└── web/
    ├── server.js             — Express API (queries Patroni + PostgreSQL)
    ├── package.json
    └── public/
        └── index.html        — React monitoring dashboard
```

## Important Notes

- **Passwords**: The configure wizard auto-generates secure passwords. Stored in `cluster.conf` (chmod 600).
- **Patroni manages PostgreSQL**: Do NOT use `systemctl start/stop postgresql` directly.
- **etcd quorum**: Requires a majority (2 of 3) to function. Losing 2 nodes = read-only cluster.
- **Adding nodes**: Run `configure.sh` again with the new node count, copy to the new node, run `cluster-setup.sh`.
