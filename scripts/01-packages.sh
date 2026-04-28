#!/bin/bash
# ================================================================
# Install PostgreSQL, etcd, and Patroni on a database node
# Run on each DB node: sudo ./scripts/01-packages.sh
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cluster-common.sh"
load_config

# shellcheck disable=SC1091
source "$(dirname "$SCRIPT_DIR")/docs/versions.env"

echo "=== Installing packages for PostgreSQL HA cluster ==="

# ----- PostgreSQL detection / installation -----
echo ""
echo "--- Checking PostgreSQL ---"

PG_INSTALLED=""
PG_INSTALLED_VERSION=""

# Check if any PostgreSQL is installed
if command -v psql &>/dev/null; then
    PG_INSTALLED_VERSION=$(psql --version | awk '{print $3}' | cut -d. -f1)
    PG_INSTALLED="yes"
fi

if [ -n "${PG_INSTALLED}" ]; then
    echo "PostgreSQL is already installed: version ${PG_INSTALLED_VERSION}"

    if [ -n "${PG_VERSION}" ] && [ "${PG_INSTALLED_VERSION}" != "${PG_VERSION}" ]; then
        echo ""
        echo "WARNING: cluster.conf specifies PostgreSQL ${PG_VERSION}, but version ${PG_INSTALLED_VERSION} is installed."
        read -rp "Continue with installed version ${PG_INSTALLED_VERSION}? (Y/n): " USE_INSTALLED
        USE_INSTALLED="${USE_INSTALLED:-Y}"
        if [[ "${USE_INSTALLED}" != "Y" && "${USE_INSTALLED}" != "y" ]]; then
            echo "Aborting. Please install PostgreSQL ${PG_VERSION} manually or update cluster.conf."
            exit 1
        fi
        # Update PG_VERSION for the rest of this script
        PG_VERSION="${PG_INSTALLED_VERSION}"
    fi
else
    echo "PostgreSQL is not installed."
    echo ""

    # Fetch available versions from the PostgreSQL apt repo
    LATEST_PG_VERSION=""
    if command -v wget &>/dev/null || command -v curl &>/dev/null; then
        # Add PostgreSQL repo first so we can query available versions
        apt-get update -qq
        apt-get install -y -qq wget gnupg2 lsb-release >/dev/null 2>&1

        DISTRO_CODENAME=$(lsb_release -cs 2>/dev/null || echo "bookworm")
        if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
            wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg 2>/dev/null || true
            echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt ${DISTRO_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
            apt-get update -qq
        fi

        # Find the latest available major version
        LATEST_PG_VERSION=$(apt-cache showpkg postgresql-[0-9]* 2>/dev/null \
            | grep -oP '^postgresql-\K[0-9]+' \
            | sort -rn | head -1)
    fi

    LATEST_PG_VERSION="${LATEST_PG_VERSION:-18}"

    if [ -n "${PG_VERSION}" ]; then
        echo "cluster.conf specifies PostgreSQL ${PG_VERSION}."
        read -rp "Install PostgreSQL ${PG_VERSION}? (Y/n): " CONFIRM_VER
        CONFIRM_VER="${CONFIRM_VER:-Y}"
        if [[ "${CONFIRM_VER}" != "Y" && "${CONFIRM_VER}" != "y" ]]; then
            PG_VERSION=""
        fi
    fi

    if [ -z "${PG_VERSION}" ]; then
        echo ""
        echo "Which PostgreSQL version would you like to install?"
        echo "  Latest available: ${LATEST_PG_VERSION} (recommended)"
        read -rp "PostgreSQL version [${LATEST_PG_VERSION}]: " PG_VERSION
        PG_VERSION="${PG_VERSION:-${LATEST_PG_VERSION}}"
    fi

    echo ""
    echo "Installing PostgreSQL ${PG_VERSION}..."

    # Ensure PGDG repository is set up
    apt-get install -y -qq wget gnupg2 lsb-release >/dev/null 2>&1
    DISTRO_CODENAME=$(lsb_release -cs 2>/dev/null || echo "bookworm")
    mkdir -p /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/postgresql.gpg ]; then
        wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
    fi
    if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
        echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt ${DISTRO_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    fi
    apt-get update -qq

    apt-get install -y "postgresql-${PG_VERSION}"

    echo "PostgreSQL ${PG_VERSION} installed successfully."

    # Stop PostgreSQL — Patroni will manage it
    systemctl stop postgresql 2>/dev/null || true
    systemctl disable postgresql 2>/dev/null || true
    echo "Disabled default PostgreSQL service (Patroni will manage it)."
fi

echo ""
echo "Using PostgreSQL ${PG_VERSION}"

# Update PG_DATA_DIR and PG_BIN_DIR based on actual version
PG_DATA_DIR="/var/lib/postgresql/${PG_VERSION}/main"
PG_BIN_DIR="/usr/lib/postgresql/${PG_VERSION}/bin"
# Write detected values back to cluster.conf so the parent cluster-setup.sh shell picks up
# the correct paths — without this, the parent shell retains stale values and can
# rm -rf the wrong directory or write Patroni config pointing at a non-existent path.
sed -i "s|^PG_VERSION=.*|PG_VERSION=\"${PG_VERSION}\"|" "${CONF_FILE}"
sed -i "s|^PG_DATA_DIR=.*|PG_DATA_DIR=\"${PG_DATA_DIR}\"|" "${CONF_FILE}"
sed -i "s|^PG_BIN_DIR=.*|PG_BIN_DIR=\"${PG_BIN_DIR}\"|" "${CONF_FILE}"

# ----- etcd -----
echo ""
echo "--- Installing etcd ---"
if command -v etcd &>/dev/null; then
    echo "etcd is already installed: $(etcd --version 2>/dev/null | head -1)"
else
    # Try apt first, fall back to GitHub release
    apt-get update -qq
    if apt-get install -y etcd 2>/dev/null; then
        echo "etcd installed from apt."
    else
        echo "etcd not available in apt repos, installing from GitHub release..."
        cd /tmp
        wget -q "https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-amd64.tar.gz" -O etcd.tar.gz
        tar xzf etcd.tar.gz
        cp "etcd-v${ETCD_VERSION}-linux-amd64/etcd" /usr/local/bin/
        cp "etcd-v${ETCD_VERSION}-linux-amd64/etcdctl" /usr/local/bin/
        cp "etcd-v${ETCD_VERSION}-linux-amd64/etcdutl" /usr/local/bin/
        rm -rf etcd*
        echo "etcd ${ETCD_VERSION} installed from GitHub release."
    fi

    useradd --no-create-home --shell /bin/false etcd 2>/dev/null || true
    mkdir -p /var/lib/etcd
    chown etcd:etcd /var/lib/etcd
fi

# ----- Patroni -----
echo ""
echo "--- Installing Patroni ---"
apt-get install -y python3-pip python3-psycopg2 python3-venv

python3 -m venv /opt/patroni
# Install pinned versions from requirements.txt for reproducibility.
BASE_DIR="$(dirname "$SCRIPT_DIR")"
/opt/patroni/bin/pip install -r "${BASE_DIR}/docs/requirements.txt"

# Create symlinks
ln -sf /opt/patroni/bin/patroni /usr/local/bin/patroni
ln -sf /opt/patroni/bin/patronictl /usr/local/bin/patronictl

# Create Patroni config directory
mkdir -p /etc/patroni

echo ""
echo "=== Package installation complete ==="
echo "  PostgreSQL: ${PG_VERSION} (${PG_BIN_DIR})"
echo "  Data dir:   ${PG_DATA_DIR}"
echo "  etcd:       $(etcd --version 2>/dev/null | head -1 || echo 'installed')"
echo "  Patroni:    $(/opt/patroni/bin/patroni --version 2>/dev/null || echo 'installed')"
