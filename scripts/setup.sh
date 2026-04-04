#!/bin/bash
# ================================================================
# Unified setup script — detects node role and runs full setup
# Run on each node: sudo ./scripts/setup.sh
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
load_config

# ---- Detect which node this is ----
NODE_NUM=$(get_current_node)
NODE_NAME=$(get_node_name "$NODE_NUM")
NODE_IP=$(get_node_ip "$NODE_NUM")

echo "=============================================="
echo "  Setting up: Node ${NODE_NUM} — ${NODE_NAME}"
echo "  IP: ${NODE_IP}"
if [ "$NODE_NUM" -eq 1 ]; then
    echo "  Role: PRIMARY (initial leader)"
else
    echo "  Role: REPLICA"
fi
echo "=============================================="
echo ""

# ================================================================
# Step 1: Install packages
# ================================================================
echo "=============================================="
echo "  [1/5] Installing packages"
echo "=============================================="
bash "${SCRIPT_DIR}/01-install-packages.sh"
echo ""

# ================================================================
# Step 2: Setup etcd
# ================================================================
echo "=============================================="
echo "  [2/5] Setting up etcd"
echo "=============================================="

# Stop etcd if running
systemctl stop etcd 2>/dev/null || true

# Clear old etcd data for fresh cluster bootstrap
rm -rf /var/lib/etcd/default

# Create etcd systemd service if not present (needed for GitHub release installs)
if [ ! -f /etc/systemd/system/etcd.service ] && [ ! -f /lib/systemd/system/etcd.service ]; then
    cat > /etc/systemd/system/etcd.service << 'EOF'
[Unit]
Description=etcd distributed key-value store
After=network.target

[Service]
Type=simple
User=etcd
EnvironmentFile=/etc/default/etcd
ExecStart=/usr/local/bin/etcd
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
fi

# Generate etcd config
process_template "${TEMPLATES_DIR}/etcd.env" "$NODE_NUM" > /etc/default/etcd
echo "etcd config written to /etc/default/etcd"

# Ensure data dir ownership
mkdir -p /var/lib/etcd
chown -R etcd:etcd /var/lib/etcd

# Override etcd service type to prevent timeout when waiting for peers
mkdir -p /etc/systemd/system/etcd.service.d
cat > /etc/systemd/system/etcd.service.d/override.conf << 'EOF'
[Service]
Type=simple
EOF

# Start etcd (may take time if peers aren't up yet — that's fine)
systemctl daemon-reload
systemctl enable etcd
systemctl start etcd || true

echo "Waiting for etcd cluster to become healthy..."
ETCD_READY=false
for attempt in $(seq 1 30); do
    if etcdctl endpoint health --endpoints="http://127.0.0.1:2379" &>/dev/null; then
        ETCD_READY=true
        break
    fi
    echo "  Attempt ${attempt}/30 — waiting for etcd peers... (make sure other nodes are running setup too)"
    sleep 5
done

if [ "$ETCD_READY" = true ]; then
    echo "etcd cluster is healthy."
else
    echo ""
    echo "WARNING: etcd is not yet healthy after 150 seconds."
    echo "This is normal if other nodes haven't started yet."
    echo "etcd will form the cluster once all nodes are running."
    echo "Continuing with setup..."
fi
echo ""

# ================================================================
# Step 3: Setup Patroni
# ================================================================
echo "=============================================="
echo "  [3/5] Setting up Patroni"
echo "=============================================="

# Stop default PostgreSQL — Patroni will manage it
systemctl stop postgresql 2>/dev/null || true
systemctl disable postgresql 2>/dev/null || true

# Handle data directory
if [ "$NODE_NUM" -eq 1 ]; then
    echo ""
    echo "This is Node 1 — it will become the initial primary."
    echo "If you have existing data, press Ctrl+C within 10 seconds."
    sleep 10
fi
rm -rf "${PG_DATA_DIR}"/*

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

# Generate Patroni config
process_template "${TEMPLATES_DIR}/patroni.yml" "$NODE_NUM" > /etc/patroni/config.yml
chown postgres:postgres /etc/patroni/config.yml
chmod 600 /etc/patroni/config.yml
echo "Patroni config written to /etc/patroni/config.yml"

# Ensure psycopg2 is available in the Patroni venv
/opt/patroni/bin/pip install -q psycopg2-binary 2>/dev/null || true

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

# Ensure data dir ownership
chown -R postgres:postgres "${PG_DATA_DIR}"

systemctl daemon-reload
systemctl enable patroni
systemctl start patroni

if [ "$NODE_NUM" -eq 1 ]; then
    echo "Waiting for this node to become Leader..."
    LEADER_READY=false
    for attempt in $(seq 1 30); do
        if patronictl -c /etc/patroni/config.yml list 2>/dev/null | grep -q "Leader"; then
            LEADER_READY=true
            break
        fi
        echo "  Attempt ${attempt}/30 — waiting for Patroni leader election..."
        sleep 5
    done
    if [ "$LEADER_READY" = true ]; then
        echo "This node is now the Leader."
        patronictl -c /etc/patroni/config.yml list
    else
        echo "WARNING: Leader not detected yet. Check: journalctl -u patroni -f"
    fi
else
    echo "Waiting for primary node to be available..."
    LEADER_FOUND=false
    for attempt in $(seq 1 60); do
        if patronictl -c /etc/patroni/config.yml list 2>/dev/null | grep -q "Leader"; then
            LEADER_FOUND=true
            break
        fi
        echo "  Attempt ${attempt}/60 — waiting for Leader... (make sure Node 1 setup is complete)"
        sleep 5
    done
    if [ "$LEADER_FOUND" = true ]; then
        echo "Leader found. This node is joining as replica."
        sleep 5
        patronictl -c /etc/patroni/config.yml list
    else
        echo "WARNING: No Leader found after 5 minutes. Check Node 1 status."
    fi
fi
echo ""

# ================================================================
# Step 4: Setup VIP manager
# ================================================================
if [[ "${ENABLE_VIP}" == "Y" || "${ENABLE_VIP}" == "y" ]]; then
    echo "=============================================="
    echo "  [4/5] Setting up VIP manager"
    echo "=============================================="
    bash "${SCRIPT_DIR}/05-setup-vip-manager.sh"
    echo ""
else
    echo "=============================================="
    echo "  [4/5] VIP not enabled — skipping"
    echo "=============================================="
    echo ""
fi

# ================================================================
# Step 5: Setup monitoring web UI
# ================================================================
echo "=============================================="
echo "  [5/5] Setting up monitoring dashboard"
echo "=============================================="
bash "${SCRIPT_DIR}/setup-monitor.sh"
echo ""

# ================================================================
# Done
# ================================================================
echo ""
echo "=============================================="
echo "  Setup complete: Node ${NODE_NUM} — ${NODE_NAME}"
echo "=============================================="
echo ""
echo "  PostgreSQL: ${PG_VERSION}"
echo "  Patroni:    systemctl status patroni"
echo "  etcd:       systemctl status etcd"
if [[ "${ENABLE_VIP}" == "Y" || "${ENABLE_VIP}" == "y" ]]; then
    echo "  VIP:        ${VIP_ADDRESS}:${PG_PORT}"
    echo "  Dashboard:  http://${VIP_ADDRESS}:${MONITOR_PORT}"
else
    echo "  Dashboard:  http://${NODE_IP}:${MONITOR_PORT}"
fi
echo ""
echo "  Cluster status:"
echo "    patronictl -c /etc/patroni/config.yml list"
echo ""
if [ "$NODE_NUM" -eq 1 ]; then
    echo "  Connect to database:"
    if [[ "${ENABLE_VIP}" == "Y" || "${ENABLE_VIP}" == "y" ]]; then
        echo "    psql -h ${VIP_ADDRESS} -U postgres"
    else
        echo "    psql -h ${NODE_IP} -U postgres"
    fi
fi
echo "=============================================="
