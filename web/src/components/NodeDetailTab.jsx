import React from 'react';
import Gauge from './Gauge';
import Badge from './Badge';
import { formatBytes } from './utils';

export default function NodeDetailTab({ node, systemData }) {
  const p = node?.patroni || {};
  const isLeader = p.role === 'master' || p.role === 'primary';
  const isRunning = p.state === 'running';
  const sys = systemData?.find(s => s.name === node?.name || s.hostname === node?.name);

  return (
    <div>
      <div className="panel-grid cols-2">
        <div className="panel">
          <div className="panel-header">Patroni Status</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="kv-table">
              <tbody>
                <tr><td>Role</td><td><Badge type={isLeader ? 'ok' : 'info'} text={isLeader ? 'Leader' : 'Replica'} /></td></tr>
                <tr><td>State</td><td><Badge type={isRunning ? 'ok' : 'err'} text={p.state || 'unknown'} /></td></tr>
                <tr><td>PostgreSQL</td><td>{p.server_version || '-'}</td></tr>
                <tr><td>Timeline</td><td>{p.timeline || '-'}</td></tr>
                <tr><td>Patroni Version</td><td>{p.patroni?.version || '-'}</td></tr>
                <tr><td>Scope</td><td>{p.patroni?.scope || '-'}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">System</div>
          <div className="panel-body">
            {!sys || sys.error ? <div className="empty">System data unavailable</div> : (
              <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                <Gauge percent={sys.memory?.used_percent || 0} label="Memory" detail={`${formatBytes(sys.memory?.total_bytes - sys.memory?.free_bytes)} / ${formatBytes(sys.memory?.total_bytes)}`} />
                <div className="gauge-container">
                  <div style={{ textAlign: 'center', padding: '20px 0' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-bright)' }}>{sys.cpu_count}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>Load: {sys.load_avg?.['1m']?.toFixed(2) ?? 'N/A'} / {sys.load_avg?.['5m']?.toFixed(2) ?? 'N/A'} / {sys.load_avg?.['15m']?.toFixed(2) ?? 'N/A'}</div>
                  </div>
                  <div className="gauge-label">CPU Cores</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
