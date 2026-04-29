#!/bin/bash
# ================================================================
# PostgreSQL HA Cluster - TUI Configuration Wizard
# ================================================================
# Generates cluster.conf and auth.json.
# Navigate with Enter (next) and Back button or Escape.
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/cluster.conf"
AUTH_FILE="${SCRIPT_DIR}/auth.json"
LOG_FILE="${SCRIPT_DIR}/configure.log"

_log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG_FILE"; }
_log "=== configure.sh started (pid=$$) ==="

T="PostgreSQL HA Cluster Setup"  # window title
W=76   # width
H=22   # height

# ── Ensure dialog is available ───────────────────────────────────────────────
# Force a safe, explicit color scheme so characters never render as black
# squares regardless of terminal type (Proxmox, SSH, physical console, etc.)
_setup_dialogrc() {
    local rc
    rc=$(mktemp)
    cat > "$rc" << 'DIALOGRC'
use_shadow      = OFF
use_colors      = ON
screen_color        = (WHITE,BLUE,ON)
shadow_color        = (BLACK,BLACK,ON)
dialog_color        = (BLACK,WHITE,OFF)
title_color         = (BLUE,WHITE,ON)
border_color        = (WHITE,WHITE,ON)
border2_color       = (WHITE,WHITE,ON)
button_active_color     = (WHITE,BLUE,ON)
button_inactive_color   = (BLACK,WHITE,OFF)
button_key_active_color = (WHITE,BLUE,ON)
button_key_inactive_color = (RED,WHITE,OFF)
button_label_active_color   = (YELLOW,BLUE,ON)
button_label_inactive_color = (BLACK,WHITE,ON)
inputbox_color      = (BLACK,WHITE,OFF)
inputbox_border_color   = (WHITE,WHITE,ON)
inputbox_border2_color  = (WHITE,WHITE,ON)
searchbox_color     = (BLACK,WHITE,OFF)
searchbox_title_color   = (BLUE,WHITE,ON)
searchbox_border_color  = (WHITE,WHITE,ON)
position_indicator_color = (BLUE,WHITE,ON)
menubox_color       = (BLACK,WHITE,OFF)
menubox_border_color    = (WHITE,WHITE,ON)
menubox_border2_color   = (WHITE,WHITE,ON)
item_color          = (BLACK,WHITE,OFF)
item_selected_color = (WHITE,BLUE,ON)
tag_color           = (BLUE,WHITE,ON)
tag_selected_color  = (YELLOW,BLUE,ON)
tag_key_color       = (BLUE,WHITE,ON)
tag_key_selected_color  = (YELLOW,BLUE,ON)
check_color         = (BLACK,WHITE,OFF)
check_selected_color    = (WHITE,BLUE,ON)
uarrow_color        = (GREEN,WHITE,ON)
darrow_color        = (GREEN,WHITE,ON)
itemhelp_color      = (WHITE,BLACK,OFF)
form_active_text_color  = (WHITE,BLUE,ON)
form_text_color     = (BLACK,WHITE,OFF)
form_item_readonly_color = (CYAN,WHITE,ON)
gauge_color         = (BLUE,WHITE,ON)
DIALOGRC
    export DIALOGRC="$rc"
}
_setup_dialogrc
if ! command -v dialog &>/dev/null; then
    echo "Installing dialog..."
    apt-get install -y dialog &>/dev/null || {
        echo "ERROR: dialog not found - install with: apt-get install dialog" >&2
        exit 1
    }
fi

# ── Dialog helpers ────────────────────────────────────────────────────────────
# Each returns 0 (OK/Next) or 1 (Back/Cancel)
# dialog writes selected value to stderr; we capture it via a temp file.

_wt_tmp=""
_wt_init_tmp() { _wt_tmp=$(mktemp); }
_wt_read_tmp() { cat "$_wt_tmp"; rm -f "$_wt_tmp"; }
_wt_drop_tmp() { rm -f "$_wt_tmp"; }

wt_input() {
    local -n _r=$1
    local prompt=$2 default=${3:-}
    _wt_init_tmp
    local _drc=0
    dialog --title "$T" --cancel-label "Back" \
        --inputbox "$prompt" $H $W "$default" 2>"$_wt_tmp" || _drc=$?
    _log "  wt_input var=$1 dialog_rc=$_drc"
    if [[ $_drc -eq 0 ]]; then
        _r=$(_wt_read_tmp)
    else
        _wt_drop_tmp; return 1
    fi
}

wt_pass() {
    local -n _r=$1
    local prompt=$2
    _wt_init_tmp
    local _drc=0
    dialog --title "$T" --cancel-label "Back" \
        --passwordbox "$prompt" 12 $W "" 2>"$_wt_tmp" || _drc=$?
    _log "  wt_pass var=$1 dialog_rc=$_drc"
    if [[ $_drc -eq 0 ]]; then
        _r=$(_wt_read_tmp)
    else
        _wt_drop_tmp; return 1
    fi
}

wt_menu() {
    local -n _r=$1
    local prompt=$2
    shift 2
    _wt_init_tmp
    local _drc=0
    dialog --title "$T" --cancel-label "Back" \
        --menu "$prompt" $H $W 8 "$@" 2>"$_wt_tmp" || _drc=$?
    _log "  wt_menu var=$1 dialog_rc=$_drc"
    if [[ $_drc -eq 0 ]]; then
        _r=$(_wt_read_tmp)
    else
        _wt_drop_tmp; return 1
    fi
}

wt_yesno() {
    # returns 0=yes 1=no/back
    local prompt=$1 yeslabel=${2:-Yes} nolabel=${3:-No}
    dialog --title "$T" \
        --yes-label "$yeslabel" --no-label "$nolabel" \
        --yesno "$prompt" $H $W
}

wt_msg() {
    dialog --title "$T" --ok-label "OK" \
        --msgbox "$1" $H $W || true
}

wt_confirm() {
    local prompt=$1 yeslabel=${2:-"Write Config"} nolabel=${3:-"Back"}
    dialog --title "$T" \
        --yes-label "$yeslabel" --no-label "$nolabel" \
        --yesno "$prompt" 24 $W
}

# ── Auto-generate password helper ────────────────────────────────────────────
gen_pass() { openssl rand -base64 24 | tr -d '/+=' | head -c 24; }

# ── Password entry with confirmation ─────────────────────────────────────────
# Sets global VAR; returns 1 if user pressed Back on first prompt
enter_password() {
    local -n _out=$1
    local label=$2
    while true; do
        local p1 p2
        wt_pass p1 "${label}:\n(leave empty to auto-generate a secure password)" || return 1
        if [[ -z "$p1" ]]; then
            _out=$(gen_pass)
            wt_msg "Auto-generated password saved.\n\nIt will be written to cluster.conf - keep that file secure."
            return 0
        fi
        wt_pass p2 "Confirm ${label}:" || {
            # Back on confirm -> loop to re-enter
            continue
        }
        if [[ "$p1" == "$p2" ]]; then
            _out="$p1"
            return 0
        fi
        wt_msg "Passwords do not match - please try again."
    done
}

# ── State ─────────────────────────────────────────────────────────────────────
SETUP_MODE="new"
CLUSTER_NAME="pg-cluster"
NODE_COUNT=3
THIS_NODE=1
declare -a NODE_NAMES=()
declare -a NODE_IPS=()
ENABLE_VIP="Y"
VIP_ADDRESS=""
VIP_INTERFACE="eth0"
VIP_NETMASK="24"
PG_HBA_SUBNET=""
PG_VERSION="18"
PG_PORT="5432"
PG_DATA_DIR=""
PG_BIN_DIR=""
PG_MAX_CONN="200"
PG_SUPERUSER_PASS=""
PG_REPLICATOR_PASS=""
PG_ADMIN_PASS=""
MONITOR_PORT="8080"
DASH_USER="admin"
DASH_PASS=""

CURRENT_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
CURRENT_HOSTNAME=$(hostname 2>/dev/null || echo "")

# ── Step functions ────────────────────────────────────────────────────────────

step_welcome() {
    wt_yesno \
"Welcome to the PostgreSQL HA Cluster configuration wizard.

This wizard will generate:
  * cluster.conf  - all cluster settings
  * auth.json     - dashboard login credentials

Use Enter / OK to advance and Back to return
to the previous question at any time.

Press Start to begin." \
        "Start" "Exit" || return 1
}


_step_update_creds() {
    wt_input DASH_USER "Dashboard username:" "${DASH_USER:-admin}" || return
    enter_password DASH_PASS "Dashboard password" || return
    _write_auth
    wt_msg "Done! Dashboard credentials updated.

Copy to each node and restart the dashboard:
  scp auth.json root@<NODE_IP>:/opt/pg-monitor/
  sudo systemctl restart pg-monitor"
}

step_mode() {
    wt_menu SETUP_MODE "What would you like to do?" \
        "new"  "Create a new cluster on this machine" \
        "join" "Add this node to an existing running cluster" || return 1
}

# Routes to join wizard or cluster-name depending on SETUP_MODE.
# Pressing Back on either returns to mode selection.
step_new_or_join() {
    if [[ "$SETUP_MODE" == "join" ]]; then
        step_join || return 1
    else
        step_cluster_name || return 1
    fi
}

# Handles all node detail prompts with internal back/forward navigation.
step_all_nodes() {
    local n=1
    while true; do
        if step_node_detail "$n"; then
            n=$((n + 1))
            [[ $n -gt $NODE_COUNT ]] && return 0
        else
            n=$((n - 1))
            [[ $n -lt 1 ]] && return 1
        fi
    done
}

# ── Join mode (single compound step - exits on success) ──────────────────────
step_join() {
    local PRIMARY_IP="" THIS_IP="$CURRENT_IP" THIS_NAME="$CURRENT_HOSTNAME"
    local THIS_NUM="4" SECRET=""

    wt_input PRIMARY_IP "Primary node IP address:" "" || return 1
    if [[ -z "$PRIMARY_IP" ]]; then wt_msg "Primary node IP is required."; return 1; fi

    wt_input THIS_IP "This node's IP address:" "$CURRENT_IP" || return 1
    wt_input THIS_NAME "This node's hostname:" "$CURRENT_HOSTNAME" || return 1
    wt_input THIS_NUM  "This node's number (e.g. 4 for the 4th node):" "4" || return 1
    wt_pass  SECRET \
"INTERNAL_SECRET from the existing cluster:

Find it in:  cluster.conf  ->  INTERNAL_SECRET
Or via:      Dashboard -> Settings -> Cluster Expansion" || return 1

    wt_msg "Contacting ${PRIMARY_IP}...\nThis may take a few seconds."

    local JOIN_JSON
    JOIN_JSON=$(curl -sf --max-time 10 \
        -H "X-Internal-Token: ${SECRET}" \
        "http://${PRIMARY_IP}:8080/api/config/join-config?node_ip=${THIS_IP}&node_name=${THIS_NAME}&node_number=${THIS_NUM}" \
        2>/dev/null || true)

    if [[ -n "$JOIN_JSON" ]] && \
       echo "$JOIN_JSON" | python3 -c \
           "import sys,json; d=json.load(sys.stdin); assert d.get('mode')=='join'" 2>/dev/null; then
        echo "$JOIN_JSON" > "${SCRIPT_DIR}/join-config.json"
        chmod 600 "${SCRIPT_DIR}/join-config.json"
        wt_msg "Done! Join configuration saved to join-config.json.

Next steps:
1. Copy this directory to the new node:
   scp -r $(basename "$SCRIPT_DIR") root@${THIS_IP}:/root/

2. Run setup on the new node:
   sudo bash scripts/cluster-setup.sh"
        exit 0
    fi

    # Manual fallback
    wt_msg "Could not reach the primary API.
Switching to manual mode - you will need to enter
cluster values from the existing cluster.conf."

    local CNAME="" PEERS="" REPL_PASS="" SUPER_PASS="" PAPI_PASS=""
    wt_input CNAME     "Cluster name (from cluster.conf):" "" || return 1
    wt_input PEERS     "etcd peer IPs, comma-separated:" "" || return 1
    wt_pass  REPL_PASS "PG_REPLICATOR_PASS:" || return 1
    wt_pass  SUPER_PASS "PG_SUPERUSER_PASS:" || return 1
    wt_pass  PAPI_PASS "PATRONI_API_PASS:" || return 1

    python3 - > "${SCRIPT_DIR}/join-config.json" <<PYEOF
import json
peers = [p.strip() for p in "${PEERS}".split(',') if p.strip()]
print(json.dumps({
    'mode': 'join',
    'cluster_name': "${CNAME}",
    'this_node': int("${THIS_NUM}"),
    'this_node_name': "${THIS_NAME}",
    'this_node_ip': "${THIS_IP}",
    'etcd_peers': peers,
    'patroni_api_user': 'patroni',
    'patroni_api_pass': "${PAPI_PASS}",
    'pg_repl_pass': "${REPL_PASS}",
    'pg_superuser_pass': "${SUPER_PASS}",
    'internal_secret': "${SECRET}",
}, indent=2))
PYEOF
    chmod 600 "${SCRIPT_DIR}/join-config.json"
    wt_msg "Done! Join configuration saved.

Next steps:
1. Copy this directory to the new node:
   scp -r $(basename "$SCRIPT_DIR") root@${THIS_IP}:/root/

2. Run setup on the new node:
   sudo bash scripts/cluster-setup.sh"
    exit 0
}

# ── New cluster steps ─────────────────────────────────────────────────────────

step_cluster_name() {
    wt_input CLUSTER_NAME \
"Cluster name:
(used in etcd, Patroni scope, and backup archive names)" \
        "${CLUSTER_NAME:-pg-cluster}" || return 1
    CLUSTER_NAME="${CLUSTER_NAME:-pg-cluster}"
}

step_node_count() {
    local val
    while true; do
        wt_input val \
"Number of database nodes:
(minimum 3 recommended for HA; use odd numbers)" \
            "$NODE_COUNT" || return 1
        if [[ "$val" =~ ^[1-9][0-9]*$ ]]; then
            NODE_COUNT="$val"
            # Resize arrays, preserving existing values
            local old=${#NODE_NAMES[@]}
            for i in $(seq "$((old+1))" "$NODE_COUNT"); do
                NODE_NAMES+=("")
                NODE_IPS+=("")
            done
            return 0
        fi
        wt_msg "Please enter a number (1 or more)."
    done
}

step_this_node() {
    local val
    while true; do
        wt_input val \
"Which node number is this machine?

  Detected IP:       ${CURRENT_IP}
  Detected hostname: ${CURRENT_HOSTNAME}

Enter the node number (1–${NODE_COUNT}):" \
            "$THIS_NODE" || return 1
        if [[ "$val" =~ ^[0-9]+$ ]] && \
           [[ "$val" -ge 1 ]] && [[ "$val" -le "$NODE_COUNT" ]]; then
            THIS_NODE="$val"
            return 0
        fi
        wt_msg "Please enter a number between 1 and ${NODE_COUNT}."
    done
}

step_node_detail() {
    local n=$1
    local idx=$((n - 1))
    local dname="${NODE_NAMES[$idx]:-}"
    local dip="${NODE_IPS[$idx]:-}"

    # Pre-fill detected values for this machine
    if [[ "$n" -eq "$THIS_NODE" ]]; then
        dname="${dname:-$CURRENT_HOSTNAME}"
        dip="${dip:-$CURRENT_IP}"
    else
        dname="${dname:-node-$(printf '%02d' "$n")}"
    fi

    local name ip
    # Hostname sub-prompt
    wt_input name "Node ${n} of ${NODE_COUNT} - Hostname:" "$dname" || return 1
    name="${name:-$dname}"

    # IP sub-prompt - Back returns to hostname, not previous major step
    while true; do
        if ! wt_input ip "Node ${n} of ${NODE_COUNT} - IP address:" "$dip"; then
            # User pressed Back on IP -> re-ask hostname
            wt_input name "Node ${n} of ${NODE_COUNT} - Hostname:" "$name" || return 1
            name="${name:-$dname}"
            continue
        fi
        if [[ -n "$ip" ]]; then break; fi
        wt_msg "IP address is required."
    done

    NODE_NAMES[$idx]="$name"
    NODE_IPS[$idx]="$ip"
}

step_vip() {
    local rc
    wt_yesno \
"Enable floating Virtual IP (VIP)?

A VIP moves automatically to whichever node is the
primary, so applications always connect to the same
address regardless of which node is active.

Requires: NET_ADMIN and NET_RAW capabilities
(standard on bare metal and most VMs; needs
 enabling on LXC containers - see the docs)." \
        "Enable VIP" "No VIP" || { rc=$?; [[ $rc -eq 1 ]] && ENABLE_VIP="N"; [[ $rc -eq 255 ]] && return 1; return 0; }

    ENABLE_VIP="Y"

    while true; do
        wt_input VIP_ADDRESS "Virtual IP address:" "$VIP_ADDRESS" || return 1
        [[ -n "$VIP_ADDRESS" ]] && break || true
        wt_msg "VIP address is required."
    done

    wt_input VIP_INTERFACE "Network interface (e.g. eth0, ens18):" "${VIP_INTERFACE:-eth0}" || return 1
    VIP_INTERFACE="${VIP_INTERFACE:-eth0}"

    wt_input VIP_NETMASK "Subnet prefix length (e.g. 24 for /24):" "${VIP_NETMASK:-24}" || return 1
    VIP_NETMASK="${VIP_NETMASK:-24}"
}

step_network() {
    local default_subnet
    default_subnet=$(echo "${NODE_IPS[0]}" | sed 's/\.[0-9]*$/.0\/24/')
    PG_HBA_SUBNET="${PG_HBA_SUBNET:-$default_subnet}"

    wt_input PG_HBA_SUBNET \
"Allowed client subnet for pg_hba.conf:
(hosts in this subnet can connect to PostgreSQL)

Example: 192.168.1.0/24" \
        "$PG_HBA_SUBNET" || return 1
    PG_HBA_SUBNET="${PG_HBA_SUBNET:-$default_subnet}"
}

step_postgres() {
    wt_input PG_VERSION \
"PostgreSQL version to install:
(if already installed on nodes, setup will detect it automatically)" \
        "${PG_VERSION:-18}" || return 1
    PG_VERSION="${PG_VERSION:-18}"

    # Update directory defaults when version changes
    PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/${PG_VERSION}/main}"
    PG_BIN_DIR="${PG_BIN_DIR:-/usr/lib/postgresql/${PG_VERSION}/bin}"

    wt_input PG_PORT "PostgreSQL port:" "${PG_PORT:-5432}" || return 1
    PG_PORT="${PG_PORT:-5432}"

    wt_input PG_DATA_DIR "Data directory:" "$PG_DATA_DIR" || return 1

    wt_input PG_BIN_DIR "Binary directory:" "$PG_BIN_DIR" || return 1

    wt_input PG_MAX_CONN "Maximum connections:" "${PG_MAX_CONN:-200}" || return 1
    PG_MAX_CONN="${PG_MAX_CONN:-200}"
}

step_passwords() {
    wt_msg "PASSWORDS

Set passwords for the three PostgreSQL roles.
Leave any blank to auto-generate a secure password.
All passwords will be stored in cluster.conf (chmod 600)."

    enter_password PG_SUPERUSER_PASS "PostgreSQL superuser (postgres) password" || return 1
    enter_password PG_REPLICATOR_PASS "Replication user password" || return 1
    enter_password PG_ADMIN_PASS "Admin user password" || return 1
}

step_monitoring() {
    wt_input MONITOR_PORT \
"Dashboard port:
(the web UI will be available at http://VIP:PORT)" \
        "${MONITOR_PORT:-8080}" || return 1
    MONITOR_PORT="${MONITOR_PORT:-8080}"
}

step_dashboard() {
    wt_input DASH_USER "Dashboard username:" "${DASH_USER:-admin}" || return 1
    DASH_USER="${DASH_USER:-admin}"
    enter_password DASH_PASS "Dashboard password" || return 1
}

step_review() {
    local summary
    summary="REVIEW YOUR CONFIGURATION\n\n"
    summary+="  Cluster:     ${CLUSTER_NAME}  (${NODE_COUNT} nodes)\n"
    summary+="  This node:   ${THIS_NODE}\n\n"
    for i in $(seq 1 "$NODE_COUNT"); do
        local pad=" "
        [[ $i -lt 10 ]] && pad="  "
        summary+="  Node ${i}:${pad}${NODE_NAMES[$((i-1))]}  -  ${NODE_IPS[$((i-1))]}\n"
    done
    summary+="\n"
    if [[ "$ENABLE_VIP" == "Y" ]]; then
        summary+="  VIP:         ${VIP_ADDRESS}/${VIP_NETMASK} on ${VIP_INTERFACE}\n"
    else
        summary+="  VIP:         disabled\n"
    fi
    summary+="  Subnet:      ${PG_HBA_SUBNET}\n"
    summary+="  PostgreSQL:  v${PG_VERSION}  port ${PG_PORT}  max ${PG_MAX_CONN} connections\n"
    summary+="  Dashboard:   port ${MONITOR_PORT}  user '${DASH_USER}'\n"
    summary+="  Passwords:   set (not shown)\n"
    summary+="\nPress Write Config to save, or Back to go back."

    wt_confirm "$summary" "Write Config" "Back" || return 1
}

# ── Write output files ────────────────────────────────────────────────────────

_write_auth() {
    local DASH_SALT DASH_HASH
    DASH_SALT=$(openssl rand -hex 16)
    DASH_HASH=$(python3 -c "
import hashlib, sys
dk = hashlib.scrypt(sys.argv[1].encode(), salt=bytes.fromhex(sys.argv[2]), n=16384, r=8, p=1, dklen=64)
print(dk.hex())
" "${DASH_PASS}" "${DASH_SALT}")
    cat > "${AUTH_FILE}" <<AUTHEOF
{
  "username": "${DASH_USER}",
  "hash": "${DASH_HASH}",
  "salt": "${DASH_SALT}"
}
AUTHEOF
    chmod 600 "${AUTH_FILE}"
}

write_config() {
    local PATRONI_API_PASS ETCD_TOKEN INTERNAL_SECRET BORG_PASSPHRASE
    PATRONI_API_PASS=$(gen_pass)
    ETCD_TOKEN=$(openssl rand -hex 8)
    INTERNAL_SECRET=$(openssl rand -hex 32)
    BORG_PASSPHRASE=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

    cat > "${CONF_FILE}" <<EOF
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
$(for i in $(seq 1 "$NODE_COUNT"); do
    echo "NODE_${i}_NAME=\"${NODE_NAMES[$((i-1))]}\""
    echo "NODE_${i}_IP=\"${NODE_IPS[$((i-1))]}\""
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
PATRONI_API_USER="patroni"
PATRONI_API_PASS="${PATRONI_API_PASS}"

# --- Internal node-to-node auth ---
INTERNAL_SECRET="${INTERNAL_SECRET}"

# --- Monitoring ---
MONITOR_PORT="${MONITOR_PORT}"

# --- Backup (configured via dashboard) ---
ENABLE_BACKUP="n"
BACKUP_SCHEDULE="0 2 * * *"
BACKUP_LOCAL_RETENTION="7"
BORG_PASSPHRASE="${BORG_PASSPHRASE}"
NFS_SERVER=""
NFS_PATH=""
EOF
    chmod 600 "${CONF_FILE}"
    _write_auth

    wt_msg "Done! Configuration written!

  cluster.conf  - cluster settings (chmod 600)
  auth.json     - dashboard credentials (chmod 600)

Next steps:
1. Copy this directory to each other node:
   scp -r $(basename "$SCRIPT_DIR") root@<NODE_IP>:/root/

2. Start setup on Node 1 first, then the rest:
   sudo bash scripts/cluster-setup.sh"
}

# ── Existing-config pre-check (runs once before the wizard) ──────────────────
if [[ -f "$CONF_FILE" ]]; then
    _ec=0
    wt_yesno \
"An existing configuration was found:
  $CONF_FILE

Overwrite it with a fresh configuration, or update
the dashboard login credentials only?" \
        "Overwrite" "Update credentials" || _ec=$?
    if [[ $_ec -eq 0 ]]; then
        : # overwrite — proceed with full wizard
    elif [[ $_ec -eq 255 ]]; then
        clear; echo "Setup cancelled."; exit 1
    else
        _step_update_creds; exit 0
    fi
fi

# ── Main wizard ───────────────────────────────────────────────────────────────
# Fixed ordered list of steps — no dynamic recalculation, no transparent steps.
# Each step returns 0 (advance) or non-zero (go back).
STEPS=(
    step_welcome        # 0
    step_mode           # 1
    step_new_or_join    # 2  (cluster name for new; join wizard for join)
    step_node_count     # 3
    step_this_node      # 4
    step_all_nodes      # 5  (internal per-node navigation)
    step_vip            # 6
    step_network        # 7
    step_postgres       # 8
    step_passwords      # 9
    step_monitoring     # 10
    step_dashboard      # 11
    step_review         # 12
)

POS=0
while [[ $POS -ge 0 && $POS -lt ${#STEPS[@]} ]]; do
    rc=0
    _log "ENTER pos=$POS step=${STEPS[$POS]}"
    "${STEPS[$POS]}" || rc=$?
    if [[ $rc -eq 0 ]]; then
        _log "  rc=0 -> advance to pos=$((POS + 1))"
        POS=$((POS + 1))
    else
        _log "  rc=$rc -> back to pos=$((POS - 1))"
        POS=$((POS - 1))
    fi
done

if [[ $POS -lt 0 ]]; then
    _log "Wizard cancelled (POS=$POS)"
    clear
    echo "Setup cancelled."
    exit 1
fi

_log "Wizard complete — writing config"
write_config
exit 0
