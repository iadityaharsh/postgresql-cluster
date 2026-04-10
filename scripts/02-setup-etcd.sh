#!/bin/bash
# ================================================================
# Set up etcd on a database node (auto-detects which node this is)
# Run on each DB node: sudo ./scripts/02-setup-etcd.sh
# Start all nodes within a few seconds of each other.
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
load_config

NODE_NUM=$(get_current_node)
NODE_NAME=$(get_node_name "$NODE_NUM")
NODE_IP=$(get_node_ip "$NODE_NUM")

echo "=== Setting up etcd on ${NODE_NAME} (${NODE_IP}) ==="

# Stop etcd if running
systemctl stop etcd 2>/dev/null || true

# Clear old etcd data for fresh cluster bootstrap
rm -rf /var/lib/etcd/default

# Generate and install etcd config from template
process_template "${TEMPLATES_DIR}/etcd.env" "$NODE_NUM" > /etc/default/etcd

echo "etcd config written to /etc/default/etcd"

# Enable and start etcd
systemctl enable etcd
systemctl start etcd

echo "=== etcd started on ${NODE_NAME} ==="
echo "Checking health..."
sleep 3
ETCD_CACERT="/etc/etcd/ssl/ca.crt"
ETCD_HEALTH_ARGS=(endpoint health --endpoints="https://127.0.0.1:2379")
if [ -f "${ETCD_CACERT}" ]; then
    ETCD_HEALTH_ARGS+=("--cacert=${ETCD_CACERT}")
fi
etcdctl "${ETCD_HEALTH_ARGS[@]}" \
    || echo "Note: etcd may take a moment to elect a leader when starting the cluster"
