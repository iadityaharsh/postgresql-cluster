#!/bin/bash
# ================================================================
# PostgreSQL Borg Backup Script
# Runs pg_dumpall via VIP, stores in Borg repo on SMB share
# ================================================================

set -euo pipefail

LOCK_FILE="/var/run/pg-backup.lock"
exec 9>"${LOCK_FILE}"
flock -n 9 || { echo "$(date '+%Y-%m-%d %H:%M:%S') Another pg-backup instance is running. Exiting."; exit 1; }

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
# shellcheck source=/dev/null
source "${CONF_FILE}"
set +a

MOUNT_POINT="/mnt/pg-backup"
BORG_REPO="${MOUNT_POINT}/borg-repo"
LOCAL_RETENTION="${BACKUP_LOCAL_RETENTION:-7}"
LOG_FILE="/var/log/pg-backup.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "${LOG_FILE}"; }

# Find the leader node — query all nodes, use majority consensus
THIS_HOSTNAME=$(hostname)
declare -A LEADER_VOTES=()
declare -A LEADER_IPS=()
CURL_ARGS=(-s --max-time 5 --cacert "${PATRONI_TLS_CA:-/etc/patroni/certs/ca.crt}")
if [ -n "${PATRONI_API_USER:-}" ] && [ -n "${PATRONI_API_PASS:-}" ]; then
    CURL_ARGS+=(-u "${PATRONI_API_USER}:${PATRONI_API_PASS}")
fi
for i in $(seq 1 "${NODE_COUNT:-3}"); do
    NODE_IP_VAR="NODE_${i}_IP"
    NODE_IP="${!NODE_IP_VAR:-}"
    [ -z "${NODE_IP}" ] && continue
    CLUSTER_JSON=$(curl "${CURL_ARGS[@]}" "https://${NODE_IP}:8008/cluster" 2>/dev/null || true)
    [ -z "${CLUSTER_JSON}" ] && continue
    _LNAME=$(echo "${CLUSTER_JSON}" | python3 -c "import sys,json; m=json.load(sys.stdin).get('members',[]); print(next((x['name'] for x in m if x.get('role')=='leader'),''))" 2>/dev/null || true)
    _LIP=$(echo "${CLUSTER_JSON}" | python3 -c "import sys,json; m=json.load(sys.stdin).get('members',[]); l=[x for x in m if x.get('role')=='leader']; print(l[0]['host'] if l else '')" 2>/dev/null || true)
    [ -z "${_LNAME}" ] && continue
    LEADER_VOTES["${_LNAME}"]=$(( ${LEADER_VOTES["${_LNAME}"]:-0} + 1 ))
    LEADER_IPS["${_LNAME}"]="${_LIP}"
done
LEADER_NAME=""
LEADER_IP=""
_MAX=0
for _name in "${!LEADER_VOTES[@]}"; do
    if [ "${LEADER_VOTES[${_name}]}" -gt "${_MAX}" ]; then
        _MAX="${LEADER_VOTES[${_name}]}"
        LEADER_NAME="${_name}"
        LEADER_IP="${LEADER_IPS[${_name}]}"
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

export BORG_PASSPHRASE="${BORG_PASSPHRASE:-}"
if [ -z "${BORG_PASSPHRASE}" ]; then
    log "ERROR: BORG_PASSPHRASE is empty. Cannot access encrypted Borg repo."
    exit 1
fi
export BORG_REPO

# Initialize Borg repo if needed
if [ ! -d "${BORG_REPO}" ]; then
    log "Initializing Borg repository..."
    borg init --encryption=repokey-blake2 "${BORG_REPO}"
fi

ARCHIVE_NAME="${CLUSTER_NAME}-$(date '+%Y-%m-%d_%H%M%S')"

# Pre-check: is there enough /tmp space for the dump?
log "Checking available disk space..."
ESTIMATED_SIZE=$(PGPASSWORD="${PG_SUPERUSER_PASS}" PGSSLMODE=require psql -h "${BACKUP_HOST}" -p "${PG_PORT}" -U postgres -t -c \
    "SELECT sum(pg_database_size(datname)) FROM pg_database WHERE datname NOT IN ('template0','template1');" 2>/dev/null | tr -d ' ')
AVAILABLE_SPACE=$(df --output=avail /tmp 2>/dev/null | tail -1 | tr -d ' ')

if [ -n "${ESTIMATED_SIZE}" ] && [ -n "${AVAILABLE_SPACE}" ]; then
    AVAILABLE_BYTES=$((AVAILABLE_SPACE * 1024))
    if [ "${AVAILABLE_BYTES}" -lt "${ESTIMATED_SIZE}" ]; then
        log "ERROR: Insufficient /tmp space for dump. Need ~$(numfmt --to=iec "${ESTIMATED_SIZE}"), have $(numfmt --to=iec "${AVAILABLE_BYTES}")."
        log "Tip: Set TMPDIR to a directory with more space."
        exit 1
    fi
    log "Space OK: ~$(numfmt --to=iec "${ESTIMATED_SIZE}") needed, $(numfmt --to=iec "${AVAILABLE_BYTES}") available."
fi

# Run pg_dumpall first, then archive — so we catch connection failures before creating an archive
log "Running pg_dumpall on ${BACKUP_HOST}:${PG_PORT}..."
DUMP_FILE=$(mktemp /tmp/pg_dumpall.XXXXXX.sql)
trap 'rm -f "${DUMP_FILE}"' EXIT

PGPASSWORD="${PG_SUPERUSER_PASS}" PGSSLMODE=require pg_dumpall \
    -h "${BACKUP_HOST}" \
    -p "${PG_PORT}" \
    -U postgres \
    --clean > "${DUMP_FILE}" 2>&1

DUMP_SIZE=$(stat -c%s "${DUMP_FILE}" 2>/dev/null || echo 0)
if [ "${DUMP_SIZE}" -lt 100 ]; then
    log "ERROR: pg_dumpall produced no output (${DUMP_SIZE} bytes). Check PostgreSQL logs for details."
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

# Verify the archive we just created
log "Verifying archive integrity..."
if borg check --archives-only --last 1 "${BORG_REPO}" 2>&1 | tee -a "${LOG_FILE}"; then
    log "Archive integrity verified."
else
    log "WARNING: Archive verification failed. The backup may be corrupted."
fi

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
