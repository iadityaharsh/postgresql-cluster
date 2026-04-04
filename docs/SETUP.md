# PostgreSQL HA Cluster with Patroni + etcd

Automated setup for a highly available PostgreSQL cluster using Patroni, etcd, and vip-manager. Supports any number of nodes, any IPs, and built-in monitoring.

## Architecture

```
                    ┌──────────────────┐
                    │   Applications   │
                    │   VIP:5432       │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│ Node 1            │ │ Node 2            │ │ Node 3            │
│ PostgreSQL        │ │ PostgreSQL        │ │ PostgreSQL        │
│ Patroni           │ │ Patroni           │ │ Patroni           │
│ etcd              │ │ etcd              │ │ etcd              │
│ vip-manager       │ │ vip-manager       │ │ vip-manager       │
│ Monitor UI (:8080)│ │ Monitor UI (:8080)│ │ Monitor UI (:8080)│
└───────────────────┘ └───────────────────┘ └───────────────────┘
     PRIMARY               REPLICA               REPLICA
```

**Ports used:** 5432 (PostgreSQL), 8008 (Patroni REST API), 2379 (etcd client), 2380 (etcd peer), 8080 (Monitor UI)

## Pre-requisites

- Debian/Ubuntu on all nodes
- Root/sudo access on all nodes
- Network connectivity between all nodes on ports 2379, 2380, 5432, 8008, 8080

## Setup

### 1. Configure (on any node)

```bash
./configure.sh
```

This prompts for all cluster settings (IPs, hostnames, passwords, etc.) and generates `cluster.conf`.

### 2. Copy to all other nodes

```bash
scp -r postgresql-cluster/ root@<NODE_IP>:/root/
```

### 3. Run setup on each node

```bash
sudo ./postgresql-cluster/scripts/setup.sh
```

Start with **Node 1 first**, then the remaining nodes. The script auto-detects the node role by matching IP and handles everything automatically.

**What setup.sh does on each node:**
- Installs PostgreSQL (detects existing or installs new), etcd, and Patroni
- Configures and starts etcd (waits for peers to join)
- Configures and starts Patroni (Node 1 becomes Leader, others join as replicas)
- Sets up VIP manager (floating IP follows the primary)
- Installs the monitoring dashboard (React web UI on port 8080)

### 4. Verify

```bash
sudo ./scripts/04-verify-cluster.sh
```

Or open `http://<VIP>:8080` in your browser to see the real-time cluster dashboard.

## Individual Scripts

The setup.sh orchestrates these scripts automatically, but they can also be run individually if needed:

| Script | Purpose |
|--------|---------|
| `scripts/01-install-packages.sh` | Install PostgreSQL + etcd + Patroni |
| `scripts/02-setup-etcd.sh` | Configure & start etcd |
| `scripts/03-setup-patroni.sh` | Configure & start Patroni |
| `scripts/04-verify-cluster.sh` | Cluster health check |
| `scripts/05-setup-vip-manager.sh` | Floating VIP setup |
| `scripts/setup-monitor.sh` | Monitoring dashboard (Node.js + React) |
| `scripts/setup-backup.sh` | Borg backup with NFS/SMB storage |
| `scripts/setup-tunnel.sh` | Cloudflare Tunnel for remote access |
| `scripts/pg-backup.sh` | Backup cron job |

## Monitoring Dashboard

The built-in monitoring dashboard runs on every node and is accessible via `http://<VIP>:8080`.

**Tabs:**
- **Summary** — nodes up/total, current leader, uptime, databases, system stats
- **Nodes** — role, state, PostgreSQL version, timeline, replication status (click for detail)
- **Connections** — active/idle breakdown with usage bar, per-database stats
- **Settings** — remote access (Cloudflare Tunnel with token-based HA connectors), appearance (4 themes), configuration backup export
- **Backups** — Borg configuration (NFS/SMB, inline setup like Nextcloud AIO), backup archives with create/delete/restore

**Sidebar** — Proxmox-style tree navigation with search, expand/collapse, and resizable width

**Header** — version badge with update check, cluster health status, GitHub link with star count

The dashboard queries the Patroni REST API and PostgreSQL directly — no external dependencies. Data refreshes every 2 seconds.

## Updating

Use the **Check for Updates** button in the dashboard header — it upgrades all nodes automatically.

Alternatively, run manually on each node:

```bash
cd ~/postgresql-cluster && git fetch origin --tags -f && git pull origin main && bash update.sh
```

## Remote Access

Set up secure database access over the internet using Cloudflare Tunnel. Create a tunnel in Cloudflare Zero Trust, paste the token in the dashboard (**Settings > Remote Access**), and all nodes are configured as connectors automatically for HA.

See **[docs/remote-access.md](remote-access.md)** for full setup guide including Access policies, Workers, Hyperdrive, and Pages integration.

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

## Important Notes

- **Passwords**: The configure wizard auto-generates secure passwords. Stored in `cluster.conf` (chmod 600).
- **Patroni manages PostgreSQL**: Do NOT use `systemctl start/stop postgresql` directly after setup.
- **Existing data**: If Node 1 has existing data, back it up before running setup. The script warns and gives 10 seconds to abort.
- **etcd quorum**: etcd requires a majority (2 of 3) to function. Losing 2 etcd nodes makes the cluster read-only.
- **Adding nodes**: Run `configure.sh` again with the new node count, copy to the new node, and run `setup.sh`.
