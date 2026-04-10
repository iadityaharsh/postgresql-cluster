import React, { useState, useCallback, useEffect } from 'react';
import Badge from './Badge';
import Toast from './Toast';
import ConfirmModal from './ConfirmModal';
import TaskViewer from './TaskViewer';
import TunnelRoutesInline from './TunnelRoutesInline';
import HyperdriveSection from './HyperdriveSection';

const THEMES = [
  { id: 'dark', name: 'Dark', colors: ['#1a1a2e', '#1e1e32', '#2d2d44', '#f97316'] },
  { id: 'light', name: 'Light', colors: ['#f0f0f5', '#ffffff', '#e8e8f0', '#ea580c'] },
  { id: 'nord-dark', name: 'Nord Dark', colors: ['#2e3440', '#3b4252', '#434c5e', '#d08770'] },
  { id: 'nord-light', name: 'Nord Light', colors: ['#eceff4', '#ffffff', '#e5e9f0', '#c06840'] },
];

export default function SettingsTab() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [toast, setToast] = useState(null);
  const [tunnel, setTunnel] = useState(null);
  const [tunnelName, setTunnelName] = useState('');
  const [taskViewer, setTaskViewer] = useState(null);
  const [cfAuth, setCfAuth] = useState({ account_id: '', api_token: '' });
  const [cfStatus, setCfStatus] = useState(null);
  const [savingAuth, setSavingAuth] = useState(false);
  const [tunnelOpen, setTunnelOpen] = useState(() => localStorage.getItem('panel_tunnel') === 'open');
  const [hyperdriveOpen, setHyperdriveOpen] = useState(() => localStorage.getItem('panel_hyperdrive') === 'open');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const togglePanel = (panel, open, setter) => {
    const next = !open;
    setter(next);
    localStorage.setItem(`panel_${panel}`, next ? 'open' : 'closed');
  };

  const fetchCfStatus = useCallback(async () => {
    try {
      const d = await fetch('/api/cloudflare-auth').then(r => r.json());
      setCfStatus(d);
    } catch {}
  }, []);

  const saveCfAuth = async () => {
    if (!cfAuth.api_token || !cfAuth.account_id) return setToast({ message: 'Both Account ID and API Token are required', type: 'error' });
    setSavingAuth(true);
    try {
      const resp = await fetch('/api/cloudflare-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfAuth)
      });
      const d = await resp.json();
      if (resp.ok) { setToast({ message: 'Credentials saved', type: 'ok' }); setTimeout(fetchCfStatus, 500); }
      else setToast({ message: d.error, type: 'error' });
    } catch { setToast({ message: 'Failed to save credentials', type: 'error' }); }
    setSavingAuth(false);
  };

  const resetCfAuth = async () => {
    try {
      const resp = await fetch('/api/cloudflare-auth', { method: 'DELETE' });
      const d = await resp.json();
      if (resp.ok) { setToast({ message: 'Credentials cleared', type: 'ok' }); setCfAuth({ account_id: '', api_token: '' }); setCfStatus({ available: false }); }
      else setToast({ message: d.error, type: 'error' });
    } catch { setToast({ message: 'Failed to reset credentials', type: 'error' }); }
  };

  const applyTheme = (id) => {
    document.documentElement.setAttribute('data-theme', id);
    localStorage.setItem('theme', id);
    setTheme(id);
  };

  const exportConfig = () => {
    window.open('/api/config/export', '_blank');
  };

  const exportPatroniConfig = async () => {
    try {
      const data = await fetch('/api/config/patroni').then(r => r.json());
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `patroni-config-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setToast({ message: 'Failed to export Patroni config', type: 'error' }); }
  };

  const fetchTunnel = useCallback(async () => {
    try {
      const data = await fetch('/api/tunnel').then(r => r.json());
      setTunnel(data);
    } catch {}
  }, []);

  useEffect(() => { fetchCfStatus(); fetchTunnel(); }, [fetchCfStatus, fetchTunnel]);

  const createTunnel = async () => {
    if (!tunnelName.trim()) return setToast({ message: 'Enter a tunnel name', type: 'error' });
    try {
      const resp = await fetch('/api/tunnel/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tunnelName.trim() })
      });
      const data = await resp.json();
      if (resp.ok) {
        setTaskViewer({ title: 'Creating Tunnel — All Nodes', statusUrl: '/api/tunnel/status' });
      } else {
        setToast({ message: data.error, type: 'error' });
      }
    } catch { setToast({ message: 'Failed to create tunnel', type: 'error' }); }
  };

  const closeTasks = () => { setTaskViewer(null); fetchTunnel(); };

  const restartCluster = async () => {
    setConfirmRestart(false);
    setRestarting(true);
    setTaskViewer({ title: 'Restarting All Nodes', statusUrl: '/api/restart/status' });
    try {
      const resp = await fetch('/api/restart', { method: 'POST' });
      if (!resp.ok) {
        const d = await resp.json();
        setToast({ message: d.error || 'Restart failed', type: 'error' });
        setRestarting(false);
      }
    } catch {
      setToast({ message: 'Failed to initiate restart', type: 'error' });
      setRestarting(false);
    }
  };

  const closeRestartTask = () => {
    setTaskViewer(null);
    setRestarting(false);
    setTimeout(() => window.location.reload(), 3000);
  };

  const tunnelNodes = tunnel?.nodes || [];
  const cfConnected = cfStatus?.available === true;

  return (
    <div>
      <div className="panel">
        <div className="panel-header">
          <span>Cloudflare Account Credentials</span>
        </div>
        <div className="panel-body">
          {!cfStatus && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Checking credentials...</div>
          )}
          {cfStatus && !cfConnected && (
            <div>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>
                Required to manage Cloudflare Tunnels and Hyperdrive configs. Account ID is on your <strong>Cloudflare Dashboard</strong> sidebar or in the URL. API token needs <em>Hyperdrive</em> and <em>Cloudflare Tunnel</em> permissions.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1, minWidth: 160, marginBottom: 0 }}>
                  <label>Account ID</label>
                  <input type="text" placeholder="From Cloudflare dashboard sidebar" value={cfAuth.account_id} onChange={e => setCfAuth(a => ({ ...a, account_id: e.target.value }))} />
                </div>
                <div className="form-group" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
                  <label>API Token</label>
                  <input type="password" placeholder="Cloudflare API token" value={cfAuth.api_token} onChange={e => setCfAuth(a => ({ ...a, api_token: e.target.value }))} />
                </div>
                <button className="btn primary" style={{ height: 32, fontSize: 12 }} onClick={saveCfAuth} disabled={savingAuth}>
                  {savingAuth ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          )}
          {cfConnected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 500 }}>{cfStatus.account_name || ('Account ID: ' + (cfStatus.account_id || ''))}</span>
              <Badge type="ok" text="Connected" />
              <button className="btn" style={{ padding: '3px 10px', fontSize: 11 }} onClick={resetCfAuth}>Reset Credentials</button>
            </div>
          )}
        </div>
      </div>

      {cfConnected && (
        <div className="panel">
          <div className="panel-header" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => togglePanel('tunnel', tunnelOpen, setTunnelOpen)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: tunnelOpen ? 'rotate(90deg)' : 'rotate(0deg)', fontSize: 10 }}>&#9654;</span>
              Cloudflare Tunnel
            </span>
            <a href="https://github.com/iadityaharsh/postgresql-cluster/blob/main/docs/remote-access.md" target="_blank" rel="noopener noreferrer"
               className="btn" style={{ padding: '3px 10px', fontSize: 11, textDecoration: 'none' }} onClick={e => e.stopPropagation()}>
              View Docs
            </a>
          </div>
          {tunnelOpen && (
            <div className="panel-body">
              <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Expose your PostgreSQL cluster securely using Cloudflare Tunnel.
                All cluster nodes are configured as tunnel connectors for HA.
              </div>
              {tunnelNodes.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <table className="data-table" style={{ borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>cloudflared</th>
                        <th>Service</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tunnelNodes.map(n => (
                        <tr key={n.name}>
                          <td style={{ fontWeight: 500 }}>{n.name}</td>
                          <td>{n.installed ? <><Badge type="ok" text="Installed" /> <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6 }}>v{n.version}</span></> : <Badge type="err" text="Not Installed" />}</td>
                          <td>{n.running ? <Badge type="ok" text="Running" /> : n.installed ? <Badge type="warn" text="Stopped" /> : <Badge type="err" text="N/A" />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!tunnel?.configured && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Tunnel Name</label>
                      <input type="text" placeholder="e.g. pg-cluster-tunnel" value={tunnelName} onChange={e => setTunnelName(e.target.value)} />
                    </div>
                    <button className="btn primary" style={{ height: 32 }} onClick={createTunnel}>Create Tunnel</button>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.5 }}>
                    Creates a Cloudflare Tunnel via API and deploys the connector to all cluster nodes.
                  </p>
                </div>
              )}
              <TunnelRoutesInline />
            </div>
          )}
        </div>
      )}

      {cfConnected && <HyperdriveSection collapsed={!hyperdriveOpen} onToggle={() => togglePanel('hyperdrive', hyperdriveOpen, setHyperdriveOpen)} />}

      <div className="panel">
        <div className="panel-header"><span>Appearance</span></div>
        <div className="panel-body">
          <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>Select a theme for the dashboard. Your preference is saved in the browser.</div>
          <div className="theme-grid">
            {THEMES.map(t => (
              <div key={t.id} className={`theme-card ${theme === t.id ? 'active' : ''}`} onClick={() => applyTheme(t.id)}>
                <div className="theme-card-preview">
                  {t.colors.map((c, i) => <div key={i} style={{ background: c }} />)}
                </div>
                <div className="theme-card-label">{t.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>Configuration Backup</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Download cluster configuration. Sensitive fields are redacted.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={exportConfig}>Export cluster.conf</button>
            <button className="btn" onClick={exportPatroniConfig}>Export Patroni Config</button>
          </div>
        </div>
        <div style={{ width: 1, background: 'var(--border-subtle)', alignSelf: 'stretch' }} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>Restart Cluster</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            Restart all services on every node. The page will reload automatically.
          </div>
          <button className="btn" style={{ border: '1px solid var(--err)', color: 'var(--err)', fontWeight: 600 }} onClick={() => setConfirmRestart(true)} disabled={restarting}>
            {restarting ? 'Restarting...' : 'Restart All Nodes'}
          </button>
        </div>
      </div>

      {confirmRestart && (
        <ConfirmModal
          title="Restart All Nodes"
          message="This will restart etcd, Patroni, vip-manager, and cloudflared on every node, then restart the dashboard. There will be brief downtime. Continue?"
          confirmText="Restart"
          confirmClass="danger"
          onConfirm={restartCluster}
          onCancel={() => setConfirmRestart(false)}
        />
      )}

      {taskViewer && <TaskViewer title={taskViewer.title} statusUrl={taskViewer.statusUrl} onClose={restarting ? closeRestartTask : closeTasks} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
