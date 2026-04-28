# Cluster Disaster Recovery

## Prerequisites

All recovery procedures require:
- The `BORG_PASSPHRASE` from your `cluster.conf`
- Access to the NFS/SMB backup share
- The Borg encryption key (exported to `/opt/pg-backup/borg-key-export.txt` during setup)

## Listing Available Backups

```bash
export BORG_PASSPHRASE="<from cluster.conf>"
borg list /mnt/pg-backup/borg-repo
```

## Inspecting a Backup

```bash
borg info /mnt/pg-backup/borg-repo::<archive-name>
```

## Verifying Backup Integrity

```bash
borg check /mnt/pg-backup/borg-repo
```

## Recovery Scenarios

### Scenario 1: Single Replica Lost

Patroni handles this automatically. The failed node will rejoin and stream data from the primary when it comes back online. No manual intervention needed.

To force a rebuild:
```bash
patronictl -c /etc/patroni/config.yml reinit <cluster-name> <node-name>
```

### Scenario 2: Primary Node Lost (Automatic Failover)

Patroni automatically promotes a replica to primary. Once the failed node is restored:
1. Ensure Patroni is running: `systemctl start patroni`
2. It will automatically rejoin as a replica

### Scenario 3: Restore to Existing Cluster

Via the dashboard:
1. Go to Backups tab
2. Click Restore on the desired archive
3. Confirm the warning dialog
4. A safety backup is created automatically before restore begins

Via CLI:
```bash
export BORG_PASSPHRASE="<from cluster.conf>"
export PGPASSWORD="<PG_SUPERUSER_PASS from cluster.conf>"
borg extract --stdout /mnt/pg-backup/borg-repo::<archive> \
    | psql -h <VIP_ADDRESS> -p 5432 -U postgres -f -
```

### Scenario 4: Total Cluster Loss

1. Provision new nodes and install the project:
   ```bash
   bash install.sh
   ```
2. Run the configuration wizard with the same settings as the original cluster
3. Run setup on Node 1 first, wait for it to become Leader
4. Run setup on remaining nodes
5. Stop Patroni on the primary:
   ```bash
   systemctl stop patroni
   ```
6. Mount the backup share and restore:
   ```bash
   mount /mnt/pg-backup
   export BORG_PASSPHRASE="<passphrase>"
   su - postgres -c "pg_dumpall -f /tmp/current_state.sql" # safety dump
   borg extract --stdout /mnt/pg-backup/borg-repo::<archive> \
       | psql -h localhost -U postgres -f -
   ```
7. Restart Patroni:
   ```bash
   systemctl start patroni
   ```

## Limitations

### No Point-in-Time Recovery (PITR)

This cluster uses `pg_dumpall`-based backups via Borg. WAL archiving is intentionally
disabled (`archive_command: "/bin/true"`). This means:

- Backups capture database state at the time the dump runs
- Any transactions committed between the last backup and a failure are **lost**
- You cannot restore to an arbitrary point in time
- Data between scheduled backups is protected only by streaming replication across nodes

For most use cases with regular backup schedules (e.g., every 2 hours), this is acceptable.
If you need PITR, configure `archive_command` in `scripts/templates/patroni.yml` to ship WAL
segments to your Borg repository or an S3-compatible store.

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| Borg repo | `/mnt/pg-backup/borg-repo` | Backup archives |
| Borg key export | `/opt/pg-backup/borg-key-export.txt` | Encryption key backup |
| Backup script | `/opt/pg-backup/backup-run.sh` | Cron-triggered backup |
| Backup log | `/var/log/pg-backup.log` | Backup history |
| Cron config | `/etc/cron.d/pg-backup` | Backup schedule |
| Cluster config | `cluster.conf` | Contains BORG_PASSPHRASE |
