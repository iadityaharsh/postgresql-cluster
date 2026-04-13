#!/bin/bash
# ================================================================
# Set up vip-manager on a database node (auto-detects which node)
# Run on each DB node: sudo ./scripts/05-setup-vip-manager.sh
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"
# shellcheck disable=SC1091
[ -f "${BASE_DIR}/versions.env" ] && source "${BASE_DIR}/versions.env"
load_config

if [[ "${ENABLE_VIP}" != "Y" && "${ENABLE_VIP}" != "y" ]]; then
    echo "VIP is not enabled in cluster.conf. Skipping."
    exit 0
fi

NODE_NUM=$(get_current_node)
NODE_NAME=$(get_node_name "$NODE_NUM")
NODE_IP=$(get_node_ip "$NODE_NUM")

echo "=== Setting up vip-manager on ${NODE_NAME} (${NODE_IP}) ==="
echo "    Virtual IP:   ${VIP_ADDRESS}"
echo "    Netmask:      ${VIP_NETMASK:-24}"
echo "    Interface:    ${VIP_INTERFACE}"

# Auto-detect interface if the configured one doesn't exist, then export
# VIP_INTERFACE so process_template picks it up.
IFACE="${VIP_INTERFACE}"
if ! ip link show "${IFACE}" &>/dev/null; then
    DETECTED=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo | head -1)
    echo "Interface '${IFACE}' not found. Using detected: ${DETECTED}"
    IFACE="${DETECTED}"
    export VIP_INTERFACE="${IFACE}"
fi

# Install vip-manager
VIP_VERSION="${VIP_MANAGER_VERSION:-2.6.0}"
apt-get update
apt-get install -y vip-manager2 || {
    echo "vip-manager2 not in apt repos, installing from GitHub release v${VIP_VERSION}..."
    wget -q "https://github.com/cybertec-postgresql/vip-manager/releases/download/v${VIP_VERSION}/vip-manager_${VIP_VERSION}_linux_amd64.deb" -O /tmp/vip-manager.deb
    dpkg -i /tmp/vip-manager.deb
    rm /tmp/vip-manager.deb
}

# Render config from the template
process_template "${TEMPLATES_DIR}/vip-manager.yml" "$NODE_NUM" > /etc/default/vip-manager.yml

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
