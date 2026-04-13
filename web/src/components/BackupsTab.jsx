import React, { useState, useCallback, useEffect, useRef } from 'react';
import Toast from './Toast';
import ConfirmModal from './ConfirmModal';
import TaskViewer from './TaskViewer';
import { formatDate } from './utils';

export default function BackupsTab() {
  const [backups, setBackups] = useState({ available: false, archives: [] });
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backupRunning, setBackupRunning] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [taskViewer, setTaskViewer] = useState(null);
  const [storageForm, setStorageForm] = useState({ type: 'nfs', nfs_server: '', nfs_path: '', smb_share: '', smb_user: '', smb_pass: '', smb_domain: 'WORKGROUP', schedule: '0 2 * * *', retention: '7' });
  const [nfsExports, setNfsExports] = useState([]);
  const [nfsExportsLoading, setNfsExportsLoading] = useState(false);
  const nfsScannedRef = useRef('');

  const scanNfsExports = useCallback(async (server) => {
    if (!server || !/^\d+\.\d+\.\d+\.\d+$/.test(server)) return;
    if (server === nfsScannedRef.current) return;
    nfsScannedRef.current = server;
    setNfsExportsLoading(true);
    try {
      const data = await fetch(`/api/storage/nfs-exports?server=${server}`).then(r => r.json());
      setNfsExports(data.exports || []);
    } catch { setNfsExports([]); }
    setNfsExportsLoading(false);
  }, []);

  const fetchBackups = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([
        fetch('/api/backups').then(r => r.json()),
        fetch('/api/backups/status').then(r => r.json())
      ]);
      setBackups(list);
      setBackupRunning(status.running);
    } catch {}
    setLoading(false);
  }, []);

  const fetchStorage = useCallback(async () => {
    try {
      const data = await fetch('/api/storage').then(r => r.json());
      setStorage(data);
      if (data.nfs_server || data.nfs_path || data.smb_share) {
        setStorageForm({ type: data.type || 'nfs', nfs_server: data.nfs_server || '', nfs_path: data.nfs_path || '', smb_share: data.smb_share || '', smb_user: data.smb_user || '', smb_pass: '', smb_domain: data.smb_domain || 'WORKGROUP', schedule: data.schedule || '0 2 * * *', retention: data.retention || '7' });
      }
    } catch {
      setStorage({ enabled: false, type: 'none', nfs_server: '', nfs_path: '', smb_share: '', mounted: false });
    }
  }, []);

  useEffect(() => {
    fetchBackups();
    fetchStorage();
    const interval = setInterval(() => { fetchBackups(); fetchStorage(); }, 5000);
    return () => clearInterval(interval);
  }, [fetchBackups, fetchStorage]);

  const createBackup = async () => {
    try {
      const resp = await fetch('/api/backups', { method: 'POST' });
      const data = await resp.json();
      if (resp.ok) {
        setBackupRunning(true);
        setTaskViewer({ title: 'Backup — pg_dumpall + Borg', statusUrl: '/api/backups/status' });
      } else {
        setToast({ message: data.error, type: 'error' });
      }
    } catch { setToast({ message: 'Failed to start backup', type: 'error' }); }
  };

  const restoreBackup = async (archive) => {
    setConfirmRestore(null);
    try {
      const resp = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive, confirm: true })
      });
      const data = await resp.json();
      if (resp.ok) {
        setTaskViewer({ title: `Restore — ${archive}`, statusUrl: '/api/backups/restore/status' });
      } else {
        setToast({ message: data.error, type: 'error' });
      }
    } catch { setToast({ message: 'Failed to start restore', type: 'error' }); }
  };

  const deleteArchive = async (name) => {
    setConfirmDelete(null);
    try {
      const resp = await fetch(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await resp.json();
      if (resp.ok) { setToast({ message: data.message, type: 'success' }); fetchBackups(); }
      else { setToast({ message: data.error, type: 'error' }); }
    } catch { setToast({ message: 'Failed to delete archive', type: 'error' }); }
  };

  const configureStorage = async () => {
    try {
      const resp = await fetch('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storageForm)
      });
      const data = await resp.json();
      if (resp.ok) {
        if (storageForm.type !== 'none') {
          setTaskViewer({ title: 'Borg Setup — ' + (storageForm.type === 'nfs' ? 'NFS' : 'SMB'), statusUrl: '/api/storage/status' });
        } else {
          setToast({ message: 'Backups disabled', type: 'success' });
          fetchStorage();
        }
      } else {
        setToast({ message: data.error, type: 'error' });
      }
    } catch { setToast({ message: 'Failed to configure storage', type: 'error' }); }
  };

  const closeTaskViewer = () => {
    setTaskViewer(null);
    fetchBackups();
    fetchStorage();
  };

  const storageConfigured = storage && storage.enabled && storage.type !== 'none';
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const resetStorage = async () => {
    setShowResetConfirm(false);
    try {
      const resp = await fetch('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'none' })
      });
      if (resp.ok) {
        setStorageForm({ type: 'nfs', nfs_server: '', nfs_path: '', smb_share: '', smb_user: '', smb_pass: '', smb_domain: 'WORKGROUP', schedule: '0 2 * * *', retention: '7' });
        setToast({ message: 'Backup location reset', type: 'success' });
        fetchStorage();
      }
    } catch { setToast({ message: 'Failed to reset', type: 'error' }); }
  };

  return (
    <div>
      <div className="panel">
        <div className="panel-header">
          <span>Borg Configuration</span>
          {storageConfigured && (
            <button className="btn danger" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setShowResetConfirm(true)}>Reset Backup Location</button>
          )}
        </div>
        <div className="panel-body">
          {!storage ? <div className="empty">Loading...</div> :
           !storageConfigured ? (
            <div style={{ maxWidth: 480 }}>
              <p style={{ marginBottom: 14, color: 'var(--text-muted)', fontSize: 13 }}>Configure where Borg backups are stored. Settings apply to all cluster nodes.</p>
              <div className="form-group">
                <label>Storage Type</label>
                <select value={storageForm.type} onChange={e => setStorageForm({ ...storageForm, type: e.target.value })}>
                  <option value="nfs">NFS Share</option>
                  <option value="smb">SMB/CIFS Share</option>
                </select>
              </div>
              {storageForm.type === 'nfs' && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Server</label>
                    <input type="text" placeholder="e.g. 10.0.0.50" value={storageForm.nfs_server}
                      onChange={e => {
                        setStorageForm({ ...storageForm, nfs_server: e.target.value, nfs_path: '' });
                        setNfsExports([]);
                        nfsScannedRef.current = '';
                      }}
                      onBlur={e => scanNfsExports(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Export Path</label>
                    {nfsExports.length > 0 ? (
                      <select value={storageForm.nfs_path} onChange={e => setStorageForm({ ...storageForm, nfs_path: e.target.value })}>
                        <option value="">Select export...</option>
                        {nfsExports.map(exp => (
                          <option key={exp.path} value={exp.path}>{exp.path}</option>
                        ))}
                      </select>
                    ) : (
                      <input type="text" value={storageForm.nfs_path}
                        placeholder={nfsExportsLoading ? 'Scanning...' : '/export/path'}
                        onChange={e => setStorageForm({ ...storageForm, nfs_path: e.target.value })} />
                    )}
                  </div>
                </div>
              )}
              {storageForm.type === 'smb' && (
                <>
                  <div className="form-group">
                    <label>SMB Share</label>
                    <input type="text" placeholder="e.g. //10.0.0.50/backups" value={storageForm.smb_share} onChange={e => setStorageForm({ ...storageForm, smb_share: e.target.value })} />
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Username</label>
                      <input type="text" placeholder="e.g. backupuser" value={storageForm.smb_user} onChange={e => setStorageForm({ ...storageForm, smb_user: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label>Password</label>
                      <input type="password" placeholder="••••••••" value={storageForm.smb_pass} onChange={e => setStorageForm({ ...storageForm, smb_pass: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Domain</label>
                    <input type="text" placeholder="WORKGROUP" value={storageForm.smb_domain} onChange={e => setStorageForm({ ...storageForm, smb_domain: e.target.value })} />
                  </div>
                </>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>Backup Schedule (cron)</label>
                  <input type="text" placeholder="0 2 * * *" value={storageForm.schedule} onChange={e => setStorageForm({ ...storageForm, schedule: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Retention (days)</label>
                  <input type="number" min="1" value={storageForm.retention} onChange={e => setStorageForm({ ...storageForm, retention: e.target.value })} />
                </div>
              </div>
              <button className="btn primary" onClick={configureStorage} style={{ marginTop: 8 }}>Submit Backup Location</button>
            </div>
          ) : (
            <table className="kv-table">
              <tbody>
                <tr>
                  <td>Status</td>
                  <td>
                    <div className="storage-status">
                      <span className={`storage-dot ${storage.mounted ? 'mounted' : 'unmounted'}`}></span>
                      {storage.mounted ? 'Mounted' : 'Not Mounted'}
                      {!storage.mounted && storage.type === 'smb' && (
                        <button className="btn" onClick={async () => {
                          try {
                            const r = await fetch('/api/storage/mount', { method: 'POST' });
                            const d = await r.json();
                            if (r.ok) { setToast({ message: d.message || 'Mount successful', type: 'success' }); fetchStorage(); }
                            else { setToast({ message: d.error || 'Mount failed', type: 'error' }); }
                          } catch { setToast({ message: 'Mount request failed', type: 'error' }); }
                        }} style={{ marginLeft: 8, padding: '2px 8px', fontSize: 10 }}>
                          Mount
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                <tr><td>Type</td><td>{storage.type === 'nfs' ? 'NFS Share' : 'SMB/CIFS Share'}</td></tr>
                {storage.type === 'smb' ? (
                  <>
                    <tr><td>Share</td><td>{storage.smb_share}</td></tr>
                    <tr><td>User</td><td>{storage.smb_user || '\u2014'}</td></tr>
                  </>
                ) : (
                  <tr><td>Location</td><td>{storage.nfs_server}:{storage.nfs_path}</td></tr>
                )}
                <tr><td>Repository</td><td>/mnt/pg-backup/borg-repo</td></tr>
                <tr><td>Schedule</td><td>{storage.schedule}</td></tr>
                <tr><td>Retention</td><td>{storage.retention} days</td></tr>
              </tbody>
            </table>
          )}
        </div>
      </div>

      {storageConfigured && (
        <div className="panel">
          <div className="panel-header">
            <span>Backup Archives</span>
            <button className="btn primary" onClick={createBackup} disabled={backupRunning || !storage.mounted}>
              {backupRunning ? 'Running...' : 'Create Backup'}
            </button>
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            {loading ? <div className="empty">Loading...</div> :
             !storage.mounted ? <div className="empty">Waiting for storage to be mounted...</div> :
             !backups.available ? <div className="empty">{backups.error || 'Initializing Borg repository...'}</div> :
             backups.archives.length === 0 ? <div className="empty">No backups yet. Click "Create Backup" to create the first one.</div> : (
              <table>
                <thead><tr><th>Archive Name</th><th>Created</th><th>Actions</th></tr></thead>
                <tbody>
                  {backups.archives.map((a, i) => (
                    <tr key={i}>
                      <td><span className="backup-name">{a.name}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatDate(a.start)}</td>
                      <td style={{ display: 'flex', gap: 4 }}>
                        <button className="btn danger" onClick={() => setConfirmRestore(a.name)}>Restore</button>
                        <button className="btn" onClick={() => setConfirmDelete(a.name)} style={{ fontSize: 11 }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete Archive"
          message={`Permanently delete "${confirmDelete}" from the Borg repository? This cannot be undone.`}
          confirmText="Delete"
          confirmClass="danger"
          onConfirm={() => deleteArchive(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {showResetConfirm && (
        <ConfirmModal
          title="Reset Backup Location"
          message="This will disable backups and clear the storage configuration on all nodes. Existing backup archives on the remote storage will NOT be deleted. Are you sure?"
          confirmText="Reset"
          confirmClass="danger"
          onConfirm={resetStorage}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      {confirmRestore && (
        <ConfirmModal
          title="Restore Backup"
          message={`WARNING: This will DROP and recreate all databases on the live production cluster. A pre-restore safety backup will be created automatically.\n\nArchive: ${confirmRestore}\n\nAre you absolutely sure?`}
          confirmText="Restore"
          confirmClass="danger"
          onConfirm={() => restoreBackup(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}

      {taskViewer && (
        <TaskViewer
          title={taskViewer.title}
          statusUrl={taskViewer.statusUrl}
          onClose={closeTaskViewer}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
