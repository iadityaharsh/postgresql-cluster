#!/bin/bash
# ================================================================
# Install and configure the cluster monitoring web UI
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cluster-common.sh"
load_config

BASE_DIR="$(dirname "$SCRIPT_DIR")"
MONITOR_PORT="${MONITOR_PORT:-8080}"

SUDOERS_ONLY=false
[[ "${1:-}" == "--sudoers-only" ]] && SUDOERS_ONLY=true

if [ "${SUDOERS_ONLY}" = false ]; then
echo "--- Setting up cluster monitoring dashboard ---"

# Install Node.js if not present
if ! command -v node &>/dev/null; then
    echo "Installing Node.js..."
    apt-get update -qq
    apt-get install -y -qq curl gnupg >/dev/null 2>&1
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
    echo "Node.js $(node --version) installed."
else
    echo "Node.js already installed: $(node --version)"
fi

# Install app
mkdir -p /opt/pg-monitor
cp -r "${BASE_DIR}/web/"* /opt/pg-monitor/
# Only copy cluster.conf/auth.json if they don't already exist (preserve runtime credentials)
[ ! -f /opt/pg-monitor/cluster.conf ] && cp "${BASE_DIR}/cluster.conf" /opt/pg-monitor/ 2>/dev/null || true
[ ! -f /opt/pg-monitor/auth.json ] && cp "${BASE_DIR}/auth.json" /opt/pg-monitor/ 2>/dev/null || true

# Write version from git tag
cd "${BASE_DIR}"
if [ -f "${BASE_DIR}/VERSION" ]; then
    cp "${BASE_DIR}/VERSION" /opt/pg-monitor/VERSION
else
    git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' > /opt/pg-monitor/VERSION || echo "0.0.0" > /opt/pg-monitor/VERSION
fi

# Copy scripts so server.js can find them at ../scripts/
mkdir -p /opt/pg-monitor/scripts
cp "${BASE_DIR}/scripts/"*.sh /opt/pg-monitor/scripts/ 2>/dev/null || true

cd /opt/pg-monitor
npm install --silent 2>/dev/null
npm run build --silent 2>/dev/null

# Generate self-signed TLS cert for the dashboard if Patroni certs aren't available
SSL_DIR="/opt/pg-monitor/ssl"
if [ ! -f /etc/patroni/ssl/server.crt ] && [ ! -f "${SSL_DIR}/server.crt" ]; then
    echo "Generating self-signed TLS certificate for pg-monitor..."
    mkdir -p "${SSL_DIR}"
    openssl req -x509 -newkey rsa:2048 \
        -keyout "${SSL_DIR}/server.key" \
        -out "${SSL_DIR}/server.crt" \
        -days 3650 -nodes -subj "/CN=pg-monitor" 2>/dev/null
    chown -R postgres:postgres "${SSL_DIR}"
    chmod 600 "${SSL_DIR}/server.key"
    echo "TLS certificate generated at ${SSL_DIR}"
fi
fi # end SUDOERS_ONLY=false block

# Grant postgres user limited sudo for service management
# IMPORTANT: no broad wildcards — each command is explicitly enumerated
cat > /etc/sudoers.d/pg-monitor << 'SUDOEOF'
# Allow BORG_PASSPHRASE and PGPASSWORD to pass through sudo -E
Defaults:postgres env_keep += "BORG_PASSPHRASE PGPASSWORD"

# Service management — fully qualified, no wildcards
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart pg-monitor
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart cloudflared
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop cloudflared
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl start cloudflared
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-enabled patroni
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-enabled etcd
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-enabled vip-manager
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-enabled cloudflared

# Mount management
postgres ALL=(ALL) NOPASSWD: /usr/bin/mount /mnt/pg-backup
postgres ALL=(ALL) NOPASSWD: /usr/bin/mount -a
postgres ALL=(ALL) NOPASSWD: /usr/bin/mountpoint -q /mnt/pg-backup
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemd-detect-virt --container

# Backup — only the specific script and borg subcommands needed
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-backup/backup-run.sh
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-monitor/scripts/backup-setup.sh
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-monitor/scripts/cloudflare-tunnel.sh

# Borg — locked to the specific backup repo path; borg create is handled by backup-run.sh
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/borg list /mnt/pg-backup/borg-repo*
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/borg info /mnt/pg-backup/borg-repo*
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/borg delete /mnt/pg-backup/borg-repo*
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/borg check /mnt/pg-backup/borg-repo*
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/borg compact /mnt/pg-backup/borg-repo*

# PostgreSQL dump/restore — locked to explicit paths and options
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/pg_dumpall -U postgres -f /var/lib/postgresql/backup*.sql
postgres ALL=(ALL) SETENV: NOPASSWD: /usr/bin/psql -h 127.0.0.1 -p 5432 -U postgres -f -
SUDOEOF
chmod 440 /etc/sudoers.d/pg-monitor
echo "  sudoers updated."

[ "${SUDOERS_ONLY}" = true ] && exit 0

# Create log directory
mkdir -p /var/log/pg-monitor
chown postgres:postgres /var/log/pg-monitor

# Ensure postgres owns the app directory
chown -R postgres:postgres /opt/pg-monitor

# Create systemd service (skip if already exists to avoid clobbering live config)
if [ -f /etc/systemd/system/pg-monitor.service ]; then
    echo "  pg-monitor.service already exists — skipping service file creation."
else
cat > /etc/systemd/system/pg-monitor.service << EOF
[Unit]
Description=PostgreSQL Cluster Monitor
After=network.target patroni.service

[Service]
Type=simple
User=postgres
Group=postgres
WorkingDirectory=/opt/pg-monitor
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=MONITOR_PORT=${MONITOR_PORT}

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable pg-monitor
systemctl restart pg-monitor

echo "Monitoring dashboard running on port ${MONITOR_PORT}"
