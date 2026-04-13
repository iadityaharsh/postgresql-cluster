# PostgreSQL HA Cluster
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/github/v/tag/iadityaharsh/postgresql-cluster?label=VERSION)
![Platform](https://img.shields.io/badge/platform-Debian%20%7C%20Ubuntu-orange)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-336791?logo=postgresql&logoColor=white)
![Patroni](https://img.shields.io/badge/HA-Patroni-green)

Automated setup for a highly available PostgreSQL cluster with automatic failover, built-in monitoring dashboard, and backups.

Built on **Patroni + etcd + vip-manager** — runs on bare metal, VMs, or LXC containers.

## Quick Install

**1. Clone and configure (on any node):**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/iadityaharsh/postgresql-cluster/main/install.sh)
```

**2. Copy to all other nodes:**

```bash
scp -r postgresql-cluster/ root@<NODE_IP>:/root/
```

**3. Run setup on each node:**

```bash
sudo ./postgresql-cluster/scripts/setup.sh
```

That's it. The script auto-detects which node it's running on (by matching IP from `cluster.conf`) and runs the entire setup — packages, etcd, Patroni, VIP, and the monitoring dashboard.

> **Note:** Start Node 1 first, then the remaining DB nodes (together is fine). The setup script waits for peers and the leader automatically.

## How It Works

The setup script runs these steps automatically on each node:

1. **Install packages** — Detects if PostgreSQL is already installed. If not, recommends the latest version and installs it. Also installs etcd and Patroni.

2. **Start etcd** — Configures and starts the distributed key-value store. Waits up to 150 seconds for all peers to join the cluster.

3. **Start Patroni** — Configures PostgreSQL high availability. On Node 1, waits to become Leader. On other nodes, waits for the Leader to be available before joining as a replica.

4. **Setup VIP** — Installs vip-manager for a floating virtual IP that always points to the current primary. Applications connect to one stable address.

5. **Monitoring dashboard** — Installs a real-time React web UI on each node. Accessible via `VIP:8080`. Shows cluster status, node roles, replication lag, connections, and database info — updates every 2 seconds.

## Architecture

```
  ┌────────────────────┐              ┌──────────────────────────────┐
  │  Local Applications│              │  Remote Applications         │
  │  VIP:5432          │              │  cloudflared proxy / Workers │
  └────────┬───────────┘              └──────────────┬───────────────┘
           │                                         │
           │              ┌────────────────────┐     │
           │              │  Cloudflare Edge   │◄────┘
           │              │  (Zero Trust)      │
           │              └─────────┬──────────┘
           │                        │ (optional)
           │                   ┌────┘
           │                   ▼
           │              ┌──────────┐
           └─────────────►│ VIP      │
                          └────┬─────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│ Node 1            │ │ Node 2            │ │ Node 3            │
│ PostgreSQL        │ │ PostgreSQL        │ │ PostgreSQL        │
│ Patroni           │ │ Patroni           │ │ Patroni           │
│ etcd              │ │ etcd              │ │ etcd              │
│ vip-manager       │ │ vip-manager       │ │ vip-manager       │
│ cloudflared       │ │ cloudflared       │ │ cloudflared       │
│ Monitor UI (:8080)│ │ Monitor UI (:8080)│ │ Monitor UI (:8080)│
└───────────────────┘ └───────────────────┘ └───────────────────┘
     PRIMARY               REPLICA               REPLICA
```

## Features

- **Any number of nodes** — not limited to 3
- **Any PostgreSQL version** — auto-detects installed version or installs your choice
- **Automatic failover** — Patroni promotes a replica within seconds if the primary goes down
- **Floating VIP** — applications never need to update connection strings
- **Interactive setup** — one config wizard, zero hardcoded values
- **Built-in monitoring** — real-time React dashboard on every node, accessible via VIP
- **Backups** — Borg backup with NFS or SMB offsite storage, configurable from the dashboard
- **Remote access** — Cloudflare Tunnel with token-based HA connectors on all nodes
- **Multi-theme UI** — dark, light, nord-dark, and nord-light themes
- **Auto-upgrade** — check for updates and upgrade directly from the dashboard
- **Config export** — download cluster configuration backup from the Settings tab

## Updating

Use the **Check for Updates** button in the dashboard header — upgrades all cluster nodes automatically.

Or manually:

```bash
cd ~/postgresql-cluster && git fetch origin --tags -f && git pull origin main && bash update.sh
```

## Requirements

- Debian/Ubuntu on all nodes
- Root/sudo access
- Network connectivity between nodes on ports 2379, 2380, 5432, 8008, 8080

## Running on LXC Containers

If your nodes are LXC containers and you're using VIP (floating IP), vip-manager needs the `NET_ADMIN` and `NET_RAW` capabilities. If you're not using VIP, you can skip this section.

**Check if your container has the required capabilities:**

Run this inside each DB container:

```bash
capsh --print | grep -oP 'cap_net_(admin|raw)' | sort -u
```

You should see:
```
cap_net_admin
cap_net_raw
```

If both appear, you're good — no changes needed.

**If the capabilities are missing, add them on the host:**

Proxmox:
```bash
pct stop <CTID>
pct set <CTID> -features nesting=1,keyctl=1
pct start <CTID>
```

LXD:
```bash
lxc config set <container-name> security.nesting true
lxc restart <container-name>
```

> **Warning:** Do NOT use `lxc.cap.keep` — it drops all other capabilities and prevents the container from booting.

## Documentation

- **[Quick Start](docs/QUICK-START.md)** — Step-by-step setup commands
- **[Detailed Setup](docs/SETUP.md)** — Full documentation and common operations
- **[Remote Access](docs/remote-access.md)** — Cloudflare Tunnel (token-based HA), Access policies, Workers
- **[Hyperdrive](docs/hyperdrive.md)** — Connect Cloudflare Workers to the cluster via Hyperdrive (edge connection pooling)
- **[Disaster Recovery](docs/DISASTER-RECOVERY.md)** — Backup listing, integrity verification, recovery scenarios

## Contributing

Bug reports, patches, and reviews are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the test suite,
and the release process. Notable changes are tracked in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) — © Aditya Harsh
