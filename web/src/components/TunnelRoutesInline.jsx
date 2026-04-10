import React, { useState, useCallback, useEffect } from 'react';
import Badge from './Badge';
import Toast from './Toast';
import ConfirmModal from './ConfirmModal';

export default function TunnelRoutesInline() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editRoute, setEditRoute] = useState(null);
  const [form, setForm] = useState({ tunnel_id: '', hostname: '', service: '' });
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchRoutes = useCallback(async () => {
    try {
      const d = await fetch('/api/tunnel/routes').then(r => r.json());
      setData(d);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchRoutes(); }, [fetchRoutes]);

  const defaultService = 'tcp://VIP:5432';

  const openAdd = (tunnelId) => {
    setEditRoute(null);
    setForm({ tunnel_id: tunnelId, hostname: '', service: defaultService });
    setShowForm(true);
  };

  const openEdit = (tunnelId, route) => {
    setEditRoute(route.hostname);
    setForm({ tunnel_id: tunnelId, hostname: route.hostname, service: route.service });
    setShowForm(true);
  };

  const saveRoute = async () => {
    if (!form.hostname || !form.service) return setToast({ message: 'Hostname and service are required', type: 'error' });
    setSaving(true);
    try {
      const isEdit = editRoute != null;
      const url = isEdit ? `/api/tunnel/routes/${encodeURIComponent(editRoute)}` : '/api/tunnel/routes';
      const resp = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const d = await resp.json();
      if (resp.ok) {
        setToast({ message: d.message, type: 'ok' });
        setShowForm(false);
        fetchRoutes();
      } else {
        setToast({ message: d.error, type: 'error' });
      }
    } catch { setToast({ message: 'Request failed', type: 'error' }); }
    setSaving(false);
  };

  const deleteRoute = async (tunnelId, hostname) => {
    setConfirmDelete(null);
    try {
      const resp = await fetch(`/api/tunnel/routes/${encodeURIComponent(hostname)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnel_id: tunnelId })
      });
      const d = await resp.json();
      if (resp.ok) { setToast({ message: d.message, type: 'ok' }); fetchRoutes(); }
      else setToast({ message: d.error, type: 'error' });
    } catch { setToast({ message: 'Delete failed', type: 'error' }); }
  };

  if (loading) return <div style={{ color: 'var(--text-muted)', padding: '8px 0' }}>Loading routes...</div>;
  if (!data?.available) return null;

  const tunnels = data.tunnels || [];
  if (tunnels.length === 0) return null;

  return (
    <div>
      {tunnels.map(tunnel => (
        <div key={tunnel.id} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
              Public Hostnames
              <span style={{ marginLeft: 8 }}>
                {tunnel.status === 'healthy' ? <Badge type="ok" text="Healthy" /> : tunnel.status === 'inactive' ? <Badge type="warn" text="Inactive" /> : <Badge type="info" text={tunnel.status || 'Unknown'} />}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 8, fontWeight: 400 }}>{tunnel.name} &middot; {tunnel.connectors} connector{tunnel.connectors !== 1 ? 's' : ''}</span>
            </div>
            <button className="btn primary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => openAdd(tunnel.id)}>+ Add Route</button>
          </div>
          <table className="data-table" style={{ borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Service</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {(tunnel.routes || []).map(route => (
                <tr key={route.hostname}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{route.hostname}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{route.service}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => openEdit(tunnel.id, route)}>Edit</button>
                      <button className="btn" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--err)' }} onClick={() => setConfirmDelete({ tunnelId: tunnel.id, hostname: route.hostname })}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {(tunnel.routes || []).length === 0 && (
                <tr><td colSpan="3" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 16 }}>No public hostname routes configured</td></tr>
              )}
              <tr style={{ opacity: 0.5 }}>
                <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>* (catch-all)</td>
                <td style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>{tunnel.catch_all}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h3>{editRoute ? 'Edit Route' : 'Add Route'}</h3>
            <div style={{ marginTop: 12 }}>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label>Public Hostname</label>
                <input type="text" value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))}
                  placeholder="db.example.com" disabled={!!editRoute} />
              </div>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label>Service</label>
                <input type="text" value={form.service} onChange={e => setForm(f => ({ ...f, service: e.target.value }))}
                  placeholder="tcp://192.168.11.10:5432" />
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5 }}>
                For PostgreSQL access: <code>tcp://VIP:5432</code>. For HTTP services: <code>http://localhost:PORT</code>.
              </p>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn primary" onClick={saveRoute} disabled={saving}>{saving ? 'Saving...' : editRoute ? 'Update' : 'Add'}</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete Route"
          message={`Remove the public hostname route for ${confirmDelete.hostname}? This will disconnect any services using this route.`}
          confirmText="Delete"
          confirmClass="danger"
          onConfirm={() => deleteRoute(confirmDelete.tunnelId, confirmDelete.hostname)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
