#!/bin/bash
set -euo pipefail

REPO="https://github.com/iadityaharsh/postgresql-cluster.git"
DIR="postgresql-cluster"

echo "=== PostgreSQL HA Cluster Installer ==="
echo ""

# Check for git
if ! command -v git &>/dev/null; then
    echo "Installing git..."
    apt-get update -qq && apt-get install -y -qq git
fi

if [ -d "${DIR}" ]; then
    echo "Directory '${DIR}' already exists. Pulling latest..."
    git -C "${DIR}" pull
    cd "${DIR}"
    chmod +x configure.sh scripts/*.sh

    echo ""
    if [ -f "cluster.conf" ]; then
        echo "Existing cluster.conf found."

        # Add MONITOR_PORT if missing
        if ! grep -q '^MONITOR_PORT=' cluster.conf 2>/dev/null; then
            echo "" >> cluster.conf
            echo "# --- Monitoring ---" >> cluster.conf
            echo 'MONITOR_PORT="8080"' >> cluster.conf
            echo "Added MONITOR_PORT=8080 to cluster.conf"
        fi

        # Migrate SMB to NFS fields
        if grep -q 'SMB_SHARE\|SMB_USER\|SMB_PASS\|SMB_DOMAIN\|SMB_RETENTION' cluster.conf 2>/dev/null; then
            echo "Removing old SMB fields from cluster.conf..."
            sed -i '/^SMB_SHARE=/d;/^SMB_USER=/d;/^SMB_PASS=/d;/^SMB_DOMAIN=/d;/^SMB_RETENTION=/d' cluster.conf
        fi

        read -rp "Re-run configuration wizard? [y/N]: " reconfigure
        if [[ "${reconfigure,,}" == "y" ]]; then
            ./configure.sh
        else
            echo "Keeping existing configuration."
            echo ""
            echo "To apply updates on this node:"
            echo "  sudo ./scripts/setup.sh"
        fi
    else
        echo "Starting configuration wizard..."
        echo ""
        ./configure.sh
    fi
else
    git clone "${REPO}"
    cd "${DIR}"
    chmod +x configure.sh scripts/*.sh

    echo ""
    echo "Starting configuration wizard..."
    echo ""
    ./configure.sh
fi
