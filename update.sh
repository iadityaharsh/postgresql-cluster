#!/bin/bash
# ================================================================
# Update postgresql-cluster — pulls latest code, updates system
# packages, preserves config
# Usage: bash update.sh  (or from install script with --upgrade)
# ================================================================

set -euo pipefail

# ---- Parse args ----
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -h|--help)
            echo "Usage: $0 [--dry-run]"
            echo "  --dry-run  Show what would be updated without making changes"
            exit 0
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# If run from outside the repo, find it
if [ ! -f "${SCRIPT_DIR}/.git/HEAD" ]; then
    for candidate in /root/postgresql-cluster "$HOME/postgresql-cluster" /opt/postgresql-cluster; do
        if [ -d "${candidate}/.git" ]; then
            SCRIPT_DIR="${candidate}"
            break
        fi
    done
fi

cd "${SCRIPT_DIR}"

if [ ! -f ".git/HEAD" ]; then
    echo "ERROR: Not a git repository. Run install.sh first."
    exit 1
fi

get_version() {
    git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "0.0.0"
}

OLD_VERSION=$(get_version)
OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")

# Rollback to the pre-pull commit if a deploy phase fails after the git pull.
rollback_on_failure() {
    local exit_code=$?
    if [ "${PG_UPDATE_PHASE:-}" = "deploy" ] && [ -n "${PRE_PULL_COMMIT:-}" ] && [ "${exit_code}" -ne 0 ]; then
        echo ""
        echo "ERROR: Update failed (exit ${exit_code}). Rolling back to ${PRE_PULL_COMMIT}..."
        git reset --hard "${PRE_PULL_COMMIT}" 2>/dev/null || \
            echo "WARNING: Rollback failed. Manual recovery required: git reset --hard ${PRE_PULL_COMMIT}"
    fi
    exit "${exit_code}"
}

# Phase 1: pull and re-exec so the deploy phase always runs from the latest script
if [ "${PG_UPDATE_PHASE:-}" != "deploy" ]; then
    echo "=== PostgreSQL Cluster Update ==="
    echo ""
    echo "  Current version: ${OLD_VERSION}"

    if [ "${DRY_RUN}" = true ]; then
        echo "  *** DRY-RUN MODE — no changes will be made ***"
        echo ""
        echo "  Fetching origin to compare..."
        git fetch origin --tags -f &>/dev/null || true
        REMOTE_COMMIT=$(git rev-parse origin/main 2>/dev/null || echo "unknown")
        echo "  Local HEAD:  ${OLD_COMMIT}"
        echo "  Remote main: ${REMOTE_COMMIT}"
        if [ "${OLD_COMMIT}" = "${REMOTE_COMMIT}" ]; then
            echo "  Already up to date — no changes would be applied."
        else
            echo ""
            echo "  Commits that would be pulled:"
            git log --oneline "${OLD_COMMIT}..${REMOTE_COMMIT}" 2>/dev/null | head -20 || echo "  (unable to list)"
            echo ""
            echo "  Files that would change:"
            git diff --stat "${OLD_COMMIT}..${REMOTE_COMMIT}" 2>/dev/null | tail -20 || echo "  (unable to diff)"
        fi
        echo ""
        echo "  Re-run without --dry-run to apply."
        exit 0
    fi

    echo "  Pulling latest from GitHub..."
    echo ""

    git fetch origin --tags -f
    git pull origin main

    # Re-exec the freshly pulled script for the deploy phase
    PG_UPDATE_PHASE=deploy OLD_VERSION="${OLD_VERSION}" PRE_PULL_COMMIT="${OLD_COMMIT}" exec bash "$0" "$@"
fi

# Deploy phase: install rollback trap so failures revert the pull.
trap rollback_on_failure EXIT

# Phase 2: deploy (always runs from the latest version of this script)
NEW_VERSION=$(get_version)

if [ "${OLD_VERSION}" = "${NEW_VERSION}" ]; then
    echo ""
    echo "  Already up to date (v${NEW_VERSION})."
else
    echo ""
    echo "  Updated: v${OLD_VERSION} -> v${NEW_VERSION}"
fi

# ---- Check and install missing dependencies ----
echo ""
echo "  Checking dependencies..."

NEED_APT=false

# Check what's missing before hitting the network
command -v node &>/dev/null || NEED_APT=true
command -v showmount &>/dev/null || NEED_APT=true
command -v python3 &>/dev/null || NEED_APT=true
command -v etcd &>/dev/null || NEED_APT=true
command -v vip-manager &>/dev/null || NEED_APT=true

# Only run apt-get update if we actually need to install something
if [ "${NEED_APT}" = "true" ]; then
    apt-get update -qq 2>/dev/null
fi

# Node.js
if ! command -v node &>/dev/null; then
    echo "  Installing Node.js..."
    apt-get install -y -qq curl gnupg >/dev/null 2>&1
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
    echo "  Node.js $(node --version) installed."
fi

# nfs-common (for showmount)
if ! command -v showmount &>/dev/null; then
    echo "  Installing nfs-common..."
    apt-get install -y -qq nfs-common >/dev/null 2>&1
fi

# Python3 + pip (needed for Patroni)
if ! command -v python3 &>/dev/null; then
    echo "  Installing python3..."
    apt-get install -y -qq python3 python3-pip python3-venv python3-psycopg2 >/dev/null 2>&1
fi

# Patroni
if ! command -v patroni &>/dev/null; then
    echo "  Installing Patroni..."
    python3 -m venv /opt/patroni 2>/dev/null || true
    /opt/patroni/bin/pip install psycopg2-binary patroni[etcd3] >/dev/null 2>&1
    ln -sf /opt/patroni/bin/patroni /usr/local/bin/patroni
    ln -sf /opt/patroni/bin/patronictl /usr/local/bin/patronictl
fi

# etcd
if ! command -v etcd &>/dev/null; then
    echo "  Installing etcd..."
    if ! apt-get install -y -qq etcd 2>/dev/null; then
        ETCD_VERSION="3.5.21"
        cd /tmp
        wget -q "https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-amd64.tar.gz" -O etcd.tar.gz
        tar xzf etcd.tar.gz
        cp "etcd-v${ETCD_VERSION}-linux-amd64/etcd" /usr/local/bin/
        cp "etcd-v${ETCD_VERSION}-linux-amd64/etcdctl" /usr/local/bin/
        rm -rf etcd*
        cd "${SCRIPT_DIR}"
    fi
fi

# vip-manager
if ! command -v vip-manager &>/dev/null; then
    echo "  Installing vip-manager..."
    apt-get install -y -qq vip-manager 2>/dev/null || true
fi

echo "  Dependencies OK."

# ---- Sync dashboard files ----
echo ""
echo "  Syncing files..."

# Copy web app + scripts to /opt/pg-monitor (preserves cluster.conf)
mkdir -p /opt/pg-monitor/scripts
cp -r web/* /opt/pg-monitor/
cp scripts/*.sh /opt/pg-monitor/scripts/ 2>/dev/null || true

# Update backup script if it exists
if [ -d /opt/pg-backup ]; then
    cp scripts/pg-backup.sh /opt/pg-backup/pg-backup.sh 2>/dev/null || true
    chmod +x /opt/pg-backup/pg-backup.sh 2>/dev/null || true
fi

# Write version from git tag
echo "${NEW_VERSION}" > /opt/pg-monitor/VERSION

# Install any new npm dependencies
cd /opt/pg-monitor
npm install --production --silent 2>/dev/null

# Fix systemd service: Restart=always so dashboard recovers after upgrade
if grep -q 'Restart=on-failure' /etc/systemd/system/pg-monitor.service 2>/dev/null; then
    sed -i 's/Restart=on-failure/Restart=always/' /etc/systemd/system/pg-monitor.service
    systemctl daemon-reload
    echo "  Fixed pg-monitor service restart policy."
fi

echo ""
echo "=== Update complete (v${NEW_VERSION}) ==="
echo ""
echo "  Dashboard will be available in a few seconds."
echo "  Run this on each node to update the full cluster."

# If run manually from CLI, restart the service
# When run from the dashboard, server.js handles its own restart
if [ "${PG_DASHBOARD_UPGRADE:-}" != "1" ]; then
    echo "  Restarting pg-monitor..."
    systemctl restart pg-monitor 2>/dev/null || true
fi

# Update succeeded — disarm the rollback trap.
trap - EXIT
