import React, { useState } from 'react';
import Toast from './Toast';
import { formatBytes, formatUptime } from './utils';

function StatCard({ label, value, sub, accent, children }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px', flex: 1 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10 }}>{label}</div>
      {children || (
        <div style={{ fontSize: 28, fontWeight: 700, color: accent || 'var(--text-bright)', lineHeight: 1 }}>{value}</div>
      )}
      {sub && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

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

  const nodesHealthy = nodesUp === nodes.length && nodes.length > 0;
  const replicationOk = replication.length > 0;

  return (
    <div>
      {/* Top stat cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <StatCard label="Nodes Online" value={`${nodesUp} / ${nodes.length}`} accent={nodesHealthy ? 'var(--ok)' : 'var(--err)'} sub={nodesHealthy ? 'All nodes healthy' : `${nodes.length - nodesUp} node(s) down`} />

        <StatCard label="Connections">
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1 }}>{connTotal} <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--text-dim)' }}>/ {connMax}</span></div>
          <div style={{ marginTop: 10, height: 4, background: 'var(--gauge-track)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(connPct, 100)}%`, background: connPct > 80 ? 'var(--err)' : connPct > 60 ? 'var(--warn)' : 'var(--ok)', borderRadius: 2, transition: 'width 0.5s' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{connPct.toFixed(1)}% utilization</div>
        </StatCard>

        <StatCard label="Replication">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: replicationOk ? 'var(--ok)' : 'var(--err)', boxShadow: replicationOk ? '0 0 6px var(--ok)' : 'none', flexShrink: 0 }} />
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1 }}>{replication.length}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{replication.length === 1 ? 'replica streaming' : 'replicas streaming'}</div>
        </StatCard>

        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px', flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10 }}>Current Leader</div>
          {leader ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)', lineHeight: 1.2, wordBreak: 'break-all' }}>{leader.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'monospace' }}>{leader.ip}</div>
              {replicas.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
                  <select value={switchTarget} onChange={e => setSwitchTarget(e.target.value)}
                    style={{ flex: 1, fontSize: 11, padding: '4px 6px', background: 'var(--bg-input)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4 }}>
                    <option value="">Switch to…</option>
                    {replicas.map(n => <option key={n.name} value={n.name}>{n.name}</option>)}
                  </select>
                  <button onClick={handleSwitchover} disabled={switching || !switchTarget}
                    style={{ padding: '4px 10px', fontSize: 11, background: switchTarget ? 'var(--accent)' : 'var(--border)', color: '#fff', border: 'none', borderRadius: 4, cursor: switching || !switchTarget ? 'default' : 'pointer', opacity: switching ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                    {switching ? '…' : 'Switch'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--err)' }}>No Leader</div>
          )}
        </div>
      </div>

      {/* Cluster info + Databases */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Cluster Info</div>
          <table className="kv-table" style={{ margin: 0 }}><tbody>
            <tr><td>Cluster Name</td><td style={{ fontWeight: 600 }}>{cluster?.cluster_name || '-'}</td></tr>
            <tr><td>Virtual IP</td><td style={{ fontFamily: 'monospace', fontSize: 12 }}>{cluster?.vip ? `${cluster.vip}:${cluster.pg_port}` : 'Disabled'}</td></tr>
            <tr><td>Total Nodes</td><td>{nodes.length}</td></tr>
            <tr><td>Databases</td><td>{databases?.length || 0}</td></tr>
            <tr><td>Max Connections</td><td>{connMax}</td></tr>
          </tbody></table>
        </div>

        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Databases</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>
              <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, color: 'var(--text-dim)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>Name</th>
              <th style={{ padding: '8px 16px', textAlign: 'right', fontSize: 11, color: 'var(--text-dim)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>Size</th>
              <th style={{ padding: '8px 16px', textAlign: 'right', fontSize: 11, color: 'var(--text-dim)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>Connections</th>
            </tr></thead>
            <tbody>
              {(databases || []).map((db, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '8px 16px', fontWeight: 500 }}>{db.datname}</td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 12 }}>{formatBytes(parseInt(db.size_bytes))}</td>
                  <td style={{ padding: '8px 16px', textAlign: 'right' }}>{db.connections > 0 ? <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{db.connections}</span> : <span style={{ color: 'var(--text-faint)' }}>0</span>}</td>
                </tr>
              ))}
              {(!databases || databases.length === 0) && <tr><td colSpan="3" style={{ padding: '16px', textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}>No databases</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* System Resources */}
      {system && system.length > 0 && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>System Resources</div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${system.length}, 1fr)`, gap: 0 }}>
            {system.map((s, i) => (
              <div key={i} style={{ padding: '16px', borderRight: i < system.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.error ? 'var(--err)' : 'var(--ok)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>{s.hostname || s.name}</span>
                </div>
                {s.error ? <div style={{ color: 'var(--err)', fontSize: 12 }}>Unreachable</div> : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-dim)' }}>Memory</span>
                      <span style={{ fontWeight: 500 }}>{s.memory?.used_percent}%</span>
                    </div>
                    <div style={{ height: 4, background: 'var(--gauge-track)', borderRadius: 2, overflow: 'hidden', marginBottom: 10 }}>
                      <div style={{ height: '100%', width: `${s.memory?.used_percent}%`, background: parseFloat(s.memory?.used_percent) > 80 ? 'var(--err)' : parseFloat(s.memory?.used_percent) > 60 ? 'var(--warn)' : 'var(--ok)', borderRadius: 2 }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>{formatBytes(s.memory?.total_bytes - s.memory?.free_bytes)} / {formatBytes(s.memory?.total_bytes)}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)' }}>
                      <span>{s.cpu_count} cores · load {s.load_avg?.['1m']?.toFixed(2) ?? 'N/A'}</span>
                      <span>up {formatUptime(s.uptime_seconds)}</span>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
