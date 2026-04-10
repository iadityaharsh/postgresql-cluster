#!/bin/bash
# ================================================================
# Verify the PostgreSQL cluster health
# Run on any DB node: sudo ./scripts/04-verify-cluster.sh
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
load_config

echo "=========================================="
echo "  PostgreSQL Patroni Cluster Health Check"
echo "  Cluster: ${CLUSTER_NAME}"
echo "=========================================="

ETCD_CACERT="/etc/etcd/ssl/ca.crt"
ETCD_TLS_ARGS=()
if [ -f "${ETCD_CACERT}" ]; then
    ETCD_TLS_ARGS+=("--cacert=${ETCD_CACERT}")
fi

echo ""
echo "--- etcd cluster health ---"
etcdctl endpoint health --endpoints="$(get_etcd_endpoints)" "${ETCD_TLS_ARGS[@]}"

echo ""
echo "--- etcd member list ---"
etcdctl member list --endpoints="https://$(get_node_ip 1):2379" "${ETCD_TLS_ARGS[@]}"

echo ""
echo "--- Patroni cluster status ---"
patronictl -c /etc/patroni/config.yml list

echo ""
echo "--- Replication status (run on primary) ---"
su - postgres -c "psql -c 'SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn FROM pg_stat_replication;'" 2>/dev/null || echo "(Skip — this node is not the primary)"

echo ""
echo "=========================================="
