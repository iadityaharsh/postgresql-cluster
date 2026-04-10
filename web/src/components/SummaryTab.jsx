import React, { useState } from 'react';
import Gauge from './Gauge';
import Badge from './Badge';
import Toast from './Toast';
import { formatBytes, formatUptime } from './utils';

export default function SummaryTab({ cluster, connections, replication, system, databases }) {
  const nodes = cluster?.nodes || [];
  const nodesUp = nodes.filter(n => n.patroni?.state === 'running').length;
  const leader = nodes.find(n => n.patroni?.role === 'master' || n.patroni?.role === 'primary');
  const replicas = nodes.filter(n => n.patroni?.state === 'running' && n.name !== leader?.name);
  const [switching, setSwitching] = useState(false);
  const [switchTarget, setSwitchTarget] = useState('');
  const [toast, setToast] = useState(null);
  const connTotal = connections?.by_state?.reduce((s, c) => s + parseInt(c.count), 0) || 0;
  const connMax = connections?.max_connections || 0;
  const connPct = connMax ? ((connTotal / connMax) * 100) : 0;

  const handleSwitchover = async () => {
    if (switching || !switchTarget) return;
    setSwitching(true);
    try {
      const r = await fetch('/api/cluster/switchover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: switchTarget })
      });
      const data = await r.json();
      if (r.ok) {
        setToast({ message: data.message, type: 'success' });
        setSwitchTarget('');
      } else {
        setToast({ message: data.error || 'Switchover failed', type: 'error' });
      }
    } catch (err) {
      setToast({ message: err.message, type: 'error' });
    }
    setSwitching(false);
  };

  return (
    <div>
      <div className="panel">
        <div className="panel-header">Status</div>
        <div className="panel-body">
          <div className="panel-grid cols-4">
            <Gauge percent={(nodesUp / (nodes.length || 1)) * 100} label="Nodes Online" detail={`${nodesUp} / ${nodes.length}`} />
            <Gauge percent={connPct} label="Connections" detail={`${connTotal} / ${connMax}`} />
            <Gauge percent={replicas.length > 0 ? 100 : 0} label="Replication" detail={`${replicas.length} streaming`} />
            <div className="gauge-container">
              <div style={{ textAlign: 'center', padding: '10px 0' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: leader ? '#50c878' : '#e74c3c' }}>{leader ? leader.name : 'NONE'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>{leader?.ip || 'no leader'}</div>
                {leader && replicas.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                    <select value={switchTarget} onChange={e => setSwitchTarget(e.target.value)}
                      style={{ fontSize: 11, padding: '3px 6px', background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}>
                      <option value="">Switch to...</option>
                      {replicas.map(n => <option key={n.name} value={n.name}>{n.name}</option>)}
                    </select>
                    <button onClick={handleSwitchover} disabled={switching || !switchTarget}
                      style={{ padding: '3px 10px', fontSize: 11, background: switchTarget ? 'var(--accent)' : 'var(--border)', color: '#fff', border: 'none', borderRadius: 4, cursor: switching || !switchTarget ? 'default' : 'pointer', opacity: switching ? 0.6 : 1 }}>
                      {switching ? 'Switching...' : 'Switch'}
                    </button>
                  </div>
                )}
              </div>
              <div className="gauge-label">Current Leader</div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel-grid cols-2">
        <div className="panel">
          <div className="panel-header">Cluster Info</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="kv-table">
              <tbody>
                <tr><td>Cluster Name</td><td>{cluster?.cluster_name || '-'}</td></tr>
                <tr><td>Virtual IP</td><td style={{ fontFamily: 'monospace' }}>{cluster?.vip ? `${cluster.vip}:${cluster.pg_port}` : 'Disabled'}</td></tr>
                <tr><td>Total Nodes</td><td>{nodes.length}</td></tr>
                <tr><td>Databases</td><td>{databases?.length || 0}</td></tr>
                <tr><td>Max Connections</td><td>{connMax}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">Databases</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Name</th><th>Size</th><th>Connections</th></tr></thead>
              <tbody>
                {(databases || []).map((db, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500 }}>{db.datname}</td>
                    <td>{formatBytes(parseInt(db.size_bytes))}</td>
                    <td>{db.connections}</td>
                  </tr>
                ))}
                {(!databases || databases.length === 0) && <tr><td colSpan="3" className="empty">No databases</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {system && system.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-header">System Resources</div>
          <div className="panel-body">
            <div className="panel-grid cols-3">
              {system.map((s, i) => (
                <div key={i} style={{ background: 'var(--bg-input)', borderRadius: 4, padding: 12, border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ color: s.error ? '#e74c3c' : '#50c878', fontSize: 10 }}>&#9679;</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{s.hostname || s.name}</span>
                  </div>
                  {s.error ? <div style={{ color: 'var(--err)', fontSize: 12 }}>Unreachable</div> : (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                        <span>Memory</span><span>{s.memory?.used_percent}%</span>
                      </div>
                      <div className="progress">
                        <div className={`progress-fill ${parseFloat(s.memory?.used_percent) > 80 ? 'err' : parseFloat(s.memory?.used_percent) > 60 ? 'warn' : 'ok'}`}
                             style={{ width: `${s.memory?.used_percent}%` }} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                        {formatBytes(s.memory?.total_bytes - s.memory?.free_bytes)} / {formatBytes(s.memory?.total_bytes)}
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                        <span>CPU: {s.cpu_count} cores</span>
                        <span style={{ color: 'var(--text-dim)' }}>Load: {s.load_avg?.['1m']?.toFixed(2) ?? 'N/A'}</span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-dim)' }}>Uptime: {formatUptime(s.uptime_seconds)}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
