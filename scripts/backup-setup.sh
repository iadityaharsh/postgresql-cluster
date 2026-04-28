#!/bin/bash
# ================================================================
# Setup Borg Backup for PostgreSQL — supports NFS and SMB/CIFS
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cluster-common.sh"
load_config

if [[ "${ENABLE_BACKUP}" != "Y" && "${ENABLE_BACKUP}" != "y" ]]; then
    echo "Backups are not enabled in cluster.conf. Skipping."
    exit 0
fi

MOUNT_POINT="/mnt/pg-backup"

# Detect storage type
if [ -n "${NFS_SERVER:-}" ] && [ -n "${NFS_PATH:-}" ]; then
    STORAGE_TYPE="nfs"
elif [ -n "${SMB_SHARE:-}" ]; then
    STORAGE_TYPE="smb"
else
    echo "No storage backend configured (NFS or SMB). Skipping backup setup."
    exit 0
fi

echo "--- Setting up Borg Backup (${STORAGE_TYPE^^}) ---"

# Install packages
echo "Installing borgbackup..."
apt-get update -qq
if [ "${STORAGE_TYPE}" = "nfs" ]; then
    apt-get install -y -qq borgbackup nfs-common >/dev/null 2>&1
else
    apt-get install -y -qq borgbackup cifs-utils >/dev/null 2>&1
fi
echo "Borg $(borg --version) installed."

# Add fstab entry for persistent mount
mkdir -p "${MOUNT_POINT}"

# Remove any old entries for this mount point
sed -i '\|/mnt/pg-backup|d' /etc/fstab

if [ "${STORAGE_TYPE}" = "nfs" ]; then
    NFS_MOUNT="${NFS_SERVER}:${NFS_PATH}"

    # Try systemd automount first — fall back to fstab if it fails (e.g. unprivileged LXC)
    cat > /etc/systemd/system/mnt-pg\\x2dbackup.mount << MOUNTEOF
[Unit]
Description=NFS backup mount
After=network-online.target
Wants=network-online.target

[Mount]
What=${NFS_MOUNT}
Where=${MOUNT_POINT}
Type=nfs
Options=rw,soft,timeo=30,retrans=3,_netdev
TimeoutSec=30

[Install]
WantedBy=multi-user.target
MOUNTEOF

    cat > /etc/systemd/system/mnt-pg\\x2dbackup.automount << AUTOMOUNTEOF
[Unit]
Description=Automount NFS backup on access
After=network-online.target

[Automount]
Where=${MOUNT_POINT}
TimeoutIdleSec=0

[Install]
WantedBy=multi-user.target
AUTOMOUNTEOF

    systemctl daemon-reload
    if systemctl enable --now mnt-pg\\x2dbackup.automount 2>/dev/null; then
        AUTOMOUNT_OK=true
        echo "systemd automount: ${NFS_MOUNT} -> ${MOUNT_POINT} (NFS, auto-remount on access)"
    else
        # Automount not supported (unprivileged LXC) — clean up and use fstab
        AUTOMOUNT_OK=false
        rm -f /etc/systemd/system/mnt-pg\\x2dbackup.mount /etc/systemd/system/mnt-pg\\x2dbackup.automount
        systemctl daemon-reload
        echo "${NFS_MOUNT} ${MOUNT_POINT} nfs rw,soft,timeo=30,retrans=3,nofail,_netdev 0 0" >> /etc/fstab
        echo "fstab entry: ${NFS_MOUNT} -> ${MOUNT_POINT} (NFS, automount not supported — using fstab)"
    fi
else
    # SMB/CIFS mount
    SMB_USER="${SMB_USER:-guest}"
    SMB_PASS="${SMB_PASS:-}"
    SMB_DOMAIN="${SMB_DOMAIN:-WORKGROUP}"

    # Store credentials securely
    CRED_FILE="/etc/pg-backup-smb-credentials"
    cat > "${CRED_FILE}" << CREDEOF
username=${SMB_USER}
password=${SMB_PASS}
domain=${SMB_DOMAIN}
CREDEOF
    chmod 600 "${CRED_FILE}"

    echo "${SMB_SHARE} ${MOUNT_POINT} cifs credentials=${CRED_FILE},iocharset=utf8,nofail,_netdev 0 0" >> /etc/fstab
    echo "fstab entry: ${SMB_SHARE} -> ${MOUNT_POINT} (SMB/CIFS)"
fi

# Mount now
if [ "${STORAGE_TYPE}" = "nfs" ]; then
    if [ "${AUTOMOUNT_OK}" = "true" ]; then
        # Trigger automount by accessing the directory
        ls "${MOUNT_POINT}/" >/dev/null 2>&1 || {
            echo "WARNING: Could not mount NFS share. Check NFS server and network."
            echo "         The automount will retry on next access."
        }
    else
        MOUNT_ERR=$(mount "${MOUNT_POINT}" 2>&1) || MOUNT_ERR=$(mount -t nfs -o rw,soft,timeo=30,retrans=3 "${NFS_MOUNT}" "${MOUNT_POINT}" 2>&1) || {
            echo "WARNING: Could not mount NFS share."
            echo "         Error: ${MOUNT_ERR}"
            echo ""
            echo "         If running in a Proxmox LXC container, enable NFS mount support:"
            echo "           pct set <CTID> -features mount=nfs"
            echo "         Then restart the container and re-run storage setup."
            echo ""
            echo "         Or try manually: mount ${MOUNT_POINT}"
        }
    fi
else
    mount "${MOUNT_POINT}" 2>/dev/null || mount -a || {
        echo "WARNING: Could not mount SMB share. Check credentials and network."
        echo "         Note: SMB/CIFS requires CAP_SYS_ADMIN — not available in unprivileged LXC containers."
        echo "         Try manually: mount ${MOUNT_POINT}"
    }
fi

if mountpoint -q "${MOUNT_POINT}"; then
    echo "${STORAGE_TYPE^^} share mounted at ${MOUNT_POINT}"

    # Auto-generate BORG_PASSPHRASE if not set
    BORG_REPO="${MOUNT_POINT}/borg-repo"
    if [ -z "${BORG_PASSPHRASE:-}" ]; then
        BORG_PASSPHRASE="$(openssl rand -base64 32)"
        # Save to cluster.conf (both live copy and repo copy)
        for conf_target in "${SCRIPT_DIR}/../cluster.conf" /opt/pg-monitor/cluster.conf /opt/pg-backup/cluster.conf; do
            if [ -f "${conf_target}" ]; then
                if grep -q '^BORG_PASSPHRASE=' "${conf_target}"; then
                    sed -i "s|^BORG_PASSPHRASE=.*|BORG_PASSPHRASE=\"${BORG_PASSPHRASE}\"|" "${conf_target}"
                else
                    echo "BORG_PASSPHRASE=\"${BORG_PASSPHRASE}\"" >> "${conf_target}"
                fi
            fi
        done
        echo ""
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║              SAVE THIS BORG PASSPHRASE                      ║"
        echo "╠══════════════════════════════════════════════════════════════╣"
        echo "║  ${BORG_PASSPHRASE}"
        echo "╠══════════════════════════════════════════════════════════════╣"
        echo "║  Stored in cluster.conf as BORG_PASSPHRASE.                 ║"
        echo "║  You need this to restore backups if cluster.conf is lost.  ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
        echo ""
    fi
    export BORG_PASSPHRASE

    if [ -d "${BORG_REPO}" ]; then
        # Existing repo — verify the passphrase connects
        if BORG_PASSPHRASE="${BORG_PASSPHRASE}" borg info "${BORG_REPO}" >/dev/null 2>&1; then
            echo "Connected to existing Borg repository at ${BORG_REPO}"
        else
            echo "ERROR: A Borg repository exists at ${BORG_REPO} but the passphrase in"
            echo "  cluster.conf does not match. Set the correct BORG_PASSPHRASE in"
            echo "  cluster.conf and re-run backup setup."
            exit 1
        fi
    else
        echo "Initializing Borg repository (encrypted with repokey-blake2)..."
        borg init --encryption=repokey-blake2 "${BORG_REPO}"
        echo "Borg repo created at ${BORG_REPO}"

        # Export the encryption key for safekeeping
        BORG_KEY_EXPORT="/opt/pg-backup/borg-key-export.txt"
        mkdir -p /opt/pg-backup
        borg key export "${BORG_REPO}" "${BORG_KEY_EXPORT}" 2>/dev/null || true
        chmod 600 "${BORG_KEY_EXPORT}"
        echo ""
        echo "IMPORTANT: Borg encryption key exported to ${BORG_KEY_EXPORT}"
        echo "  Back up this file alongside the passphrase above —"
        echo "  both are needed to restore backups from scratch."
    fi
fi

# Install backup script
BACKUP_SCRIPT="/opt/pg-backup/backup-run.sh"
mkdir -p /opt/pg-backup
cp "${SCRIPT_DIR}/backup-run.sh" "${BACKUP_SCRIPT}"
chmod +x "${BACKUP_SCRIPT}"

# Copy cluster.conf for the backup script
cp "${SCRIPT_DIR}/../cluster.conf" /opt/pg-backup/ 2>/dev/null || true

# Setup cron (only runs backup on the leader node)
CRON_SCHEDULE="${BACKUP_SCHEDULE:-0 2 * * *}"

# Clean up legacy crontab entry if present
sed -i '/pg-backup/d' /etc/crontab 2>/dev/null || true

# Use a dedicated cron file — passphrase is read from cluster.conf at runtime
# (backup-run.sh already sources cluster.conf, which contains BORG_PASSPHRASE)
cat > /etc/cron.d/pg-backup << CRONEOF
# PostgreSQL Borg Backup — managed by postgresql-cluster
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${CRON_SCHEDULE} root /opt/pg-backup/backup-run.sh >> /var/log/pg-backup.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/pg-backup
echo "Cron file written to /etc/cron.d/pg-backup (schedule: ${CRON_SCHEDULE})"

# Install logrotate config
cat > /etc/logrotate.d/pg-backup << 'LOGEOF'
/var/log/pg-backup.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    create 640 root root
}
LOGEOF

echo ""
echo "--- Borg Backup setup complete ---"
if [ "${STORAGE_TYPE}" = "nfs" ]; then
    echo "  Storage:    NFS — ${NFS_SERVER}:${NFS_PATH}"
else
    echo "  Storage:    SMB — ${SMB_SHARE}"
fi
echo "  Mount:      ${MOUNT_POINT}"
echo "  Borg repo:  ${MOUNT_POINT}/borg-repo"
echo "  Schedule:   ${CRON_SCHEDULE}"
echo "  Log:        /var/log/pg-backup.log"
echo ""
echo "  Manual backup:  /opt/pg-backup/backup-run.sh"
echo "  List backups:   borg list ${MOUNT_POINT}/borg-repo"
echo "  Restore:        borg extract --stdout ${MOUNT_POINT}/borg-repo::ARCHIVE | psql -h VIP -U postgres"
echo "  Note: Set BORG_PASSPHRASE from cluster.conf before running borg commands manually."
