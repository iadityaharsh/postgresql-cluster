import React from 'react';
import Gauge from './Gauge';
import Badge from './Badge';
import { formatBytes } from './utils';

export default function NodesTab({ cluster, replication, connections }) {
  const nodes = cluster?.nodes || [];
  const connTotal = connections?.by_state?.reduce((s, c) => s + parseInt(c.count), 0) || 0;
  const connMax = connections?.max_connections || 0;
  const connPct = connMax ? ((connTotal / connMax) * 100) : 0;
  return (
    <div>
      <div className="panel">
        <div className="panel-header">Cluster Members</div>
        <div className="panel-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Node</th><th>IP Address</th><th>Role</th><th>State</th><th>PostgreSQL</th><th>Timeline</th><th>Replication</th></tr>
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
        <div className="panel-grid cols-2">
          <div className="panel">
            <div className="panel-header">Connection Usage</div>
            <div className="panel-body" style={{ display: 'flex', justifyContent: 'center' }}>
              <Gauge percent={connPct} label="Connection Usage" detail={`${connTotal} / ${connMax}`} size={120} />
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">Connections by State</div>
            <div className="panel-body" style={{ padding: 0 }}>
              <table>
                <thead><tr><th>State</th><th>Count</th><th>Percentage</th></tr></thead>
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
                            <div className="progress" style={{ flex: 1 }}>
                              <div className="progress-fill ok" style={{ width: `${p}%` }} />
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
        </div>
      )}
    </div>
  );
}
