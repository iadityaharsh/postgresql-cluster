import React, { useState } from 'react';
import Badge from './Badge';
import { formatBytes } from './utils';

export default function NodesTab({ cluster, replication, connections }) {
  const nodes = cluster?.nodes || [];
  const connTotal = connections?.by_state?.reduce((s, c) => s + parseInt(c.count), 0) || 0;
  const connMax = connections?.max_connections || 0;
  const connPct = connMax ? ((connTotal / connMax) * 100) : 0;

  const leaderTimeline = nodes.find(n => { const r = n.patroni?.role; return r === 'master' || r === 'primary'; })?.patroni?.timeline;

  const [reiniting, setReiniting] = useState({});
  const [reinitMsg, setReinitMsg] = useState({});
  const reinitNode = async (name) => {
    setReiniting(r => ({ ...r, [name]: true }));
    setReinitMsg(m => ({ ...m, [name]: null }));
    try {
      const resp = await fetch('/api/cluster/reinit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node: name }) });
      const data = await resp.json();
      setReinitMsg(m => ({ ...m, [name]: resp.ok ? data.message : data.error }));
    } catch (e) {
      setReinitMsg(m => ({ ...m, [name]: e.message }));
    }
    setReiniting(r => ({ ...r, [name]: false }));
  };

  return (
    <div>
      <div className="panel">
        <div className="panel-header">Cluster Members</div>
        <div className="panel-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Node</th><th>IP Address</th><th>Role</th><th>State</th><th>PostgreSQL</th><th>Timeline</th><th>Replication</th><th></th></tr>
            </thead>
            <tbody>
              {nodes.map((node, i) => {
                const p = node.patroni || {};
                const role = p.role || 'unknown';
                const state = p.state || 'unknown';
                const isLeader = role === 'master' || role === 'primary';
                const isRunning = state === 'running';
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{node.name}</td>
                    <td style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{node.ip}</td>
                    <td><Badge type={isLeader ? 'ok' : 'info'} text={isLeader ? 'Leader' : 'Replica'} /></td>
                    <td><Badge type={isRunning ? 'ok' : 'err'} text={state} /></td>
                    <td>{p.server_version || '-'}</td>
                    <td>{p.timeline || '-'}</td>
                    <td>{p.replication_state || (isLeader ? '-' : 'streaming')}</td>
                    <td>
                      {!isLeader && leaderTimeline && p.timeline && p.timeline < leaderTimeline && (
                        <div>
                          <button className="btn warn" style={{ fontSize: 11, padding: '2px 8px' }}
                            disabled={reiniting[node.name]}
                            onClick={() => reinitNode(node.name)}>
                            {reiniting[node.name] ? 'Reinitializing…' : 'Reinit'}
                          </button>
                          {reinitMsg[node.name] && <div style={{ fontSize: 11, marginTop: 3, color: 'var(--text-muted)' }}>{reinitMsg[node.name]}</div>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Replication Status</div>
        <div className="panel-body" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Client Address</th><th>State</th><th>Sent LSN</th><th>Replay LSN</th><th>Lag</th></tr></thead>
            <tbody>
              {(replication || []).map((r, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{r.client_addr}</td>
                  <td><Badge type={r.state === 'streaming' ? 'ok' : 'warn'} text={r.state} /></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.sent_lsn || '-'}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.replay_lsn || '-'}</td>
                  <td>{formatBytes(parseInt(r.lag_bytes || 0))}</td>
                </tr>
              ))}
              {(!replication || replication.length === 0) && <tr><td colSpan="5" className="empty">No replication data (this node may be a replica)</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {connections?.by_state && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10 }}>Connection Usage</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1 }}>
              {connTotal} <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--text-dim)' }}>/ {connMax}</span>
            </div>
            <div style={{ marginTop: 10, height: 4, background: 'var(--gauge-track)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(connPct, 100)}%`, background: connPct > 80 ? 'var(--err)' : connPct > 60 ? 'var(--warn)' : 'var(--ok)', borderRadius: 2, transition: 'width 0.5s' }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{connPct.toFixed(1)}% utilization</div>
          </div>

          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Connections by State</div>
            <table>
              <thead><tr><th>State</th><th>Count</th><th>Share</th></tr></thead>
              <tbody>
                {connections.by_state.map((s, i) => {
                  const cnt = parseInt(s.count);
                  const p = connTotal ? ((cnt / connTotal) * 100).toFixed(1) : 0;
                  return (
                    <tr key={i}>
                      <td>{s.state || 'null'}</td>
                      <td style={{ fontWeight: 600 }}>{cnt}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 4, background: 'var(--gauge-track)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${p}%`, background: 'var(--ok)', borderRadius: 2, transition: 'width 0.3s' }} />
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-dim)', width: 36 }}>{p}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
