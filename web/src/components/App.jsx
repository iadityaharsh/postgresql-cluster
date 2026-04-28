import React, { useState, useEffect, useCallback, useRef } from 'react';
import PgLogo from './PgLogo';
import LoginScreen from './LoginScreen';

// Global fetch interceptor: adds CSRF token to all mutating API requests
const _origFetch = window.fetch;
window.fetch = (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && String(url).startsWith('/api/')) {
    const csrf = document.cookie.match(/pg_csrf=([^;]+)/)?.[1] || '';
    opts = { ...opts, headers: { ...opts.headers, 'X-CSRF-Token': csrf } };
  }
  return _origFetch(url, opts);
};
import VersionBadge from './VersionBadge';
import GithubStars from './GithubStars';
import SummaryTab from './SummaryTab';
import NodesTab from './NodesTab';
import SettingsTab from './SettingsTab';
import BackupsTab from './BackupsTab';
import NodeDetailTab from './NodeDetailTab';
import CreateDatabaseModal from './CreateDatabaseModal';
import DatabaseTab from './DatabaseTab';

export default function App() {
  const [authStatus, setAuthStatus] = useState(null);
  const [cluster, setCluster] = useState(null);
  const [databases, setDatabases] = useState([]);
  const [connections, setConnections] = useState(null);
  const [replication, setReplication] = useState([]);
  const [system, setSystem] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(false);
  const [view, setView] = useState({ type: 'cluster', tab: 'summary' });
  const [sidebarFilter, setSidebarFilter] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showCreateDb, setShowCreateDb] = useState(false);
  const [dbData, setDbData] = useState(null);
  const [dbError, setDbError] = useState(null);
  const [expanded, setExpanded] = useState({ cluster: true, databases: true });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('sidebarWidth')) || 240; } catch { return 240; }
  });
  const sidebarRef = useRef(null);
  const draggingRef = useRef(false);
  const viewRef = useRef(view);
  const fetchInFlight = useRef(false);
  useEffect(() => { viewRef.current = view; }, [view]);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!draggingRef.current) return;
      const newWidth = Math.min(500, Math.max(180, e.clientX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem('sidebarWidth', sidebarWidth); } catch {}
      }
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
  }, [sidebarWidth]);

  useEffect(() => {
    fetch('/api/auth/status').then(r => r.json()).then(setAuthStatus).catch(() => setAuthStatus({ auth_required: false, logged_in: true }));
  }, []);

  const fetchData = useCallback(async () => {
    if (fetchInFlight.current) return;
    if (document.visibilityState === 'hidden') return;
    fetchInFlight.current = true;
    try {
      const responses = await Promise.all([
        fetch('/api/cluster'), fetch('/api/databases'), fetch('/api/connections'),
        fetch('/api/replication'), fetch('/api/system')
      ]);
      // Detect session expiry — redirect to login on any 401
      if (responses.some(r => r.status === 401)) {
        setAuthStatus({ auth_required: true, logged_in: false });
        fetchInFlight.current = false;
        return;
      }
      const [c, d, conn, r, s] = await Promise.all(responses.map(r => r.json()));
      setCluster(c); setDatabases(d); setConnections(conn); setReplication(r); setSystem(s);
      if (viewRef.current.type === 'database' && viewRef.current.name) {
        const detail = await fetch(`/api/databases/${encodeURIComponent(viewRef.current.name)}`).then(r => r.json());
        if (!detail.error) setDbData(detail);
      }
      setLastUpdate(new Date());
      setError(false);
    } catch { setError(true); }
    finally { fetchInFlight.current = false; }
  }, []);

  useEffect(() => {
    if (authStatus && (!authStatus.auth_required || authStatus.logged_in)) {
      fetchData();
      const interval = setInterval(fetchData, 2000);
      return () => clearInterval(interval);
    }
  }, [fetchData, authStatus]);

  useEffect(() => {
    if (view.type !== 'database') return;
    setDbData(null);
    setDbError(null);
    let cancelled = false;
    fetch(`/api/databases/${encodeURIComponent(view.name)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) setDbError(data.error);
        else setDbData(data);
      })
      .catch(e => { if (!cancelled) setDbError(e.message); });
    return () => { cancelled = true; };
  }, [view.type, view.name]);

  if (!authStatus) return null;
  if (authStatus.auth_required && !authStatus.logged_in) {
    return <LoginScreen onLogin={() => setAuthStatus({ ...authStatus, logged_in: true })} />;
  }

  const nodes = cluster?.nodes || [];
  const nodesUp = nodes.filter(n => n.patroni?.state === 'running').length;
  const leader = nodes.find(n => n.patroni?.role === 'master' || n.patroni?.role === 'primary');
  const healthy = nodesUp === nodes.length && leader;

  const clusterTabs = ['summary', 'nodes', 'settings', 'backups'];
  const nodeTabs = ['summary'];
  const dbTabs = ['summary'];

  const currentTabs = view.type === 'cluster' ? clusterTabs : view.type === 'database' ? dbTabs : nodeTabs;
  const selectedNode = view.type === 'node' ? nodes.find(n => n.name === view.name) : null;

  const breadcrumb = view.type === 'cluster'
    ? [{ label: cluster?.cluster_name || 'Cluster' }]
    : view.type === 'database'
    ? [
        { label: cluster?.cluster_name || 'Cluster', onClick: () => setView({ type: 'cluster', tab: 'summary' }) },
        { label: view.name }
      ]
    : [
        { label: cluster?.cluster_name || 'Cluster', onClick: () => setView({ type: 'cluster', tab: 'summary' }) },
        { label: view.name }
      ];

  return (
    <div className="layout">
      <div className="topbar">
        <div className="topbar-left">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle sidebar">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><rect y="3" width="20" height="2" rx="1"/><rect y="9" width="20" height="2" rx="1"/><rect y="15" width="20" height="2" rx="1"/></svg>
          </button>
          <div className="topbar-logo"><PgLogo size={26} /></div>
          <div className="topbar-title">PostgreSQL Cluster Manager</div>
        </div>
        <div className="topbar-right">
          <VersionBadge />
          <div className="topbar-status">
            <div className={`status-indicator ${healthy ? 'ok' : error ? 'err' : 'warn'}`} />
            <span>{healthy ? 'Healthy' : error ? 'Error' : 'Degraded'}</span>
          </div>
          <span>{lastUpdate ? lastUpdate.toLocaleTimeString() : '-'}</span>
          <a href="https://github.com/iadityaharsh/postgresql-cluster" target="_blank" rel="noopener noreferrer"
             style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', background: 'var(--bg-btn)', border: '1px solid var(--border)', borderRadius: 4, textDecoration: 'none', fontSize: 12, transition: 'all 0.15s' }}
             onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-btn-hover)'; }}
             onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-btn)'; }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            <span style={{ fontWeight: 500 }}>postgresql-cluster</span>
            <GithubStars />
          </a>
          {authStatus?.auth_required && (
            <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={async () => {
              await fetch('/api/logout', { method: 'POST' });
              setAuthStatus({ ...authStatus, logged_in: false });
            }}>Logout</button>
          )}
        </div>
      </div>

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="body-row">
        <div className={`sidebar ${sidebarOpen ? 'open' : ''}`} ref={sidebarRef} style={{ display: 'flex', flexDirection: 'column', width: sidebarWidth }}>
          <div className="sidebar-resize" onMouseDown={(e) => { e.preventDefault(); draggingRef.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; }} />
          <div className="tree-search">
            <input type="text" placeholder="Search" value={sidebarFilter} onChange={e => setSidebarFilter(e.target.value)} />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 50 }}>
            <div className="tree-node">
              <div className={`tree-row ${view.type === 'cluster' && view.tab !== 'backups' ? 'active' : ''}`}
                   onClick={() => { setView({ type: 'cluster', tab: 'summary' }); setExpanded(e => ({ ...e, cluster: !e.cluster })); setSidebarOpen(false); }}>
                <div className={`tree-arrow ${expanded.cluster ? 'open' : ''}`}>&#9654;</div>
                <div className="tree-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><rect x="2" y="3" width="20" height="6" rx="1"/><rect x="2" y="15" width="20" height="6" rx="1"/><path d="M12 9v6"/></svg>
                </div>
                <span className="tree-label" style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{cluster?.cluster_name || 'pg-cluster'}</span>
                <span className={`tree-status ${nodesUp === nodes.length && nodes.length > 0 ? 'ok' : 'err'}`}></span>
              </div>

              {expanded.cluster && <div className="tree-children">
                {nodes.filter(n => !sidebarFilter || n.name.toLowerCase().includes(sidebarFilter.toLowerCase())).map((node, i) => {
                  const p = node.patroni || {};
                  const isLeader = p.role === 'master' || p.role === 'primary';
                  const isRunning = p.state === 'running';
                  return (
                    <div key={i} className="tree-node">
                      <div className={`tree-row ${view.type === 'node' && view.name === node.name ? 'active' : ''}`}
                           onClick={() => { setView({ type: 'node', name: node.name, tab: 'summary' }); setSidebarOpen(false); }}>
                        <div className="tree-indent"></div>
                        <div className="tree-arrow hidden">&#9654;</div>
                        <div className="tree-icon">
                          <svg viewBox="0 0 24 24" fill="none" stroke={isRunning ? '#50c878' : '#e74c3c'} strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="9" x2="9" y2="9.01" strokeWidth="3" strokeLinecap="round"/><line x1="15" y1="9" x2="15" y2="9.01" strokeWidth="3" strokeLinecap="round"/><path d="M4 15h16"/></svg>
                        </div>
                        <span className="tree-label">{node.name}</span>
                        {isRunning ? (
                          <span className={`tree-badge ${isLeader ? 'leader' : 'replica'}`}>{isLeader ? 'Leader' : 'Replica'}</span>
                        ) : (
                          <span className="tree-badge down">offline</span>
                        )}
                      </div>
                    </div>
                  );
                })}

              </div>}
            </div>

            <div className="tree-node" style={{ marginTop: 4 }}>
              <div className="tree-row"
                   onClick={() => setExpanded(e => ({ ...e, databases: !e.databases }))}>
                <div className={`tree-arrow ${expanded.databases ? 'open' : ''}`}>&#9654;</div>
                <div className="tree-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
                </div>
                <span className="tree-label" style={{ fontWeight: 600, color: 'var(--text-bright)' }}>Databases</span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 4 }}>{databases?.length || 0}</span>
              </div>

              {expanded.databases && <div className="tree-children">
                {(databases || [])
                  .filter(db => !sidebarFilter || db.datname.toLowerCase().includes(sidebarFilter.toLowerCase()))
                  .sort((a, b) => a.datname.localeCompare(b.datname))
                  .map((db, i) => (
                    <div key={i} className="tree-node">
                      <div className={`tree-row ${view.type === 'database' && view.name === db.datname ? 'active' : ''}`}
                           onClick={() => { setView({ type: 'database', name: db.datname, tab: 'summary' }); setSidebarOpen(false); }}>
                        <div className="tree-indent"></div>
                        <div className="tree-arrow hidden">&#9654;</div>
                        <div className="tree-icon">
                          <svg viewBox="0 0 24 24" fill="none" stroke="#f0ad4e" strokeWidth="2"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
                        </div>
                        <span className="tree-label">{db.datname}</span>
                      </div>
                    </div>
                  ))}
                {(!databases || databases.length === 0) && (
                  <div style={{ padding: '4px 14px 4px 36px', fontSize: 11, color: 'var(--text-faint)' }}>No databases</div>
                )}
              </div>}
            </div>
          </div>

          <div style={{ background: 'var(--bg-sidebar)', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ padding: '10px 14px' }}>
              <button
                onClick={() => setShowCreateDb(true)}
                style={{ width: '100%', padding: '7px 0', background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> New Database
              </button>
            </div>
            <div style={{ padding: '0 14px 10px', fontSize: 12, color: 'var(--text-faint)' }}>
              {cluster?.vip && <div>VIP: {cluster.vip}:{cluster.pg_port}</div>}
              <div style={{ marginTop: 2 }}>{nodesUp}/{nodes.length} nodes online</div>
            </div>
          </div>
        </div>

        <div className="main">
          <div className="content-header">
            <div className="breadcrumb">
              {breadcrumb.map((b, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="sep">/</span>}
                  {b.onClick ? <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={b.onClick}>{b.label}</span> : <strong>{b.label}</strong>}
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="tabs">
            {currentTabs.map(tab => (
              <div key={tab} className={`tab ${view.tab === tab ? 'active' : ''}`}
                   onClick={() => setView(v => ({ ...v, tab }))}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </div>
            ))}
          </div>

          <div className="tab-content">
            {view.type === 'cluster' && view.tab === 'summary' && <SummaryTab cluster={cluster} connections={connections} replication={replication} system={system} databases={databases} />}
            {view.type === 'cluster' && view.tab === 'nodes' && <NodesTab cluster={cluster} replication={replication} connections={connections} />}
            {view.type === 'cluster' && view.tab === 'settings' && <SettingsTab />}
            {view.type === 'cluster' && view.tab === 'backups' && <BackupsTab />}
            {view.type === 'node' && view.tab === 'summary' && <NodeDetailTab node={selectedNode} systemData={system} />}
            {view.type === 'database' && view.tab === 'summary' && <DatabaseTab db={dbData} error={dbError} />}
          </div>
        </div>
      </div>
      {showCreateDb && (
        <CreateDatabaseModal
          onClose={() => setShowCreateDb(false)}
          onCreated={() => fetchData()}
        />
      )}
    </div>
  );
}
