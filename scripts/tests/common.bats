#!/usr/bin/env bats

# Tests for scripts/cluster-common.sh functions

setup() {
    # Create a temp dir for test fixtures
    TEST_DIR="$(mktemp -d)"
    export TEST_DIR

    # Create a minimal cluster.conf
    cat > "$TEST_DIR/cluster.conf" << 'EOF'
CLUSTER_NAME="test-cluster"
NODE_COUNT=3
ETCD_TOKEN="abc123"
NODE_1_NAME="node-01"
NODE_1_IP="10.0.0.1"
NODE_2_NAME="node-02"
NODE_2_IP="10.0.0.2"
NODE_3_NAME="node-03"
NODE_3_IP="10.0.0.3"
ENABLE_VIP="Y"
VIP_ADDRESS="10.0.0.100"
VIP_INTERFACE="eth0"
PG_HBA_SUBNET="10.0.0.0/24"
PG_VERSION="16"
PG_PORT="5432"
PG_DATA_DIR="/var/lib/postgresql/16/main"
PG_BIN_DIR="/usr/lib/postgresql/16/bin"
PG_MAX_CONN="200"
PG_SUPERUSER_PASS="superpass"
PG_REPLICATOR_PASS="replpass"
PG_ADMIN_PASS="adminpass"
MONITOR_PORT="8080"
PATRONI_API_USER="patroni"
PATRONI_API_PASS="patronipass"
EOF

    # Create a minimal template
    cat > "$TEST_DIR/test.tmpl" << 'EOF'
cluster: {{CLUSTER_NAME}}
port: {{PG_PORT}}
ip: {{NODE_IP}}
name: {{NODE_NAME}}
etcd: {{ETCD_ENDPOINTS}}
version: {{PG_VERSION}}
EOF

    # Create the templates dir
    mkdir -p "$TEST_DIR/templates"
    cp "$TEST_DIR/test.tmpl" "$TEST_DIR/templates/test.tmpl"

    # Source cluster-common.sh with overrides
    export BASE_DIR="$TEST_DIR"
    export CONF_FILE="$TEST_DIR/cluster.conf"
    export TEMPLATES_DIR="$TEST_DIR/templates"

    # Source the config
    # shellcheck disable=SC1090
    source "$TEST_DIR/cluster.conf"
    # Source cluster-common.sh functions (override SCRIPT_DIR context)
    SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/cluster-common.sh"
}

teardown() {
    rm -rf "$TEST_DIR"
}

# ---- load_config ----

@test "load_config fails when cluster.conf is missing" {
    rm "$TEST_DIR/cluster.conf"
    CONF_FILE="$TEST_DIR/cluster.conf"
    run load_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"cluster.conf not found"* ]]
}

@test "load_config sources cluster.conf successfully" {
    CONF_FILE="$TEST_DIR/cluster.conf"
    load_config
    [ "$CLUSTER_NAME" = "test-cluster" ]
    [ "$NODE_COUNT" = "3" ]
}

# ---- get_node_ip / get_node_name ----

@test "get_node_ip returns correct IP for each node" {
    [ "$(get_node_ip 1)" = "10.0.0.1" ]
    [ "$(get_node_ip 2)" = "10.0.0.2" ]
    [ "$(get_node_ip 3)" = "10.0.0.3" ]
}

@test "get_node_name returns correct name for each node" {
    [ "$(get_node_name 1)" = "node-01" ]
    [ "$(get_node_name 2)" = "node-02" ]
    [ "$(get_node_name 3)" = "node-03" ]
}

# ---- get_etcd_endpoints ----

@test "get_etcd_endpoints returns comma-separated https URLs" {
    result=$(get_etcd_endpoints)
    [ "$result" = "https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379" ]
}

# ---- get_etcd_initial_cluster ----

@test "get_etcd_initial_cluster returns correct format" {
    result=$(get_etcd_initial_cluster)
    [ "$result" = "etcd1=https://10.0.0.1:2380,etcd2=https://10.0.0.2:2380,etcd3=https://10.0.0.3:2380" ]
}

# ---- get_etcd3_host_list ----

@test "get_etcd3_host_list returns YAML-formatted host list" {
    result=$(get_etcd3_host_list)
    [[ "$result" == *"https://10.0.0.1:2379"* ]]
    [[ "$result" == *"https://10.0.0.2:2379"* ]]
    [[ "$result" == *"https://10.0.0.3:2379"* ]]
}

# ---- detect_node_number ----

@test "detect_node_number returns failure when no IP matches" {
    run detect_node_number
    [ "$status" -ne 0 ]
}

# ---- process_template ----

@test "process_template replaces global variables" {
    result=$(process_template "$TEST_DIR/templates/test.tmpl")
    [[ "$result" == *"cluster: test-cluster"* ]]
    [[ "$result" == *"port: 5432"* ]]
    [[ "$result" == *"version: 16"* ]]
}

@test "process_template replaces node-specific variables" {
    result=$(process_template "$TEST_DIR/templates/test.tmpl" 2)
    [[ "$result" == *"ip: 10.0.0.2"* ]]
    [[ "$result" == *"name: node-02"* ]]
}

@test "process_template replaces etcd endpoints" {
    result=$(process_template "$TEST_DIR/templates/test.tmpl" 1)
    [[ "$result" == *"https://10.0.0.1:2379"* ]]
}

# ---- Edge cases ----

@test "single-node cluster works" {
    cat > "$TEST_DIR/cluster.conf" << 'SEOF'
CLUSTER_NAME="single"
NODE_COUNT=1
NODE_1_NAME="solo"
NODE_1_IP="192.168.1.1"
PG_VERSION="16"
PG_PORT="5432"
PG_DATA_DIR="/var/lib/postgresql/16/main"
PG_BIN_DIR="/usr/lib/postgresql/16/bin"
PG_MAX_CONN="100"
PG_SUPERUSER_PASS="pass"
PG_REPLICATOR_PASS="pass"
PG_ADMIN_PASS="pass"
PG_HBA_SUBNET="192.168.1.0/24"
VIP_ADDRESS=""
VIP_INTERFACE=""
ETCD_TOKEN="tok"
MONITOR_PORT="8080"
PATRONI_API_USER=""
PATRONI_API_PASS=""
SEOF
    # shellcheck disable=SC1090
    source "$TEST_DIR/cluster.conf"
    result=$(get_etcd_endpoints)
    [ "$result" = "https://192.168.1.1:2379" ]
    result=$(get_node_ip 1)
    [ "$result" = "192.168.1.1" ]
}

@test "process_template with empty node_num skips node-specific replacements" {
    result=$(process_template "$TEST_DIR/templates/test.tmpl" "")
    # NODE_IP should not be replaced (still has placeholder)
    [[ "$result" == *"cluster: test-cluster"* ]]
}

# ---- get_vip_etcd_endpoints ----

@test "get_vip_etcd_endpoints returns YAML list with 2-space indent" {
    result=$(get_vip_etcd_endpoints)
    [[ "$result" == *"  - https://10.0.0.1:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.2:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.3:2379"* ]]
    # must be 3 lines for a 3-node cluster
    [ "$(echo "$result" | wc -l)" -eq 3 ]
}

@test "get_vip_etcd_endpoints handles single-node cluster" {
    cat > "$TEST_DIR/cluster.conf" << 'SEOF'
NODE_COUNT=1
NODE_1_IP="192.168.1.1"
SEOF
    # shellcheck disable=SC1090
    source "$TEST_DIR/cluster.conf"
    result=$(get_vip_etcd_endpoints)
    [ "$result" = "  - https://192.168.1.1:2379" ]
}

# ---- process_template: VIP_ETCD_ENDPOINTS and VIP_NETMASK ----

@test "process_template substitutes VIP_ETCD_ENDPOINTS (multi-line)" {
    cat > "$TEST_DIR/templates/vip.tmpl" << 'TEOF'
dcs-endpoints:
{{VIP_ETCD_ENDPOINTS}}
TEOF
    result=$(process_template "$TEST_DIR/templates/vip.tmpl")
    [[ "$result" == *"  - https://10.0.0.1:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.2:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.3:2379"* ]]
    # placeholder must be fully replaced
    [[ "$result" != *"{{VIP_ETCD_ENDPOINTS}}"* ]]
}

@test "process_template substitutes VIP_NETMASK" {
    VIP_NETMASK="24"
    cat > "$TEST_DIR/templates/vip-mask.tmpl" << 'TEOF'
netmask: {{VIP_NETMASK}}
TEOF
    result=$(process_template "$TEST_DIR/templates/vip-mask.tmpl")
    [[ "$result" == *"netmask: 24"* ]]
    [[ "$result" != *"{{VIP_NETMASK}}"* ]]
}

# ---- templates/vip-manager.yml ----

@test "vip-manager.yml renders with per-line etcd endpoints and netmask" {
    VIP_NETMASK="24"
    VIP_ADDRESS="10.0.0.100"
    VIP_INTERFACE="eth0"
    result=$(process_template "$BATS_TEST_DIRNAME/../templates/vip-manager.yml" 1)
    # Each etcd endpoint must be on its own line with 2-space indent
    [[ "$result" == *"  - https://10.0.0.1:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.2:2379"* ]]
    [[ "$result" == *"  - https://10.0.0.3:2379"* ]]
    # Netmask must be substituted
    [[ "$result" == *"netmask: 24"* ]]
    # VIP address must be substituted
    [[ "$result" == *"ip: 10.0.0.100"* ]]
    # trigger-value must be the node name
    [[ "$result" == *"trigger-value: \"node-01\""* ]]
    # No placeholders remain
    [[ "$result" != *"{{"* ]]
}

# ---- templates/etcd.env: client cert auth ----

@test "etcd.env template enables client cert auth" {
    grep -q '^ETCD_CLIENT_CERT_AUTH="true"' "$BATS_TEST_DIRNAME/../templates/etcd.env"
}

# ---- templates/patroni.yml: etcd3 TLS client certs ----

@test "patroni.yml template has etcd3 TLS client cert paths" {
    local t="$BATS_TEST_DIRNAME/../templates/patroni.yml"
    grep -q '  cacert: /etc/etcd/ssl/ca.crt' "$t"
    grep -q '  cert: /etc/etcd/ssl/server.crt' "$t"
    grep -q '  key: /etc/etcd/ssl/server.key' "$t"
}

# ---- templates/patroni.yml: restapi TLS ----

@test "patroni.yml template has restapi TLS cert paths" {
    local t="$BATS_TEST_DIRNAME/../templates/patroni.yml"
    grep -q '  certfile: /etc/patroni/ssl/server.crt' "$t"
    grep -q '  keyfile: /etc/patroni/ssl/server.key' "$t"
}

# ---- validate_config edge cases ----

@test "validate_config rejects non-numeric NODE_COUNT" {
    NODE_COUNT="abc"
    run validate_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"NODE_COUNT must be a number"* ]]
}

@test "validate_config rejects invalid IP address" {
    NODE_1_IP="not-an-ip"
    run validate_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"is not a valid IPv4 address"* ]]
}

@test "validate_config rejects missing VIP fields" {
    ENABLE_VIP="Y"
    VIP_ADDRESS=""
    VIP_INTERFACE=""
    run validate_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"required when ENABLE_VIP=Y"* ]]
}

@test "validate_config accepts ENABLE_VIP=N" {
    ENABLE_VIP="N"
    VIP_ADDRESS=""
    VIP_INTERFACE=""
    run validate_config
    [ "$status" -eq 0 ]
}
