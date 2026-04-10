import React, { useState, useCallback, useEffect } from 'react';
import Badge from './Badge';
import Toast from './Toast';
import ConfirmModal from './ConfirmModal';
import TaskViewer from './TaskViewer';

export default function HyperdriveSection({ collapsed, onToggle }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [taskViewer, setTaskViewer] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formDb, setFormDb] = useState('');
  const [form, setForm] = useState({ username: '', password: '', hostname: '', hyperdrive_name: '', access_client_id: '', access_client_secret: '' });
  const [creatingUser, setCreatingUser] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [updateKey, setUpdateKey] = useState(null);
  const [updatePassword, setUpdatePassword] = useState('');
  const [detailKey, setDetailKey] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [tunnelRoutes, setTunnelRoutes] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      const [d, routes] = await Promise.all([
        fetch('/api/hyperdrive').then(r => r.json()),
        fetch('/api/tunnel/routes').then(r => r.json()).catch(() => ({ tunnels: [] }))
      ]);
      setData(d);
      const allRoutes = [];
      (routes.tunnels || []).forEach(t => {
        (t.routes || []).forEach(r => allRoutes.push(r.hostname));
      });
      setTunnelRoutes(allRoutes);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const generatePassword = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let pw = '';
    for (let i = 0; i < 32; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    setForm(f => ({ ...f, password: pw }));
  };

  const openSetup = (db) => {
    setFormDb(db);
    setForm({ username: `${db}_cf`, password: '', hostname: '', hyperdrive_name: '', access_client_id: '', access_client_secret: '' });
    generatePassword();
    setShowForm(true);
  };

  const createUser = async () => {
    if (!form.username || !form.password) return setToast({ message: 'Username and password required', type: 'error' });
    setCreatingUser(true);
    try {
      const resp = await fetch('/api/hyperdrive/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: formDb, username: form.username, password: form.password })
      });
      const d = await resp.json();
      if (resp.ok) setToast({ message: d.message, type: 'ok' });
      else setToast({ message: d.error, type: 'error' });
    } catch { setToast({ message: 'Failed to create user', type: 'error' }); }
    setCreatingUser(false);
  };

  const createHyperdrive = async () => {
    if (!form.hostname || !form.access_client_id || !form.access_client_secret) {
      return setToast({ message: 'Hostname, Access Client ID, and Secret are required', type: 'error' });
    }
    if (!form.username || !form.password) {
      return setToast({ message: 'Create the DB user first', type: 'error' });
    }
    try {
      const resp = await fetch('/api/hyperdrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          database: formDb,
          username: form.username,
          password: form.password,
          hostname: form.hostname,
          hyperdrive_name: form.hyperdrive_name || undefined,
          access_client_id: form.access_client_id,
          access_client_secret: form.access_client_secret
        })
      });
      const d = await resp.json();
      if (resp.ok) {
        setTaskViewer({ title: `Hyperdrive — ${formDb}`, statusUrl: '/api/hyperdrive/status' });
        setShowForm(false);
      } else {
        setToast({ message: d.error, type: 'error' });
      }
    } catch { setToast({ message: 'Failed to create Hyperdrive', type: 'error' }); }
  };

  const deleteConfig = async (key) => {
    setConfirmDelete(null);
    try {
      const resp = await fetch(`/api/hyperdrive/${encodeURIComponent(key)}`, { method: 'DELETE' });
      const d = await resp.json();
      setToast({ message: d.message || 'Deleted', type: 'ok' });
      fetchData();
    } catch { setToast({ message: 'Delete failed', type: 'error' }); }
  };

  const updateConfig = async (key) => {
    if (!updatePassword) return;
    try {
      const resp = await fetch(`/api/hyperdrive/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: updatePassword })
      });
      const d = await resp.json();
      if (resp.ok) { setToast({ message: 'Password updated', type: 'ok' }); setUpdateKey(null); setUpdatePassword(''); }
      else setToast({ message: d.error, type: 'error' });
    } catch { setToast({ message: 'Update failed', type: 'error' }); }
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const closeTasks = () => { setTaskViewer(null); fetchData(); };

  if (loading) return (
    <div className="panel">
      <div className="panel-header"><span>Cloudflare Hyperdrive</span></div>
      <div className="panel-body" style={{ color: 'var(--text-muted)' }}>Loading...</div>
    </div>
  );

  const entries = data?.entries || [];
  const configured = entries.filter(e => e.configured);

  return (
    <div>
      <div className="panel">
        <div className="panel-header" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={onToggle}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', fontSize: 10 }}>&#9654;</span>
            Cloudflare Hyperdrive
          </span>
          <a href="https://github.com/iadityaharsh/postgresql-cluster/blob/main/docs/hyperdrive.md" target="_blank" rel="noopener noreferrer"
             className="btn" style={{ padding: '3px 10px', fontSize: 11, textDecoration: 'none' }} onClick={e => e.stopPropagation()}>
            View Docs
          </a>
        </div>
        {!collapsed && <div className="panel-body">
          <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Connect Cloudflare Workers to your databases via Hyperdrive — edge connection pooling, query caching, and regional routing.
            {!data?.wrangler_installed && <span style={{ color: 'var(--warn)', display: 'block', marginTop: 4 }}>Wrangler CLI not detected. Install with: npm install -g wrangler</span>}
          </div>

          <table className="data-table" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Database</th>
                <th>Domain</th>
                <th>Hyperdrive</th>
                <th>Status</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const cfg = entry.config;
                const key = cfg ? `${cfg.database}-${cfg.username}` : null;
                const isPostgres = entry.database === 'postgres';
                const postgresDisabled = isPostgres && !data?.postgres_hyperdrive;
                return (
                  <tr key={entry.database} style={postgresDisabled && !cfg ? { opacity: 0.5 } : undefined}>
                    <td style={{ fontWeight: 500 }}>{entry.database}{entry.missing && <span style={{ color: 'var(--warn)', fontSize: 10, marginLeft: 6 }}>dropped?</span>}</td>
                    <td style={{ fontSize: 12, color: cfg?.hostname ? 'var(--text)' : 'var(--text-dim)' }}>{cfg?.hostname || '\u2014'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11, color: cfg?.hyperdrive_id ? 'var(--text)' : 'var(--text-dim)' }}>
                      {cfg?.hyperdrive_id ? (
                        <span style={{ cursor: 'pointer' }} title="Click to copy" onClick={() => copyToClipboard(cfg.hyperdrive_id, cfg.hyperdrive_id)}>
                          {copiedId === cfg.hyperdrive_id ? 'Copied!' : cfg.hyperdrive_id.slice(0, 12) + '...'}
                        </span>
                      ) : '\u2014'}
                    </td>
                    <td>{cfg ? <Badge type="ok" text="Connected" /> : postgresDisabled ? <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Disabled</span> : <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Not configured</span>}</td>
                    <td>
                      {cfg ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setDetailKey(key)}>Details</button>
                          <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { setUpdateKey(key); setUpdatePassword(''); }}>Edit</button>
                          <button className="btn" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--err)' }} onClick={() => setConfirmDelete(key)}>Delete</button>
                        </div>
                      ) : postgresDisabled ? (
                        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{'\u2014'}</span>
                      ) : (
                        <button className="btn primary" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => openSetup(entry.database)}>Setup</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {entries.length === 0 && (
                <tr><td colSpan="5" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>No databases found</td></tr>
              )}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            The <strong>postgres</strong> database is disabled for Hyperdrive by default for security reasons. To enable it, add <code style={{ background: 'var(--bg-base)', padding: '1px 5px', borderRadius: 3, fontSize: 10 }}>POSTGRES_HYPERDRIVE="ON"</code> to <code style={{ background: 'var(--bg-base)', padding: '1px 5px', borderRadius: 3, fontSize: 10 }}>cluster.conf</code> on each node and restart the dashboard.
          </div>
        </div>}
      </div>

      {/* Connection Details modal */}
      {detailKey && (() => {
        const detailCfg = entries.find(e => e.config && `${e.config.database}-${e.config.username}` === detailKey)?.config;
        if (!detailCfg) return null;
        const snippet = `{\n  "hyperdrive": [\n    {\n      "binding": "HYPERDRIVE",\n      "id": "${detailCfg.hyperdrive_id || 'YOUR_HYPERDRIVE_ID'}"\n    }\n  ]\n}`;
        return (
          <div className="modal-overlay" onClick={() => setDetailKey(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>Connection Details — {detailCfg.database}</h3>
                <Badge type="ok" text="Connected" />
              </div>
              <table className="kv-table" style={{ marginTop: 14, marginBottom: 16 }}>
                <tbody>
                  <tr><td>Hostname</td><td>{detailCfg.hostname}</td></tr>
                  <tr><td>Database</td><td>{detailCfg.database}</td></tr>
                  <tr><td>User</td><td>{detailCfg.username}</td></tr>
                  <tr><td>Hyperdrive Name</td><td>{detailCfg.hyperdrive_name || '\u2014'}</td></tr>
                  <tr>
                    <td>Hyperdrive ID</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {detailCfg.hyperdrive_id || 'N/A'}
                      {detailCfg.hyperdrive_id && (
                        <button className="btn" style={{ marginLeft: 8, padding: '1px 6px', fontSize: 10 }}
                          onClick={() => copyToClipboard(detailCfg.hyperdrive_id, detailKey + '-detail-id')}>
                          {copiedId === detailKey + '-detail-id' ? 'Copied!' : 'Copy'}
                        </button>
                      )}
                    </td>
                  </tr>
                  <tr><td>Created</td><td>{detailCfg.created ? new Date(detailCfg.created).toLocaleDateString() : 'N/A'}</td></tr>
                </tbody>
              </table>
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>wrangler.jsonc snippet:</div>
                <pre style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '8px 10px', fontSize: 11, color: 'var(--text)', overflow: 'auto', maxHeight: 120, margin: 0 }}>{snippet}</pre>
                <button className="btn" style={{ position: 'absolute', top: 0, right: 0, padding: '2px 8px', fontSize: 10 }}
                  onClick={() => copyToClipboard(snippet, detailKey + '-detail-snippet')}>
                  {copiedId === detailKey + '-detail-snippet' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="modal-actions" style={{ marginTop: 16 }}>
                <button className="btn" onClick={() => setDetailKey(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Setup form modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h3>Setup Hyperdrive — {formDb}</h3>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>1. Database User</div>
              <div className="form-group" style={{ marginBottom: 6 }}>
                <label>Username</label>
                <input type="text" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="cf_mydb" />
              </div>
              <div className="form-group" style={{ marginBottom: 6 }}>
                <label>Password</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }} />
                  <button className="btn" style={{ padding: '4px 10px', fontSize: 11 }} onClick={generatePassword}>Generate</button>
                </div>
              </div>
              <button className="btn primary" style={{ fontSize: 12, marginBottom: 16 }} onClick={createUser} disabled={creatingUser}>
                {creatingUser ? 'Creating...' : 'Create DB User'}
              </button>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>2. Hyperdrive Config</div>
              <div className="form-group" style={{ marginBottom: 6 }}>
                <label>Tunnel Hostname</label>
                {(() => {
                  const usedHostnames = configured.map(e => e.config?.hostname).filter(Boolean);
                  const available = tunnelRoutes.filter(h => !usedHostnames.includes(h));
                  return available.length > 0 ? (
                    <select value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))} style={{ width: '100%' }}>
                      <option value="">Select a tunnel hostname</option>
                      {available.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))} placeholder="No unused tunnel routes — enter manually" />
                  );
                })()}
              </div>
              <div className="form-group" style={{ marginBottom: 6 }}>
                <label>Hyperdrive Name (optional)</label>
                <input type="text" value={form.hyperdrive_name} onChange={e => setForm(f => ({ ...f, hyperdrive_name: e.target.value }))} placeholder={`${formDb}-hyperdrive`} />
              </div>
              <div className="form-group" style={{ marginBottom: 6 }}>
                <label>Access Client ID</label>
                <input type="text" value={form.access_client_id} onChange={e => setForm(f => ({ ...f, access_client_id: e.target.value }))} placeholder="xxxxxxxx.access" />
              </div>
              <div className="form-group" style={{ marginBottom: 6 }}>
                <label>Access Client Secret</label>
                <input type="password" value={form.access_client_secret} onChange={e => setForm(f => ({ ...f, access_client_secret: e.target.value }))} />
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>
                Create a Service Token at <strong>Zero Trust &gt; Access controls &gt; Service credentials</strong>. The tunnel hostname must point to <strong>tcp://VIP:5432</strong>.
              </p>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn primary" onClick={createHyperdrive}>Create Hyperdrive</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit config modal */}
      {updateKey && (() => {
        const editCfg = entries.find(e => e.config && `${e.config.database}-${e.config.username}` === updateKey)?.config;
        if (!editCfg) return null;
        const snippet = `{\n  "hyperdrive": [\n    {\n      "binding": "HYPERDRIVE",\n      "id": "${editCfg.hyperdrive_id || 'YOUR_HYPERDRIVE_ID'}"\n    }\n  ]\n}`;
        return (
          <div className="modal-overlay" onClick={() => setUpdateKey(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <h3>Edit — {editCfg.database}</h3>
              <table className="kv-table" style={{ marginTop: 12, marginBottom: 16 }}>
                <tbody>
                  <tr><td>Database</td><td>{editCfg.database}</td></tr>
                  <tr><td>Hostname</td><td>{editCfg.hostname}</td></tr>
                  <tr><td>User</td><td>{editCfg.username}</td></tr>
                  <tr><td>Hyperdrive Name</td><td>{editCfg.hyperdrive_name || '\u2014'}</td></tr>
                  <tr>
                    <td>Hyperdrive ID</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                      {editCfg.hyperdrive_id || 'N/A'}
                      {editCfg.hyperdrive_id && (
                        <button className="btn" style={{ marginLeft: 8, padding: '1px 6px', fontSize: 10 }}
                          onClick={() => copyToClipboard(editCfg.hyperdrive_id, updateKey + '-edit-id')}>
                          {copiedId === updateKey + '-edit-id' ? 'Copied!' : 'Copy'}
                        </button>
                      )}
                    </td>
                  </tr>
                  <tr><td>Created</td><td>{editCfg.created ? new Date(editCfg.created).toLocaleDateString() : 'N/A'}</td></tr>
                </tbody>
              </table>
              <div style={{ position: 'relative', marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>wrangler.jsonc snippet:</div>
                <pre style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '8px 10px', fontSize: 11, color: 'var(--text)', overflow: 'auto', maxHeight: 120, margin: 0 }}>{snippet}</pre>
                <button className="btn" style={{ position: 'absolute', top: 0, right: 0, padding: '2px 8px', fontSize: 10 }}
                  onClick={() => copyToClipboard(snippet, updateKey + '-edit-snippet')}>
                  {copiedId === updateKey + '-edit-snippet' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>Update Origin Password</div>
                <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Change the origin password on Cloudflare's side. This does not update the database user password.
                </p>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label>New Password</label>
                  <input type="text" value={updatePassword} onChange={e => setUpdatePassword(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 11 }} placeholder="Leave empty to keep current" />
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setUpdateKey(null)}>Close</button>
                <button className="btn primary" onClick={() => updateConfig(updateKey)} disabled={!updatePassword}>Update Password</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmDelete && (
        <ConfirmModal
          title="Delete Hyperdrive Config"
          message="This will delete the Hyperdrive config from Cloudflare and remove the local configuration. This cannot be undone."
          confirmText="Delete"
          confirmClass="danger"
          onConfirm={() => deleteConfig(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {taskViewer && <TaskViewer title={taskViewer.title} statusUrl={taskViewer.statusUrl} onClose={closeTasks} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
