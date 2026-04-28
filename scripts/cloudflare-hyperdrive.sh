#!/bin/bash
# ================================================================
# Setup Cloudflare Hyperdrive for this PostgreSQL cluster
#
# Creates a dedicated database user, enables SSL if needed,
# and provisions a Hyperdrive config via Wrangler CLI.
#
# Usage:
#   ./cloudflare-hyperdrive.sh
#   ./cloudflare-hyperdrive.sh --db mydb --user cf_user --hyperdrive-name my-hd
#
# Prerequisites:
#   - Cloudflare Tunnel running (cloudflare-tunnel.sh)
#   - Access application with a Service Token
#   - Node.js + Wrangler CLI (npm install -g wrangler)
#   - Wrangler authenticated (npx wrangler login)
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cluster-common.sh"
load_config

# ── Defaults ──
HD_NAME="${CLUSTER_NAME:-pg-cluster}-hyperdrive"
HD_DB="${PG_DB:-postgres}"
HD_USER=""
HD_PASS=""
HD_HOST=""
CF_CLIENT_ID=""
CF_CLIENT_SECRET=""
SKIP_DB_SETUP=false

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
    case "$1" in
        --db)               HD_DB="$2"; shift 2 ;;
        --user)             HD_USER="$2"; shift 2 ;;
        --password)         HD_PASS="$2"; shift 2 ;;
        --host)             HD_HOST="$2"; shift 2 ;;
        --hyperdrive-name)  HD_NAME="$2"; shift 2 ;;
        --access-client-id)     CF_CLIENT_ID="$2"; shift 2 ;;
        --access-client-secret) CF_CLIENT_SECRET="$2"; shift 2 ;;
        --skip-db-setup)    SKIP_DB_SETUP=true; shift ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --db <name>                 Database name (default: postgres)"
            echo "  --user <name>               Hyperdrive DB user to create"
            echo "  --password <pass>           Password for the DB user (auto-generated if omitted)"
            echo "  --host <hostname>           Tunnel hostname (e.g. db-cluster.example.com)"
            echo "  --hyperdrive-name <name>    Hyperdrive config name (default: <cluster>-hyperdrive)"
            echo "  --access-client-id <id>     Cloudflare Access Client ID"
            echo "  --access-client-secret <s>  Cloudflare Access Client Secret"
            echo "  --skip-db-setup             Skip DB user creation (user already exists)"
            echo "  -h, --help                  Show this help"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo "=== Cloudflare Hyperdrive Setup ==="
echo ""

# ── Interactive prompts for missing values ──
if [ -z "$HD_HOST" ]; then
    read -rp "Tunnel hostname (e.g. db-cluster.example.com): " HD_HOST
fi

if [ -z "$HD_USER" ]; then
    read -rp "Database user for Hyperdrive (will be created): " HD_USER
fi

if [ -z "$HD_PASS" ]; then
    HD_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    echo "Generated password: ${HD_PASS}"
fi

if [ -z "$HD_DB" ] || [ "$HD_DB" = "postgres" ]; then
    read -rp "Database name [${HD_DB}]: " input_db
    HD_DB="${input_db:-$HD_DB}"
fi

if [ -z "$CF_CLIENT_ID" ]; then
    read -rp "Cloudflare Access Client ID: " CF_CLIENT_ID
fi

if [ -z "$CF_CLIENT_SECRET" ]; then
    read -rsp "Cloudflare Access Client Secret: " CF_CLIENT_SECRET
    echo ""
fi

# ── Step 1: Check prerequisites ──
echo ""
echo "[1/5] Checking prerequisites..."

if ! command -v npx &>/dev/null; then
    echo "ERROR: Node.js / npx not found. Install Node.js first."
    exit 1
fi

if ! npx wrangler --version &>/dev/null 2>&1; then
    echo "Installing Wrangler CLI..."
    npm install -g wrangler
fi

echo "Wrangler $(npx wrangler --version 2>&1) ready."

# ── Step 2: Enable SSL on PostgreSQL ──
echo ""
echo "[2/5] Checking PostgreSQL SSL..."

SSL_STATUS=$(sudo -u postgres psql -tAc "SHOW ssl;" 2>/dev/null || echo "unknown")

if [ "$SSL_STATUS" = "on" ]; then
    echo "SSL is already enabled."
elif [ "$SSL_STATUS" = "off" ]; then
    echo "SSL is OFF. Enabling via Patroni..."

    PATRONI_CONF=$(find /etc/patroni -name "*.yml" 2>/dev/null | head -1)
    if [ -z "$PATRONI_CONF" ]; then
        echo "ERROR: Patroni config not found. Enable SSL manually:"
        echo "  patronictl edit-config → set ssl: 'on' under postgresql.parameters"
        exit 1
    fi

    patronictl -c "$PATRONI_CONF" edit-config --apply \
        --set 'postgresql.parameters.ssl=on' \
        --set 'postgresql.parameters.ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem' \
        --set 'postgresql.parameters.ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key' \
        2>/dev/null || {
        echo "Auto-config failed. Enable SSL manually via patronictl edit-config."
        echo "Then restart: patronictl restart ${CLUSTER_NAME}"
        exit 1
    }

    echo "SSL enabled. Restarting PostgreSQL..."
    patronictl -c "$PATRONI_CONF" restart "${CLUSTER_NAME}" --force 2>/dev/null || true
    sleep 3

    SSL_CHECK=$(sudo -u postgres psql -tAc "SHOW ssl;" 2>/dev/null)
    if [ "$SSL_CHECK" = "on" ]; then
        echo "SSL verified: on"
    else
        echo "WARNING: SSL may not be active yet. Verify manually: sudo -u postgres psql -c 'SHOW ssl;'"
    fi
else
    echo "Could not check SSL status. Verify manually before proceeding."
fi

# ── Step 3: Create database user ──
echo ""
echo "[3/5] Setting up database user..."

if [ "$SKIP_DB_SETUP" = true ]; then
    echo "Skipping DB user creation (--skip-db-setup)."
else
    # Validate identifiers — must be simple SQL identifiers (no injection possible)
    if ! [[ "${HD_USER}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        echo "ERROR: HD_USER '${HD_USER}' contains invalid characters. Use only letters, digits, underscores." >&2
        exit 1
    fi
    if ! [[ "${HD_DB}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        echo "ERROR: HD_DB '${HD_DB}' contains invalid characters. Use only letters, digits, underscores." >&2
        exit 1
    fi
    # Escape password by doubling any single-quotes (safe for SQL literal)
    HD_PASS_ESC="${HD_PASS//\'/\'\'}"

    # Create or update user
    if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${HD_USER}'" | grep -q 1; then
        echo "User '${HD_USER}' already exists. Updating password..."
        sudo -u postgres psql -c "ALTER USER \"${HD_USER}\" WITH PASSWORD '${HD_PASS_ESC}';"
    else
        echo "Creating user '${HD_USER}'..."
        sudo -u postgres psql -c "CREATE USER \"${HD_USER}\" WITH PASSWORD '${HD_PASS_ESC}';"
    fi

    # Grant access
    sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"${HD_DB}\" TO \"${HD_USER}\";"
    sudo -u postgres psql -d "${HD_DB}" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"${HD_USER}\";"
    sudo -u postgres psql -d "${HD_DB}" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO \"${HD_USER}\";"

    # Add pg_hba entry — merge into existing array, do not replace it
    echo "Adding pg_hba entry for SSL connections..."
    PATRONI_CONF=$(find /etc/patroni -name "config.yml" 2>/dev/null | head -1)
    if [ -n "$PATRONI_CONF" ]; then
        if ! sudo -u postgres psql -tAc "SELECT 1" | grep -q 1 2>/dev/null || \
           ! grep -q "hostssl.*${HD_USER}" "$PATRONI_CONF" 2>/dev/null; then
            # Read current pg_hba from Patroni DCS and append the new entry
            NEW_RULE="hostssl all ${HD_USER} ${PG_HBA_SUBNET} scram-sha-256"
            EXISTING=$(patronictl -c "$PATRONI_CONF" show-config 2>/dev/null | \
                python3 -c "
import sys, yaml
cfg = yaml.safe_load(sys.stdin)
hba = cfg.get('postgresql', {}).get('pg_hba', [])
print('\n'.join(hba))
" 2>/dev/null || true)
            MERGED_JSON=$(python3 -c "
import json, sys
existing = [l for l in '''${EXISTING}'''.splitlines() if l.strip()]
new_rule = '${NEW_RULE}'
if new_rule not in existing:
    existing.append(new_rule)
print(json.dumps(existing))
")
            patronictl -c "$PATRONI_CONF" edit-config --apply \
                --set "postgresql.pg_hba=${MERGED_JSON}" \
                2>/dev/null || echo "NOTE: Add '${NEW_RULE}' to pg_hba manually."
        fi
    fi

    echo "User '${HD_USER}' configured with access to '${HD_DB}'."
fi

# ── Step 4: Create Hyperdrive config ──
echo ""
echo "[4/5] Creating Hyperdrive configuration..."

HD_OUTPUT=$(npx wrangler hyperdrive create "$HD_NAME" \
    --origin-host="$HD_HOST" \
    --origin-user="$HD_USER" \
    --origin-password="$HD_PASS" \
    --database="$HD_DB" \
    --access-client-id="$CF_CLIENT_ID" \
    --access-client-secret="$CF_CLIENT_SECRET" 2>&1) || {
    echo "ERROR: Failed to create Hyperdrive config."
    echo "$HD_OUTPUT"
    echo ""
    echo "Common fixes:"
    echo "  - Run 'npx wrangler login' first"
    echo "  - Don't use --origin-port with --access-client-id"
    echo "  - Don't use --connection-string with --access-client-id"
    exit 1
}

echo "$HD_OUTPUT"

# Extract the Hyperdrive ID
HD_ID=$(echo "$HD_OUTPUT" | grep -oP '[0-9a-f]{32}' | head -1)
if [ -z "$HD_ID" ]; then
    HD_ID=$(echo "$HD_OUTPUT" | grep -oP 'id:\s*\K\S+' | head -1)
fi

# ── Step 5: Output summary ──
echo ""
echo "[5/5] Setup complete!"
echo ""
echo "=== Hyperdrive Configuration ==="
echo ""
echo "  Name:      ${HD_NAME}"
echo "  ID:        ${HD_ID:-<check output above>}"
echo "  Host:      ${HD_HOST}"
echo "  Database:  ${HD_DB}"
echo "  User:      ${HD_USER}"
echo "  Password:  ${HD_PASS}"
echo ""
echo "=== Add to your wrangler.jsonc ==="
echo ""
echo '  "hyperdrive": ['
echo '    {'
echo '      "binding": "HYPERDRIVE",'
echo "      \"id\": \"${HD_ID:-YOUR_HYPERDRIVE_ID}\""
echo '    }'
echo '  ]'
echo ""
echo "=== Worker usage ==="
echo ""
echo '  import { Client } from "pg";'
echo '  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });'
echo '  await client.connect();'
echo ""

# Save config for reference
CONF_OUT="${SCRIPT_DIR}/../hyperdrive.conf"
cat > "$CONF_OUT" << HDCONF
# Cloudflare Hyperdrive config — generated $(date -Iseconds)
HYPERDRIVE_NAME="${HD_NAME}"
HYPERDRIVE_ID="${HD_ID:-}"
HYPERDRIVE_HOST="${HD_HOST}"
HYPERDRIVE_DB="${HD_DB}"
HYPERDRIVE_USER="${HD_USER}"
HYPERDRIVE_PASS="${HD_PASS}"
CF_ACCESS_CLIENT_ID="${CF_CLIENT_ID}"
HDCONF

echo "Config saved to: $(realpath "$CONF_OUT")"
echo ""
echo "=== Done ==="
