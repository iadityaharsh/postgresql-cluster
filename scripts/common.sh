#!/bin/bash
# ================================================================
# Common functions and config loader for all setup scripts
# ================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
CONF_FILE="${BASE_DIR}/cluster.conf"
# shellcheck disable=SC2034
TEMPLATES_DIR="${BASE_DIR}/templates"

# Validate that required fields exist in cluster.conf
# Fails fast with a clear error if anything is missing or malformed.
validate_config() {
    local errors=0
    local required=(
        CLUSTER_NAME NODE_COUNT
        PG_VERSION PG_PORT PG_DATA_DIR PG_BIN_DIR PG_MAX_CONN PG_HBA_SUBNET
        PG_SUPERUSER_PASS PG_REPLICATOR_PASS PG_ADMIN_PASS
        ETCD_TOKEN ENABLE_VIP
    )

    for var in "${required[@]}"; do
        if [ -z "${!var:-}" ]; then
            echo "ERROR: ${var} is not set in cluster.conf" >&2
            errors=$((errors + 1))
        fi
    done

    # NODE_COUNT must be numeric and >= 1
    if [ -n "${NODE_COUNT:-}" ] && ! [[ "${NODE_COUNT}" =~ ^[0-9]+$ ]]; then
        echo "ERROR: NODE_COUNT must be a number, got '${NODE_COUNT}'" >&2
        errors=$((errors + 1))
    elif [ -n "${NODE_COUNT:-}" ] && [ "${NODE_COUNT}" -lt 1 ]; then
        echo "ERROR: NODE_COUNT must be at least 1, got '${NODE_COUNT}'" >&2
        errors=$((errors + 1))
    fi

    # Per-node IP/name fields must exist
    if [ -n "${NODE_COUNT:-}" ] && [[ "${NODE_COUNT}" =~ ^[0-9]+$ ]]; then
        for i in $(seq 1 "${NODE_COUNT}"); do
            local ip_var="NODE_${i}_IP"
            local name_var="NODE_${i}_NAME"
            if [ -z "${!ip_var:-}" ]; then
                echo "ERROR: ${ip_var} is not set in cluster.conf" >&2
                errors=$((errors + 1))
            elif ! [[ "${!ip_var}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                echo "ERROR: ${ip_var}='${!ip_var}' is not a valid IPv4 address" >&2
                errors=$((errors + 1))
            fi
            if [ -z "${!name_var:-}" ]; then
                echo "ERROR: ${name_var} is not set in cluster.conf" >&2
                errors=$((errors + 1))
            fi
        done
    fi

    # If VIP enabled, VIP fields must be set
    if [[ "${ENABLE_VIP:-}" == "Y" || "${ENABLE_VIP:-}" == "y" ]]; then
        for var in VIP_ADDRESS VIP_INTERFACE; do
            if [ -z "${!var:-}" ]; then
                echo "ERROR: ${var} is required when ENABLE_VIP=Y" >&2
                errors=$((errors + 1))
            fi
        done
    fi

    # VIP_NETMASK is optional (defaults to 24) but if set must be numeric 1-32
    if [ -n "${VIP_NETMASK:-}" ] && ! [[ "${VIP_NETMASK}" =~ ^[0-9]+$ && "${VIP_NETMASK}" -ge 1 && "${VIP_NETMASK}" -le 32 ]]; then
        echo "ERROR: VIP_NETMASK must be an integer 1-32, got '${VIP_NETMASK}'" >&2
        errors=$((errors + 1))
    fi

    if [ "${errors}" -gt 0 ]; then
        echo "" >&2
        echo "cluster.conf failed validation with ${errors} error(s)." >&2
        echo "Re-run ./configure.sh to regenerate the file." >&2
        exit 1
    fi
}

# Load cluster config
load_config() {
    if [ ! -f "${CONF_FILE}" ]; then
        echo "ERROR: cluster.conf not found!"
        echo "Run ./configure.sh first to generate the configuration."
        exit 1
    fi
    # shellcheck disable=SC1090
    source "${CONF_FILE}"
    validate_config
}

# Get node variable by index (1-based)
get_node_ip() { eval echo "\${NODE_${1}_IP}"; }
get_node_name() { eval echo "\${NODE_${1}_NAME}"; }

# Build comma-separated etcd endpoints
get_etcd_endpoints() {
    local endpoints=""
    for i in $(seq 1 "${NODE_COUNT}"); do
        [ -n "${endpoints}" ] && endpoints="${endpoints},"
        endpoints="${endpoints}https://$(get_node_ip "$i"):2379"
    done
    echo "${endpoints}"
}

# Build YAML list of etcd hosts for Patroni etcd3 config (host:port format)
get_etcd3_host_list() {
    for i in $(seq 1 "${NODE_COUNT}"); do
        echo "    - https://$(get_node_ip "$i"):2379"
    done
}

# Build YAML list of etcd endpoints for vip-manager (2-space indent, not 4)
get_vip_etcd_endpoints() {
    for i in $(seq 1 "${NODE_COUNT}"); do
        echo "  - https://$(get_node_ip "$i"):2379"
    done
}

# Build etcd initial cluster string
get_etcd_initial_cluster() {
    local cluster=""
    for i in $(seq 1 "${NODE_COUNT}"); do
        [ -n "${cluster}" ] && cluster="${cluster},"
        cluster="${cluster}etcd${i}=https://$(get_node_ip "$i"):2380"
    done
    echo "${cluster}"
}

# Detect which node this machine is (by matching IP)
detect_node_number() {
    local my_ips
    my_ips=$(hostname -I 2>/dev/null || ip -4 addr show | grep -oP '(?<=inet\s)\d+\.\d+\.\d+\.\d+' | grep -v 127.0.0.1)

    for i in $(seq 1 "${NODE_COUNT}"); do
        local node_ip
        node_ip=$(get_node_ip "$i")
        if echo "${my_ips}" | grep -qw "${node_ip}"; then
            echo "$i"
            return 0
        fi
    done

    return 1
}

# Prompt user to select which node this is (fallback when auto-detect fails)
prompt_node_number() {
    echo ""
    echo "Could not auto-detect which node this is."
    echo "Available nodes:"
    for i in $(seq 1 "${NODE_COUNT}"); do
        echo "  ${i}) $(get_node_name "$i") — $(get_node_ip "$i")"
    done
    echo ""
    read -rp "Which node is this? [1-${NODE_COUNT}]: " NODE_NUM
    if [[ "$NODE_NUM" -ge 1 && "$NODE_NUM" -le "$NODE_COUNT" ]]; then
        echo "$NODE_NUM"
    else
        echo "Invalid selection."
        exit 1
    fi
}

# Get current node number (auto-detect or prompt)
get_current_node() {
    local node_num
    if node_num=$(detect_node_number); then
        if [ "$node_num" = "dashboard" ]; then
            echo "dashboard"
        else
            echo "Detected: Node ${node_num} — $(get_node_name "$node_num") ($(get_node_ip "$node_num"))"  >&2
            echo "$node_num"
        fi
    else
        prompt_node_number
    fi
}

# Process a template file — replaces {{VARIABLE}} with values from cluster.conf
process_template() {
    local template_file="$1"
    local node_num="${2:-}"
    local content
    content=$(cat "$template_file")

    # Multi-line replacements (must be done before sed)
    local etcd3_hosts vip_etcd_endpoints
    etcd3_hosts=$(get_etcd3_host_list)
    content="${content//\{\{ETCD3_HOST_LIST\}\}/$etcd3_hosts}"
    vip_etcd_endpoints=$(get_vip_etcd_endpoints)
    content="${content//\{\{VIP_ETCD_ENDPOINTS\}\}/$vip_etcd_endpoints}"

    # Global replacements
    content=$(echo "$content" | sed \
        -e "s|{{CLUSTER_NAME}}|${CLUSTER_NAME}|g" \
        -e "s|{{PG_VERSION}}|${PG_VERSION}|g" \
        -e "s|{{PG_PORT}}|${PG_PORT}|g" \
        -e "s|{{PG_DATA_DIR}}|${PG_DATA_DIR}|g" \
        -e "s|{{PG_BIN_DIR}}|${PG_BIN_DIR}|g" \
        -e "s|{{PG_MAX_CONN}}|${PG_MAX_CONN}|g" \
        -e "s|{{PG_SUPERUSER_PASS}}|${PG_SUPERUSER_PASS}|g" \
        -e "s|{{PG_REPLICATOR_PASS}}|${PG_REPLICATOR_PASS}|g" \
        -e "s|{{PG_ADMIN_PASS}}|${PG_ADMIN_PASS}|g" \
        -e "s|{{PG_HBA_SUBNET}}|${PG_HBA_SUBNET}|g" \
        -e "s|{{VIP_ADDRESS}}|${VIP_ADDRESS}|g" \
        -e "s|{{VIP_NETMASK}}|${VIP_NETMASK:-24}|g" \
        -e "s|{{VIP_INTERFACE}}|${VIP_INTERFACE}|g" \
        -e "s|{{ETCD_TOKEN}}|${ETCD_TOKEN}|g" \
        -e "s|{{ETCD_ENDPOINTS}}|$(get_etcd_endpoints)|g" \
        -e "s|{{ETCD_INITIAL_CLUSTER}}|$(get_etcd_initial_cluster)|g" \
        -e "s|{{DASHBOARD_IP}}|${DASHBOARD_IP:-}|g" \
        -e "s|{{PATRONI_API_USER}}|${PATRONI_API_USER:-patroni}|g" \
        -e "s|{{PATRONI_API_PASS}}|${PATRONI_API_PASS:-}|g" \
    )

    # Node-specific replacements
    if [ -n "$node_num" ]; then
        local node_ip node_name failover_priority
        node_ip=$(get_node_ip "$node_num")
        node_name=$(get_node_name "$node_num")
        # Node 1 = highest priority (100), then decreasing
        if [ "$node_num" -eq 1 ]; then
            failover_priority=100
        else
            failover_priority=$(( 100 - (node_num - 1) * 25 ))
            [ "$failover_priority" -lt 1 ] && failover_priority=1
        fi
        content=$(echo "$content" | sed \
            -e "s|{{NODE_IP}}|${node_ip}|g" \
            -e "s|{{NODE_NAME}}|${node_name}|g" \
            -e "s|{{NODE_NUM}}|${node_num}|g" \
            -e "s|{{FAILOVER_PRIORITY}}|${failover_priority}|g" \
        )
    fi

    # Replace all node IPs ({{NODE_1_IP}}, {{NODE_2_IP}}, etc.)
    for i in $(seq 1 "${NODE_COUNT}"); do
        local ip name
        ip=$(get_node_ip "$i")
        name=$(get_node_name "$i")
        content=$(echo "$content" | sed \
            -e "s|{{NODE_${i}_IP}}|${ip}|g" \
            -e "s|{{NODE_${i}_NAME}}|${name}|g" \
        )
    done

    echo "$content"
}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
