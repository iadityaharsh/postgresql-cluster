#!/bin/bash
# ================================================================
# Set up Patroni on a database node (auto-detects which node)
# Run on each DB node: sudo ./scripts/03-patroni.sh
#
# IMPORTANT: Run on the FIRST node first, wait for it to become
# Leader, then run on the remaining nodes.
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cluster-common.sh"
load_config

NODE_NUM=$(get_current_node)
NODE_NAME=$(get_node_name "$NODE_NUM")
NODE_IP=$(get_node_ip "$NODE_NUM")

echo "DEPRECATED: prefer running scripts/cluster-setup.sh which orchestrates all steps in order." >&2
echo "=== Setting up Patroni on ${NODE_NAME} (${NODE_IP}) ==="

# Stop default PostgreSQL — Patroni will manage it
systemctl stop postgresql 2>/dev/null || true
systemctl disable postgresql 2>/dev/null || true

# Handle data directory
if [[ "$NODE_NUM" == "1" ]]; then
    echo ""
    echo "WARNING: This is Node 1 — it will become the initial primary."
    echo "If you have existing data you want to keep, press Ctrl+C NOW."
    echo "Patroni will reinitialize the data directory."
    echo "Waiting 10 seconds..."
    sleep 10
else
    echo "This is a replica node."
fi

if [ -d "${PG_DATA_DIR}" ] && [ -n "$(ls -A "${PG_DATA_DIR}" 2>/dev/null)" ]; then
    if systemctl is-active patroni &>/dev/null; then
        echo "Patroni is currently running. Stop it first or use cluster-setup.sh which handles this safely."
        exit 1
    fi
    echo "WARNING: Data directory ${PG_DATA_DIR} is not empty."
    read -rp "Wipe and reinitialize? (y/N): " WIPE_PG
    if [[ "${WIPE_PG}" != "y" && "${WIPE_PG}" != "Y" ]]; then
        echo "Keeping existing data."
    else
        rm -rf "${PG_DATA_DIR:?}"/*
    fi
else
    rm -rf "${PG_DATA_DIR:?}"/* 2>/dev/null || true
fi

# Generate self-signed SSL certificate for PostgreSQL
SSL_DIR="/etc/patroni/ssl"
mkdir -p "$SSL_DIR"
if [ ! -f "$SSL_DIR/server.crt" ] || [ ! -f "$SSL_DIR/server.key" ]; then
    echo "Generating self-signed SSL certificate for PostgreSQL..."
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_DIR/server.crt" \
        -keyout "$SSL_DIR/server.key" \
        -subj "/CN=${NODE_NAME}/O=${CLUSTER_NAME}" \
        2>/dev/null
    chmod 600 "$SSL_DIR/server.key"
    chmod 644 "$SSL_DIR/server.crt"
    chown -R postgres:postgres "$SSL_DIR"
    echo "SSL certificate generated at $SSL_DIR/"
else
    echo "SSL certificate already exists at $SSL_DIR/"
fi

# Generate and install Patroni config from template
process_template "${TEMPLATES_DIR}/patroni.yml" "$NODE_NUM" > /etc/patroni/config.yml
chown postgres:postgres /etc/patroni/config.yml
chmod 600 /etc/patroni/config.yml

echo "Patroni config written to /etc/patroni/config.yml"

# Create systemd service
cat > /etc/systemd/system/patroni.service << 'EOF'
[Unit]
Description=Patroni - PostgreSQL High Availability
Documentation=https://patroni.readthedocs.io
After=syslog.target network.target etcd.service
Wants=etcd.service

[Service]
Type=simple
User=postgres
Group=postgres
ExecStart=/usr/local/bin/patroni /etc/patroni/config.yml
ExecReload=/bin/kill -s HUP $MAINPID
KillMode=process
TimeoutSec=30
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Ensure ownership
chown -R postgres:postgres "${PG_DATA_DIR}"

# Start Patroni
systemctl daemon-reload
systemctl enable patroni
systemctl start patroni

echo ""
echo "=== Patroni started on ${NODE_NAME} ==="
if [[ "$NODE_NUM" == "1" ]]; then
    echo ""
    echo "This is the primary node. Wait until it shows as Leader:"
    echo "  patronictl -c /etc/patroni/config.yml list"
    echo ""
    echo "Then run this script on the remaining nodes."
fi
echo ""
echo "Check status:"
echo "  systemctl status patroni"
echo "  journalctl -u patroni -f"
echo "  patronictl -c /etc/patroni/config.yml list"
