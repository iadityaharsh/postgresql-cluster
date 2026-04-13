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

        # Validate the config matches the schema the scripts expect
        if ! bash -c 'source scripts/common.sh && load_config' &>/dev/null; then
            echo ""
            echo "WARNING: cluster.conf failed validation. Details:"
            bash -c 'source scripts/common.sh && load_config' || true
            echo ""
        fi

        # Add MONITOR_PORT if missing
        if ! grep -q '^MONITOR_PORT=' cluster.conf 2>/dev/null; then
            echo "" >> cluster.conf
            echo "# --- Monitoring ---" >> cluster.conf
            echo 'MONITOR_PORT="8080"' >> cluster.conf
            echo "Added MONITOR_PORT=8080 to cluster.conf"
        fi

        # Add PATRONI_API credentials if missing
        if ! grep -q '^PATRONI_API_USER=' cluster.conf 2>/dev/null; then
            PATRONI_API_PASS_GEN=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
            echo "" >> cluster.conf
            echo "# --- Patroni REST API ---" >> cluster.conf
            echo 'PATRONI_API_USER="patroni"' >> cluster.conf
            echo "PATRONI_API_PASS=\"${PATRONI_API_PASS_GEN}\"" >> cluster.conf
            echo "Added Patroni REST API credentials to cluster.conf"
        fi

        # Add INTERNAL_SECRET if missing
        if ! grep -q '^INTERNAL_SECRET=' cluster.conf 2>/dev/null; then
            INTERNAL_SECRET_GEN=$(openssl rand -hex 32)
            echo "" >> cluster.conf
            echo "# --- Internal node-to-node auth ---" >> cluster.conf
            echo "INTERNAL_SECRET=\"${INTERNAL_SECRET_GEN}\"" >> cluster.conf
            echo "Added INTERNAL_SECRET to cluster.conf"
        fi

        # Add BORG_PASSPHRASE if missing
        if ! grep -q '^BORG_PASSPHRASE=' cluster.conf 2>/dev/null; then
            BORG_PASS_GEN=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
            echo "BORG_PASSPHRASE=\"${BORG_PASS_GEN}\"" >> cluster.conf
            echo "Added BORG_PASSPHRASE to cluster.conf"
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
