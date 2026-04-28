#!/bin/bash
# ================================================================
# Verify the PostgreSQL cluster health
# Run on any DB node: sudo ./scripts/04-verify.sh
# Exits non-zero if the cluster is unhealthy.
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cluster-common.sh"
load_config

FAIL=0
EXPECTED_REPLICAS=$(( NODE_COUNT - 1 ))

echo "=========================================="
echo "  PostgreSQL Patroni Cluster Health Check"
echo "  Cluster: ${CLUSTER_NAME}"
echo "=========================================="

ETCD_CACERT="/etc/etcd/ssl/ca.crt"
ETCD_CERT="/etc/etcd/ssl/server.crt"
ETCD_KEY="/etc/etcd/ssl/server.key"
ETCD_TLS_ARGS=()
if [ -f "${ETCD_CACERT}" ]; then
    ETCD_TLS_ARGS+=("--cacert=${ETCD_CACERT}")
fi
if [ -f "${ETCD_CERT}" ] && [ -f "${ETCD_KEY}" ]; then
    ETCD_TLS_ARGS+=("--cert=${ETCD_CERT}" "--key=${ETCD_KEY}")
fi

# ---- 1. etcd health ----
echo ""
echo "--- etcd cluster health ---"
if ! etcdctl endpoint health --endpoints="$(get_etcd_endpoints)" "${ETCD_TLS_ARGS[@]}"; then
    echo "ERROR: etcd health check failed" >&2
    FAIL=1
fi

echo ""
echo "--- etcd member list ---"
if ! etcdctl member list --endpoints="$(get_etcd_endpoints)" "${ETCD_TLS_ARGS[@]}"; then
    echo "ERROR: Could not list etcd members" >&2
    FAIL=1
fi

# ---- 2. Patroni cluster state ----
echo ""
echo "--- Patroni cluster status ---"
PATRONI_OUT=$(patronictl -c /etc/patroni/config.yml list 2>&1) || {
    echo "ERROR: patronictl list failed" >&2
    echo "${PATRONI_OUT}" >&2
    FAIL=1
}
echo "${PATRONI_OUT}"

# Check for exactly one Leader
LEADER_COUNT=$(echo "${PATRONI_OUT}" | grep -c "Leader" || true)
if [ "${LEADER_COUNT}" -eq 0 ]; then
    echo "ERROR: No Leader found in patronictl output" >&2
    FAIL=1
elif [ "${LEADER_COUNT}" -gt 1 ]; then
    echo "ERROR: More than one Leader found — split-brain suspected" >&2
    FAIL=1
else
    echo "OK: Leader found."
fi

# Check replicas are streaming
if [ "${EXPECTED_REPLICAS}" -gt 0 ]; then
    STREAMING_COUNT=$(echo "${PATRONI_OUT}" | grep -c "streaming" || true)
    if [ "${STREAMING_COUNT}" -lt "${EXPECTED_REPLICAS}" ]; then
        echo "ERROR: Expected ${EXPECTED_REPLICAS} streaming replica(s), patronictl shows ${STREAMING_COUNT}" >&2
        FAIL=1
    else
        echo "OK: ${STREAMING_COUNT} replica(s) streaming."
    fi
fi

# ---- 3. pg_stat_replication (only if this node is the primary) ----
echo ""
echo "--- Replication status (pg_stat_replication) ---"
IS_LEADER=$(echo "${PATRONI_OUT}" | grep "$(hostname)" | grep -c "Leader" || true)
if [ "${IS_LEADER}" -gt 0 ] && [ "${EXPECTED_REPLICAS}" -gt 0 ]; then
    REPL_ROWS=$(su - postgres -c "psql -qAt -c \"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';\"" 2>/dev/null) || {
        echo "ERROR: Could not query pg_stat_replication" >&2
        FAIL=1
        REPL_ROWS=0
    }
    echo "pg_stat_replication: ${REPL_ROWS} streaming replica(s)"
    if [ "${REPL_ROWS}" -lt "${EXPECTED_REPLICAS}" ]; then
        echo "ERROR: Expected ${EXPECTED_REPLICAS} streaming replica(s) in pg_stat_replication, found ${REPL_ROWS}" >&2
        FAIL=1
    else
        echo "OK: Replication lag check passed."
    fi
else
    echo "(Not primary — skipping pg_stat_replication check)"
fi

# ---- Result ----
echo ""
echo "=========================================="
if [ "${FAIL}" -eq 0 ]; then
    echo "  RESULT: HEALTHY"
else
    echo "  RESULT: UNHEALTHY — see errors above" >&2
fi
echo "=========================================="

exit "${FAIL}"
