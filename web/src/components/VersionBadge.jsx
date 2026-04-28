import React, { useState, useEffect, useRef } from 'react';
import TaskViewer from './TaskViewer';

export default function VersionBadge() {
  const [ver, setVer] = useState({ current: null, latest: null, update_available: false, checking: false, nodes: [], all_nodes_match: true });
  const [taskViewer, setTaskViewer] = useState(null);
  const [showNodes, setShowNodes] = useState(false);
  const checkAbort = useRef(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/version', { signal: ctrl.signal }).then(r => r.json()).then(d => setVer(v => ({ ...v, current: d.version }))).catch(() => {});
    return () => ctrl.abort();
  }, []);

  const checkForUpdates = async () => {
    if (checkAbort.current) checkAbort.current.abort();
    checkAbort.current = new AbortController();
    setVer(v => ({ ...v, checking: true, error: null }));
    try {
      const data = await fetch('/api/version/check', { signal: checkAbort.current.signal }).then(r => r.json());
      setVer({ current: data.current, latest: data.latest, update_available: data.update_available, checking: false, nodes: data.nodes || [], all_nodes_match: data.all_nodes_match !== false, error: data.error || null });
    } catch (e) {
      if (e.name !== 'AbortError') setVer(v => ({ ...v, checking: false, error: e.message }));
    }
  };

  const startUpgrade = async () => {
    try {
      const resp = await fetch('/api/version/upgrade', { method: 'POST' });
      if (resp.ok) {
        setTaskViewer({ title: `Upgrading cluster to ${ver.latest}`, statusUrl: '/api/version/upgrade/status' });
      }
    } catch {}
  };

  const statusText = () => {
    if (ver.checking) return 'Checking...';
    if (ver.error && !ver.latest) return 'Check for updates';
    if (ver.latest && !ver.update_available) return 'Up to date ✓';
    return 'Check for updates';
  };

  const statusColor = () => {
    if (!ver.latest || ver.update_available) return undefined;
    return ver.all_nodes_match ? 'var(--ok)' : 'var(--warn)';
  };

  return (
    <>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {ver.current && <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400 }}>v{ver.current}</span>}
        {ver.update_available ? (
          <button className="btn" onClick={startUpgrade}
            style={{ padding: '3px 10px', fontSize: 11, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff', animation: 'none' }}>
            Upgrade to v{ver.latest}
          </button>
        ) : (
          <button className="btn" onClick={checkForUpdates} disabled={ver.checking}
            onMouseEnter={() => ver.nodes.length > 0 && setShowNodes(true)}
            onMouseLeave={() => setShowNodes(false)}
            style={{ padding: '3px 10px', fontSize: 11, borderColor: statusColor() || undefined, color: statusColor() || undefined }}>
            {statusText()}
          </button>
        )}
        {ver.error && ver.latest && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
            (cached)
          </span>
        )}
        {ver.error && !ver.latest && (
          <span style={{ fontSize: 11, color: 'var(--warn)', marginLeft: 6 }}>
            {ver.error}
          </span>
        )}
        {showNodes && ver.nodes.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, zIndex: 100, minWidth: 200, fontSize: 11, boxShadow: '0 4px 12px var(--shadow)' }}>
            {ver.nodes.map(n => (
              <div key={n.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', gap: 12 }}>
                <span style={{ color: 'var(--text-bright)' }}>{n.name}</span>
                <span style={{ color: n.version === ver.current ? 'var(--ok)' : 'var(--warn)', fontFamily: 'monospace' }}>v{n.version}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {taskViewer && (
        <TaskViewer title={taskViewer.title} statusUrl={taskViewer.statusUrl} autoReload
          onClose={() => { setTaskViewer(null); window.location.reload(); }} />
      )}
    </>
  );
}
