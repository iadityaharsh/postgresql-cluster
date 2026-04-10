#!/bin/bash
# ================================================================
# PostgreSQL Borg Backup Script
# Runs pg_dumpall via VIP, stores in Borg repo on SMB share
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load cluster.conf — check multiple locations
CONF_FILE=""
for candidate in "${SCRIPT_DIR}/cluster.conf" "${SCRIPT_DIR}/../cluster.conf" "/opt/pg-monitor/cluster.conf"; do
    if [ -f "${candidate}" ]; then
        CONF_FILE="${candidate}"
        break
    fi
done

if [ -z "${CONF_FILE}" ]; then
    echo "ERROR: cluster.conf not found"
    exit 1
fi

# Source config
set -a
source "${CONF_FILE}"
set +a

MOUNT_POINT="/mnt/pg-backup"
BORG_REPO="${MOUNT_POINT}/borg-repo"
LOCAL_RETENTION="${BACKUP_LOCAL_RETENTION:-7}"
LOG_FILE="/var/log/pg-backup.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "${LOG_FILE}"; }

# Find the leader node — try each node's Patroni API
LEADER_IP=""
LEADER_NAME=""
THIS_HOSTNAME=$(hostname)
for i in $(seq 1 "${NODE_COUNT:-3}"); do
    NODE_IP_VAR="NODE_${i}_IP"
    NODE_IP="${!NODE_IP_VAR:-}"
    [ -z "${NODE_IP}" ] && continue
    CURL_ARGS=(-sf)
    if [ -n "${PATRONI_API_USER:-}" ] && [ -n "${PATRONI_API_PASS:-}" ]; then
        CURL_ARGS+=(-u "${PATRONI_API_USER}:${PATRONI_API_PASS}")
    fi
    CLUSTER_JSON=$(curl "${CURL_ARGS[@]}" "http://${NODE_IP}:8008/cluster" 2>/dev/null || true)
    if [ -n "${CLUSTER_JSON}" ]; then
        LEADER_NAME=$(echo "${CLUSTER_JSON}" | python3 -c "import sys,json; members=json.load(sys.stdin).get('members',[]); print(next((m['name'] for m in members if m.get('role')=='leader'),''))" 2>/dev/null || true)
        LEADER_IP=$(echo "${CLUSTER_JSON}" | python3 -c "import sys,json; members=json.load(sys.stdin).get('members',[]); leader=[m for m in members if m.get('role')=='leader']; print(leader[0]['host'] if leader else '')" 2>/dev/null || true)
        break
    fi
done

if [ -n "${LEADER_NAME}" ] && [ "${LEADER_NAME}" != "${THIS_HOSTNAME}" ]; then
    log "This node (${THIS_HOSTNAME}) is not the leader (${LEADER_NAME}). Skipping backup."
    exit 0
fi

# Connect to leader IP directly, fall back to VIP
BACKUP_HOST="${LEADER_IP:-${VIP_ADDRESS:-${NODE_1_IP}}}"

log "=== Starting PostgreSQL Borg Backup ==="

# Ensure NFS share is mounted
if ! mountpoint -q "${MOUNT_POINT}"; then
    log "Mounting NFS share ${NFS_SERVER:-}:${NFS_PATH:-}..."
    mkdir -p "${MOUNT_POINT}"
    mount "${MOUNT_POINT}" || {
        log "ERROR: Failed to mount backup share"
        exit 1
    }
fi

# Initialize Borg repo if needed
if [ ! -d "${BORG_REPO}" ]; then
    log "Initializing Borg repository..."
    borg init --encryption=repokey-blake2 "${BORG_REPO}"
fi

export BORG_PASSPHRASE="${BORG_PASSPHRASE:-}"
export BORG_REPO

ARCHIVE_NAME="${CLUSTER_NAME}-$(date '+%Y-%m-%d_%H%M%S')"

# Run pg_dumpall first, then archive — so we catch connection failures before creating an archive
log "Running pg_dumpall on ${BACKUP_HOST}:${PG_PORT}..."
DUMP_FILE=$(mktemp /tmp/pg_dumpall.XXXXXX.sql)
trap 'rm -f "${DUMP_FILE}"' EXIT

PGPASSWORD="${PG_SUPERUSER_PASS}" pg_dumpall \
    -h "${BACKUP_HOST}" \
    -p "${PG_PORT}" \
    -U postgres \
    --clean > "${DUMP_FILE}" 2>&1

DUMP_SIZE=$(stat -c%s "${DUMP_FILE}" 2>/dev/null || echo 0)
if [ "${DUMP_SIZE}" -lt 100 ]; then
    log "ERROR: pg_dumpall produced no output (${DUMP_SIZE} bytes). Dump content:"
    cat "${DUMP_FILE}" | tee -a "${LOG_FILE}"
    exit 1
fi

log "Dump complete ($(numfmt --to=iec "${DUMP_SIZE}")). Archiving to Borg..."
borg create \
    --stdin-name "pg_dumpall.sql" \
    --compression zstd,6 \
    --stats \
    "${BORG_REPO}::${ARCHIVE_NAME}" \
    - < "${DUMP_FILE}" 2>&1 | tee -a "${LOG_FILE}"

log "Archive created: ${ARCHIVE_NAME}"

# Prune old backups
log "Pruning old archives (keeping ${LOCAL_RETENTION} daily, 4 weekly, 3 monthly)..."
borg prune \
    --keep-daily="${LOCAL_RETENTION}" \
    --keep-weekly=4 \
    --keep-monthly=3 \
    "${BORG_REPO}" 2>&1 | tee -a "${LOG_FILE}"

borg compact "${BORG_REPO}" 2>/dev/null || true

# Show repo stats
log "Repository info:"
borg info "${BORG_REPO}" 2>&1 | tee -a "${LOG_FILE}"

log "=== Backup complete ==="
