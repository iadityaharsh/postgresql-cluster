#!/bin/bash
# ================================================================
# PostgreSQL HA Cluster — Interactive Configuration Wizard
# ================================================================
# Run this FIRST before any other script.
# Generates cluster.conf with all settings used by setup scripts.
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/cluster.conf"

echo "=============================================="
echo "  PostgreSQL HA Cluster Configuration Wizard"
echo "=============================================="
echo ""

# Load existing config if present
if [ -f "${CONF_FILE}" ]; then
    echo "Existing configuration found at ${CONF_FILE}"
    read -rp "Overwrite? (y/N): " OVERWRITE
    if [[ "${OVERWRITE}" != "y" && "${OVERWRITE}" != "Y" ]]; then
        echo "Keeping existing configuration."
        echo ""
        # Still offer to set/update dashboard login
        AUTH_FILE="${SCRIPT_DIR}/auth.json"
        if [ -f "${AUTH_FILE}" ]; then
            read -rp "Update dashboard login credentials? (y/N): " UPDATE_AUTH
        else
            echo "No dashboard login configured yet."
            read -rp "Set up dashboard login? (Y/n): " UPDATE_AUTH
            UPDATE_AUTH="${UPDATE_AUTH:-Y}"
        fi
        if [[ "${UPDATE_AUTH}" == "y" || "${UPDATE_AUTH}" == "Y" ]]; then
            echo ""
            echo "--- Dashboard Login ---"
            read -rp "Dashboard username [admin]: " DASH_USER
            DASH_USER="${DASH_USER:-admin}"
            read -rsp "Dashboard password: " DASH_PASS
            echo ""
            if [ -z "${DASH_PASS}" ]; then
                DASH_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)
                echo "  Auto-generated: ${DASH_PASS}"
            fi
            DASH_SALT=$(openssl rand -hex 16)
            DASH_HASH=$(python3 -c "
import hashlib, sys
dk = hashlib.scrypt(sys.argv[1].encode(), salt=bytes.fromhex(sys.argv[2]), n=16384, r=8, p=1, dklen=64)
print(dk.hex())
" "${DASH_PASS}" "${DASH_SALT}")
            cat > "${AUTH_FILE}" << AUTHEOF
{
  "username": "${DASH_USER}",
  "hash": "${DASH_HASH}",
  "salt": "${DASH_SALT}"
}
AUTHEOF
            chmod 600 "${AUTH_FILE}"
            echo "  Credentials saved to auth.json"
            echo ""
            echo "  Copy to each node and restart the dashboard:"
            echo "    scp auth.json root@<NODE_IP>:/opt/pg-monitor/"
            echo "    sudo systemctl restart pg-monitor"
        fi
        exit 0
    fi
    echo ""
fi

# ----- Mode selection -----
echo "--- Setup Mode ---"
echo "  1) Create new cluster"
echo "  2) Join existing cluster"
echo ""
read -rp "Select mode [1]: " SETUP_MODE
SETUP_MODE="${SETUP_MODE:-1}"

if [[ "${SETUP_MODE}" == "2" ]]; then
    echo ""
    echo "--- Join Existing Cluster ---"
    echo "You need the primary node's IP and the cluster's INTERNAL_SECRET."
    echo "(INTERNAL_SECRET is in cluster.conf on any existing node, or shown"
    echo " in the cluster dashboard under Settings → Cluster Expansion.)"
    echo ""
    read -rp "Primary node IP: " PRIMARY_IP
    if [[ -z "${PRIMARY_IP}" ]]; then
        echo "ERROR: Primary node IP is required." >&2
        exit 1
    fi
    read -rp "This node's IP: " THIS_IP
    if [[ -z "${THIS_IP}" ]]; then
        echo "ERROR: This node's IP is required." >&2
        exit 1
    fi
    read -rp "This node's name [node-04]: " THIS_NAME
    THIS_NAME="${THIS_NAME:-node-04}"
    read -rp "This node's number [4]: " THIS_NUM
    THIS_NUM="${THIS_NUM:-4}"
    if ! [[ "${THIS_NUM}" =~ ^[0-9]+$ ]]; then
        echo "ERROR: Node number must be a positive integer." >&2
        exit 1
    fi
    read -rsp "INTERNAL_SECRET from existing cluster.conf: " INTERNAL_SECRET_JOIN
    echo ""

    # Attempt to fetch cluster parameters from primary via API
    JOIN_JSON=$(curl -sf --max-time 10 \
        -H "X-Internal-Token: ${INTERNAL_SECRET_JOIN}" \
        "http://${PRIMARY_IP}:8080/api/config/join-config?node_ip=${THIS_IP}&node_name=${THIS_NAME}&node_number=${THIS_NUM}" 2>/dev/null || true)

    if [[ -n "${JOIN_JSON}" ]] && echo "${JOIN_JSON}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('mode')=='join'" 2>/dev/null; then
        echo "${JOIN_JSON}" > "${SCRIPT_DIR}/join-config.json"
        chmod 600 "${SCRIPT_DIR}/join-config.json"
        echo ""
        echo "  join-config.json created from primary node."
        echo ""
        echo "  Next steps:"
        echo "    1. Copy this directory to the new node:"
        echo "       scp -r $(pwd) root@${THIS_IP}:/opt/postgresql-cluster"
        echo "    2. Run setup on the new node:"
        echo "       sudo /opt/postgresql-cluster/scripts/cluster-setup.sh"
        exit 0
    else
        echo ""
        echo "  Could not reach primary API — entering manual mode."
        echo "  You will need to provide cluster values manually."
        echo ""
        # Fall through to manual join config creation
        read -rp "Cluster name: " CLUSTER_NAME_JOIN
        read -rp "Etcd peer IPs (comma-separated, e.g. 10.0.0.11,10.0.0.12,10.0.0.13): " ETCD_PEERS_RAW
        read -rsp "pg_repl_pass: " PG_REPL_PASS_JOIN; echo ""
        read -rsp "pg_superuser_pass: " PG_SUPERUSER_PASS_JOIN; echo ""
        read -rsp "patroni_api_pass: " PATRONI_API_PASS_JOIN; echo ""

        CLUSTER_NAME_JOIN="${CLUSTER_NAME_JOIN}" \
        THIS_NUM="${THIS_NUM}" \
        THIS_NAME="${THIS_NAME}" \
        THIS_IP="${THIS_IP}" \
        PG_REPL_PASS_JOIN="${PG_REPL_PASS_JOIN}" \
        PG_SUPERUSER_PASS_JOIN="${PG_SUPERUSER_PASS_JOIN}" \
        PATRONI_API_PASS_JOIN="${PATRONI_API_PASS_JOIN}" \
        INTERNAL_SECRET_JOIN="${INTERNAL_SECRET_JOIN}" \
        ETCD_PEERS_RAW="${ETCD_PEERS_RAW}" \
        python3 - > "${SCRIPT_DIR}/join-config.json" <<'PYEOF'
import json, os
peers = [p.strip() for p in os.environ['ETCD_PEERS_RAW'].split(',') if p.strip()]
config = {
    'mode': 'join',
    'cluster_name': os.environ['CLUSTER_NAME_JOIN'],
    'this_node': int(os.environ['THIS_NUM']),
    'this_node_name': os.environ['THIS_NAME'],
    'this_node_ip': os.environ['THIS_IP'],
    'etcd_peers': peers,
    'patroni_api_user': 'patroni',
    'patroni_api_pass': os.environ['PATRONI_API_PASS_JOIN'],
    'pg_repl_pass': os.environ['PG_REPL_PASS_JOIN'],
    'pg_superuser_pass': os.environ['PG_SUPERUSER_PASS_JOIN'],
    'internal_secret': os.environ['INTERNAL_SECRET_JOIN'],
}
print(json.dumps(config, indent=2))
PYEOF
        chmod 600 "${SCRIPT_DIR}/join-config.json"
        echo "  join-config.json created from manual input."
        echo ""
        echo "  Next steps:"
        echo "    1. Copy this directory to the new node:"
        echo "       scp -r $(pwd) root@${THIS_IP}:/opt/postgresql-cluster"
        echo "    2. Run setup on the new node:"
        echo "       sudo /opt/postgresql-cluster/scripts/cluster-setup.sh"
        exit 0
    fi
fi

# ----- Cluster basics -----
echo "--- Cluster Settings ---"
read -rp "Cluster name [pg-cluster]: " CLUSTER_NAME
CLUSTER_NAME="${CLUSTER_NAME:-pg-cluster}"

read -rp "Number of database nodes [3]: " NODE_COUNT
NODE_COUNT="${NODE_COUNT:-3}"

echo ""
echo "--- This Machine ---"
CURRENT_HOSTNAME=$(hostname 2>/dev/null || echo "")
CURRENT_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
echo "  Detected hostname: ${CURRENT_HOSTNAME}"
echo "  Detected IP:       ${CURRENT_IP}"
read -rp "Which node number is this machine? [1]: " THIS_NODE
THIS_NODE="${THIS_NODE:-1}"

echo ""
echo "--- Database Node Details ---"
echo "Enter details for each database node."
echo ""

declare -a NODE_IPS=()
declare -a NODE_NAMES=()

for i in $(seq 1 "${NODE_COUNT}"); do
    echo "  Node ${i}:"

    if [ "${i}" -eq "${THIS_NODE}" ]; then
        DEFAULT_NAME="${CURRENT_HOSTNAME}"
        DEFAULT_IP="${CURRENT_IP}"
    else
        DEFAULT_NAME="node-$(printf '%02d' "${i}")"
        DEFAULT_IP=""
    fi

    read -rp "    Hostname [${DEFAULT_NAME}]: " NAME
    NAME="${NAME:-${DEFAULT_NAME}}"

    if [ -n "${DEFAULT_IP}" ]; then
        read -rp "    IP address [${DEFAULT_IP}]: " IP
        IP="${IP:-${DEFAULT_IP}}"
    else
        read -rp "    IP address: " IP
        while [[ -z "${IP}" ]]; do
            read -rp "    IP address (required): " IP
        done
    fi

    NODE_NAMES+=("${NAME}")
    NODE_IPS+=("${IP}")
    echo ""
done

# ----- Virtual IP -----
echo "--- Virtual IP (VIP) ---"
read -rp "Enable floating VIP? (Y/n): " ENABLE_VIP
ENABLE_VIP="${ENABLE_VIP:-Y}"

VIP_ADDRESS=""
VIP_INTERFACE=""
if [[ "${ENABLE_VIP}" == "Y" || "${ENABLE_VIP}" == "y" ]]; then
    read -rp "Virtual IP address: " VIP_ADDRESS
    while [[ -z "${VIP_ADDRESS}" ]]; do
        read -rp "Virtual IP address (required): " VIP_ADDRESS
    done
    read -rp "Network interface [eth0]: " VIP_INTERFACE
    VIP_INTERFACE="${VIP_INTERFACE:-eth0}"
    read -rp "  VIP netmask (CIDR bits, default 24): " VIP_NETMASK
    VIP_NETMASK="${VIP_NETMASK:-24}"
fi

# ----- Network -----
echo ""
echo "--- Network ---"

# Derive subnet from first node IP
DEFAULT_SUBNET=$(echo "${NODE_IPS[0]}" | sed 's/\.[0-9]*$/.0\/24/')
read -rp "Allowed subnet for pg_hba [${DEFAULT_SUBNET}]: " PG_HBA_SUBNET
PG_HBA_SUBNET="${PG_HBA_SUBNET:-${DEFAULT_SUBNET}}"

# ----- PostgreSQL -----
echo ""
echo "--- PostgreSQL Settings ---"
echo "(If PostgreSQL is already installed on nodes, the install script will detect it)"
read -rp "Preferred PostgreSQL version [18]: " PG_VERSION
PG_VERSION="${PG_VERSION:-18}"

read -rp "PostgreSQL port [5432]: " PG_PORT
PG_PORT="${PG_PORT:-5432}"

read -rp "Data directory [/var/lib/postgresql/${PG_VERSION}/main]: " PG_DATA_DIR
PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/${PG_VERSION}/main}"

read -rp "Binary directory [/usr/lib/postgresql/${PG_VERSION}/bin]: " PG_BIN_DIR
PG_BIN_DIR="${PG_BIN_DIR:-/usr/lib/postgresql/${PG_VERSION}/bin}"

read -rp "Max connections [200]: " PG_MAX_CONN
PG_MAX_CONN="${PG_MAX_CONN:-200}"

# ----- Passwords -----
echo ""
echo "--- Passwords ---"
echo "(Leave blank to auto-generate secure passwords)"

read -rsp "PostgreSQL superuser (postgres) password: " PG_SUPERUSER_PASS
echo ""
if [ -z "${PG_SUPERUSER_PASS}" ]; then
    PG_SUPERUSER_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    echo "  Auto-generated: ${PG_SUPERUSER_PASS}"
fi

read -rsp "Replication user password: " PG_REPLICATOR_PASS
echo ""
if [ -z "${PG_REPLICATOR_PASS}" ]; then
    PG_REPLICATOR_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    echo "  Auto-generated: ${PG_REPLICATOR_PASS}"
fi

read -rsp "Admin user password: " PG_ADMIN_PASS
echo ""
if [ -z "${PG_ADMIN_PASS}" ]; then
    PG_ADMIN_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    echo "  Auto-generated: ${PG_ADMIN_PASS}"
fi

# ----- Monitoring port -----
echo ""
echo "--- Monitoring Dashboard ---"
read -rp "Monitoring web UI port [8080]: " MONITOR_PORT
MONITOR_PORT="${MONITOR_PORT:-8080}"

# ----- Dashboard login -----
echo ""
echo "--- Dashboard Login ---"
echo "Set a username and password to protect the web dashboard."
read -rp "Dashboard username [admin]: " DASH_USER
DASH_USER="${DASH_USER:-admin}"

read -rsp "Dashboard password: " DASH_PASS
echo ""
if [ -z "${DASH_PASS}" ]; then
    DASH_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)
    echo "  Auto-generated: ${DASH_PASS}"
fi

# Generate auth.json with scrypt hash
DASH_SALT=$(openssl rand -hex 16)
DASH_HASH=$(python3 -c "
import hashlib, sys
dk = hashlib.scrypt(sys.argv[1].encode(), salt=bytes.fromhex(sys.argv[2]), n=16384, r=8, p=1, dklen=64)
print(dk.hex())
" "${DASH_PASS}" "${DASH_SALT}")

AUTH_FILE="${SCRIPT_DIR}/auth.json"
cat > "${AUTH_FILE}" << AUTHEOF
{
  "username": "${DASH_USER}",
  "hash": "${DASH_HASH}",
  "salt": "${DASH_SALT}"
}
AUTHEOF
chmod 600 "${AUTH_FILE}"
echo "  Dashboard credentials saved to auth.json"

# ----- Patroni REST API credentials -----
PATRONI_API_USER="patroni"
PATRONI_API_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)

# ----- etcd token -----
ETCD_TOKEN=$(openssl rand -hex 8)

# ----- Internal node-to-node auth secret -----
INTERNAL_SECRET=$(openssl rand -hex 32)

# ================================================================
# Write cluster.conf
# ================================================================
cat > "${CONF_FILE}" << EOF
# ================================================================
# PostgreSQL HA Cluster Configuration
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
# ================================================================
# This file is sourced by all setup scripts.
# Re-run ./configure.sh to regenerate.
# ================================================================

# --- Cluster ---
CLUSTER_NAME="${CLUSTER_NAME}"
NODE_COUNT=${NODE_COUNT}
ETCD_TOKEN="${ETCD_TOKEN}"

# --- Node details ---
$(for i in $(seq 0 $((NODE_COUNT - 1))); do
    N=$((i + 1))
    echo "NODE_${N}_NAME=\"${NODE_NAMES[$i]}\""
    echo "NODE_${N}_IP=\"${NODE_IPS[$i]}\""
done)

# --- Virtual IP ---
ENABLE_VIP="${ENABLE_VIP}"
VIP_ADDRESS="${VIP_ADDRESS}"
VIP_NETMASK="${VIP_NETMASK:-24}"
VIP_INTERFACE="${VIP_INTERFACE}"

# --- Network ---
PG_HBA_SUBNET="${PG_HBA_SUBNET}"

# --- PostgreSQL ---
PG_VERSION="${PG_VERSION}"
PG_PORT="${PG_PORT}"
PG_DATA_DIR="${PG_DATA_DIR}"
PG_BIN_DIR="${PG_BIN_DIR}"
PG_MAX_CONN="${PG_MAX_CONN}"

# --- Passwords ---
PG_SUPERUSER_PASS="${PG_SUPERUSER_PASS}"
PG_REPLICATOR_PASS="${PG_REPLICATOR_PASS}"
PG_ADMIN_PASS="${PG_ADMIN_PASS}"

# --- Patroni REST API ---
PATRONI_API_USER="${PATRONI_API_USER}"
PATRONI_API_PASS="${PATRONI_API_PASS}"

# --- Internal node-to-node auth ---
INTERNAL_SECRET="${INTERNAL_SECRET}"

# --- Monitoring ---
MONITOR_PORT="${MONITOR_PORT}"

# --- Backup (configured via dashboard) ---
ENABLE_BACKUP="n"
BACKUP_SCHEDULE="0 2 * * *"
BACKUP_LOCAL_RETENTION="7"
BORG_PASSPHRASE="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
NFS_SERVER=""
NFS_PATH=""
EOF

chmod 600 "${CONF_FILE}"

echo ""
echo "=============================================="
echo "  Configuration saved to: ${CONF_FILE}"
echo "=============================================="
echo ""
echo "  Cluster:    ${CLUSTER_NAME} (${NODE_COUNT} nodes)"
for i in $(seq 0 $((NODE_COUNT - 1))); do
    N=$((i + 1))
    echo "  Node ${N}:     ${NODE_NAMES[$i]} — ${NODE_IPS[$i]}"
done
if [[ "${ENABLE_VIP}" == "Y" || "${ENABLE_VIP}" == "y" ]]; then
    echo "  VIP:        ${VIP_ADDRESS} (${VIP_INTERFACE})"
fi
if [[ "${ENABLE_VIP}" == "Y" || "${ENABLE_VIP}" == "y" ]]; then
    echo "  Dashboard:  http://${VIP_ADDRESS}:${MONITOR_PORT}"
else
    echo "  Dashboard:  http://<NODE_IP>:${MONITOR_PORT}"
fi
echo ""
echo "  Next steps:"
echo "    1. Copy this directory to each node:"
echo "       scp -r $(basename "${SCRIPT_DIR}") root@<NODE_IP>:/root/"
echo "    2. Run on each node: sudo ./postgresql-cluster/scripts/cluster-setup.sh"
echo "=============================================="
