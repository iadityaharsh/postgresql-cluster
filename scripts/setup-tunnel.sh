#!/bin/bash
# ================================================================
# Setup Cloudflare Tunnel connector using a pre-created tunnel token
# Installs cloudflared on this node and connects it as a connector
# Usage: ./setup-tunnel.sh <token>
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
load_config

TOKEN="${1:-${TUNNEL_TOKEN:-}}"

if [ -z "${TOKEN}" ]; then
    echo "ERROR: Tunnel token required."
    echo ""
    echo "  1. Go to Cloudflare Zero Trust dashboard"
    echo "  2. Networks > Tunnels > Create a tunnel"
    echo "  3. Choose 'Cloudflared' connector type"
    echo "  4. Copy the tunnel token"
    echo "  5. Paste it in the dashboard or run:"
    echo "     ./setup-tunnel.sh <token>"
    exit 1
fi

echo "--- Setting up Cloudflare Tunnel Connector ---"

# Step 1: Install cloudflared
if ! command -v cloudflared &>/dev/null; then
    echo "Installing cloudflared..."
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then
        ARCH="arm64"
    else
        ARCH="amd64"
    fi
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" -o /tmp/cloudflared.deb
    dpkg -i /tmp/cloudflared.deb
    rm -f /tmp/cloudflared.deb
    echo "cloudflared $(cloudflared --version 2>&1 | grep -oP 'version \K[\d.]+') installed."
else
    echo "cloudflared already installed: $(cloudflared --version 2>&1 | grep -oP 'version \K[\d.]+')"
fi

# Step 2: Stop any existing cloudflared service
systemctl stop cloudflared 2>/dev/null || true
systemctl disable cloudflared 2>/dev/null || true

# Step 3: Install as service with token — this is how Cloudflare recommends it
echo "Installing cloudflared service with tunnel token..."
cloudflared service install "${TOKEN}" 2>/dev/null || {
    # Fallback: write a systemd unit that reads the token from a
    # mode-600 EnvironmentFile instead of embedding it in ExecStart
    # (which would be world-readable via /etc/systemd/system).
    mkdir -p /etc/cloudflared
    printf 'TUNNEL_TOKEN=%s\n' "${TOKEN}" > /etc/cloudflared/tunnel-env
    chmod 600 /etc/cloudflared/tunnel-env

    cat > /etc/systemd/system/cloudflared.service << 'EOF'
[Unit]
Description=cloudflared tunnel connector
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
TimeoutStartSec=0
EnvironmentFile=/etc/cloudflared/tunnel-env
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TUNNEL_TOKEN}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
}

systemctl enable cloudflared
systemctl restart cloudflared

# Wait and check status
sleep 3
if systemctl is-active --quiet cloudflared; then
    echo "cloudflared service is running."
    echo "This node is now a tunnel connector."
else
    echo "WARNING: cloudflared service may not be running."
    echo "Check: systemctl status cloudflared"
    echo "Logs:  journalctl -u cloudflared --no-pager -n 20"
fi

echo ""
echo "--- Cloudflare Tunnel Connector Setup Complete ---"
echo ""
echo "  This node is connected as a tunnel replica."
echo "  Configure the tunnel's public hostname and service"
echo "  in the Cloudflare Zero Trust dashboard:"
echo "    Networks > Tunnels > your tunnel > Public Hostname"
echo ""
