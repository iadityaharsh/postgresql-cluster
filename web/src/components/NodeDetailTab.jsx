import React from 'react';
import Badge from './Badge';
import { formatBytes, formatUptime } from './utils';

export default function NodeDetailTab({ node, systemData }) {
  const p = node?.patroni || {};
  const isLeader = p.role === 'master' || p.role === 'primary';
  const isRunning = p.state === 'running';
  const sys = systemData?.find(s => s.name === node?.name || s.hostname === node?.name);
  const memPct = parseFloat(sys?.memory?.used_percent) || 0;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Patroni Status</div>
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

        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 14 }}>System Resources</div>
          {!sys || sys.error ? (
            <div style={{ color: 'var(--text-faint)', fontSize: 12, fontStyle: 'italic' }}>System data unavailable</div>
          ) : (
            <>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-dim)' }}>Memory</span>
                  <span style={{ fontWeight: 500 }}>{memPct.toFixed(1)}%</span>
                </div>
                <div style={{ height: 4, background: 'var(--gauge-track)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${memPct}%`, background: memPct > 80 ? 'var(--err)' : memPct > 60 ? 'var(--warn)' : 'var(--ok)', borderRadius: 2 }} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  {formatBytes(sys.memory?.total_bytes - sys.memory?.free_bytes)} / {formatBytes(sys.memory?.total_bytes)}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
                <span>{sys.cpu_count} cores</span>
                <span>load {sys.load_avg?.['1m']?.toFixed(2) ?? 'N/A'} / {sys.load_avg?.['5m']?.toFixed(2) ?? 'N/A'} / {sys.load_avg?.['15m']?.toFixed(2) ?? 'N/A'}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                uptime {formatUptime(sys.uptime_seconds)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
