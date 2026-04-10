#!/bin/bash
# ================================================================
# Set up vip-manager on a database node (auto-detects which node)
# Run on each DB node: sudo ./scripts/05-setup-vip-manager.sh
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
load_config

if [[ "${ENABLE_VIP}" != "Y" && "${ENABLE_VIP}" != "y" ]]; then
    echo "VIP is not enabled in cluster.conf. Skipping."
    exit 0
fi

NODE_NUM=$(get_current_node)
NODE_NAME=$(get_node_name "$NODE_NUM")
NODE_IP=$(get_node_ip "$NODE_NUM")

echo "=== Setting up vip-manager on ${NODE_NAME} (${NODE_IP}) ==="
echo "    Virtual IP: ${VIP_ADDRESS}"
echo "    Interface:  ${VIP_INTERFACE}"

# Auto-detect interface if configured one doesn't exist
IFACE="${VIP_INTERFACE}"
if ! ip link show "${IFACE}" &>/dev/null; then
    DETECTED=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo | head -1)
    echo "Interface '${IFACE}' not found. Using detected: ${DETECTED}"
    IFACE="${DETECTED}"
fi

# Install vip-manager
apt-get update
apt-get install -y vip-manager2 || {
    echo "vip-manager2 not in apt repos, installing from GitHub release..."
    VIP_VERSION="2.6.0"
    wget -q "https://github.com/cybertec-postgresql/vip-manager/releases/download/v${VIP_VERSION}/vip-manager_${VIP_VERSION}_linux_amd64.deb" -O /tmp/vip-manager.deb
    dpkg -i /tmp/vip-manager.deb
    rm /tmp/vip-manager.deb
}

# Generate vip-manager config — need to fix the etcd endpoints format for YAML list
ETCD_YAML_LIST=""
for i in $(seq 1 "${NODE_COUNT}"); do
    ETCD_YAML_LIST="${ETCD_YAML_LIST}  - http://$(get_node_ip "$i"):2379\n"
done

cat > /etc/default/vip-manager.yml << EOF
ip: ${VIP_ADDRESS}
netmask: 24
interface: ${IFACE}

trigger-key: /service/${CLUSTER_NAME}/leader
trigger-value: "${NODE_NAME}"

dcs-type: etcd
dcs-endpoints:
$(for i in $(seq 1 "${NODE_COUNT}"); do echo "  - https://$(get_node_ip "$i"):2379"; done)

hosting-type: basic
retry-after: 2
retry-num: 3
EOF

echo "vip-manager config written to /etc/default/vip-manager.yml"

# Always override the systemd service to use our YAML config
mkdir -p /etc/systemd/system/vip-manager.service.d
cat > /etc/systemd/system/vip-manager.service.d/override.conf << 'SVCEOF'
[Service]
ExecStart=
ExecStart=/usr/bin/vip-manager --config /etc/default/vip-manager.yml
SVCEOF

systemctl daemon-reload
systemctl enable vip-manager
systemctl start vip-manager

echo ""
echo "=== vip-manager started on ${NODE_NAME} ==="
echo ""
echo "Check: systemctl status vip-manager"
echo "Check: ip addr show ${IFACE} | grep ${VIP_ADDRESS}"
echo "Test:  psql -h ${VIP_ADDRESS} -U postgres -c 'SELECT inet_server_addr();'"
