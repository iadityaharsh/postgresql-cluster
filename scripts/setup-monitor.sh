#!/bin/bash
# ================================================================
# Install and configure the cluster monitoring web UI
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
load_config

BASE_DIR="$(dirname "$SCRIPT_DIR")"
MONITOR_PORT="${MONITOR_PORT:-8080}"

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
cp "${BASE_DIR}/cluster.conf" /opt/pg-monitor/ 2>/dev/null || true
cp "${BASE_DIR}/auth.json" /opt/pg-monitor/ 2>/dev/null || true

# Write version from git tag
cd "${BASE_DIR}"
git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' > /opt/pg-monitor/VERSION || echo "0.0.0" > /opt/pg-monitor/VERSION

# Copy scripts so server.js can find them at ../scripts/
mkdir -p /opt/pg-monitor/scripts
cp "${BASE_DIR}/scripts/"*.sh /opt/pg-monitor/scripts/ 2>/dev/null || true

cd /opt/pg-monitor
npm install --production --silent 2>/dev/null

# Grant postgres user limited sudo for service management
# IMPORTANT: no wildcards — each command is fully specified to prevent argv injection
cat > /etc/sudoers.d/pg-monitor << 'SUDOEOF'
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
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-enabled *
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-active *
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload
postgres ALL=(ALL) NOPASSWD: /usr/bin/mount /mnt/pg-backup
postgres ALL=(ALL) NOPASSWD: /usr/bin/mount -a
postgres ALL=(ALL) NOPASSWD: /usr/bin/mountpoint -q /mnt/pg-backup
postgres ALL=(ALL) NOPASSWD: /usr/bin/systemd-detect-virt --container
postgres ALL=(ALL) NOPASSWD: /usr/bin/apt-get update*
postgres ALL=(ALL) NOPASSWD: /usr/bin/apt-get install*
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-backup/pg-backup.sh
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-monitor/scripts/setup-tunnel.sh *
postgres ALL=(ALL) NOPASSWD: /bin/bash /opt/pg-monitor/scripts/setup-backup.sh
postgres ALL=(ALL) NOPASSWD: /usr/bin/borg *
postgres ALL=(ALL) NOPASSWD: /usr/bin/psql *
SUDOEOF
chmod 440 /etc/sudoers.d/pg-monitor

# Ensure postgres owns the app directory
chown -R postgres:postgres /opt/pg-monitor

# Create systemd service
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

systemctl daemon-reload
systemctl enable pg-monitor
systemctl restart pg-monitor

echo "Monitoring dashboard running on port ${MONITOR_PORT}"
