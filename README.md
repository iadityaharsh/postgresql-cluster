# PostgreSQL HA Cluster

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/github/v/tag/iadityaharsh/postgresql-cluster?label=version)
![Platform](https://img.shields.io/badge/platform-Debian%20%7C%20Ubuntu-orange)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-336791?logo=postgresql&logoColor=white)
![Patroni](https://img.shields.io/badge/HA-Patroni-green)

Automated setup for a production-ready PostgreSQL cluster with streaming replication, automatic failover, a real-time monitoring dashboard, and Borg backups — all from a single config wizard.

Built on **Patroni + etcd + vip-manager**. Runs on bare metal, VMs, or LXC containers.

---

## Quick Install

Run this on any one node to clone the repo and launch the configuration wizard:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/iadityaharsh/postgresql-cluster/main/install.sh)
```

Then copy the configured repo to every other node and run setup:

```bash
# Copy to each additional node
scp -r postgresql-cluster/ root@<NODE_IP>:/root/

# Run on every node (start Node 1 first, then the rest together)
sudo ./postgresql-cluster/scripts/cluster-setup.sh
```

The script auto-detects which node it is by matching the IP from `cluster.conf` and runs the full setup — packages, etcd, Patroni, VIP, and the monitoring dashboard.

---

## How It Works

Each node runs five setup steps automatically:

1. **Packages** — Installs PostgreSQL (or detects existing), etcd, Patroni, and vip-manager.
2. **etcd** — Starts the distributed consensus store. Waits up to 150 s for all peers to join.
3. **Patroni** — Configures HA. Node 1 bootstraps as Leader; others join as replicas once the Leader is ready.
4. **VIP** — Installs vip-manager so applications always connect to the same address regardless of which node is primary.
5. **Dashboard** — Deploys a React monitoring UI on every node at `VIP:8080`.

---

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

---

## Features

| | |
|---|---|
| **Any node count** | Not limited to 3 — add as many replicas as needed |
| **Any PostgreSQL version** | Auto-detects installed version or installs your choice |
| **Automatic failover** | Patroni promotes a replica within seconds of primary failure |
| **Floating VIP** | Applications never need to update connection strings |
| **Interactive setup** | One config wizard, zero hardcoded values |
| **Monitoring dashboard** | Real-time React UI — cluster status, replication lag, connections, databases |
| **Borg backups** | NFS or SMB offsite storage, configurable from the dashboard |
| **Remote access** | Cloudflare Tunnel with HA token-based connectors on all nodes |
| **Auto-upgrade** | Check for updates and upgrade the full cluster from the dashboard |
| **Multi-theme UI** | Dark, light, Nord Dark, Nord Light |

---

## Updating

Use the **Check for Updates** button in the dashboard header — upgrades all nodes automatically.

Or manually on any node:

```bash
cd ~/postgresql-cluster && bash update.sh
```

---

## Requirements

- Debian or Ubuntu on all nodes
- Root / sudo access
- Ports open between nodes: `2379`, `2380` (etcd), `5432` (PostgreSQL), `8008` (Patroni API), `8080` (dashboard)

---

## LXC Containers

If running on LXC and using a floating VIP, vip-manager requires `NET_ADMIN` and `NET_RAW` capabilities. Check inside the container:

```bash
capsh --print | grep -oP 'cap_net_(admin|raw)' | sort -u
```

If either is missing, grant them on the host:

```bash
# Proxmox
pct stop <CTID> && pct set <CTID> -features nesting=1,keyctl=1 && pct start <CTID>

# LXD
lxc config set <name> security.nesting true && lxc restart <name>
```

> Do **not** use `lxc.cap.keep` — it drops all other capabilities and prevents the container from booting.

---

## Documentation

### Getting started
| | |
|---|---|
| [cluster-quick-start.md](docs/cluster-quick-start.md) | Step-by-step commands, what each step does |
| [cluster-setup.md](docs/cluster-setup.md) | Full configuration reference, all options, troubleshooting |

### Operations
| | |
|---|---|
| [cluster-disaster-recovery.md](docs/cluster-disaster-recovery.md) | Backup verification, restore procedures, recovery scenarios |
| [cloudflare-tunnel.md](docs/cloudflare-tunnel.md) | Cloudflare Tunnel — HA connectors, Access policies, Workers |
| [cloudflare-hyperdrive.md](docs/cloudflare-hyperdrive.md) | Cloudflare Hyperdrive — edge connection pooling for Workers |

### Reference
| | |
|---|---|
| [cluster.conf.example](docs/cluster.conf.example) | All configuration fields with descriptions |
| [project-contributing.md](docs/project-contributing.md) | Development setup, test suite, release process |
| [project-changelog.md](docs/project-changelog.md) | Release history |

---

## License

[MIT](LICENSE) — © Aditya Harsh
