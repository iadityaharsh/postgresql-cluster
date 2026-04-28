import React from 'react';
import { formatBytes, formatDate } from './utils';

function StatCard({ label, children }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px', flex: 1 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10 }}>{label}</div>
      {children}
    </div>
  );
}

function KVRow({ label, value }) {
  return <tr><td style={{ color: 'var(--text-dim)', width: '50%' }}>{label}</td><td style={{ fontWeight: 500 }}>{value}</td></tr>;
}

export default function DatabaseTab({ db, error }) {
  if (error) {
    return <div style={{ padding: 32, color: 'var(--err)', textAlign: 'center' }}>{error}</div>;
  }
  if (!db) {
    return <div style={{ padding: 32, color: 'var(--text-dim)', textAlign: 'center' }}>Loading…</div>;
  }

  const totalBlocks = db.blks_hit + db.blks_read;
  const cacheHitRatio = totalBlocks > 0 ? ((db.blks_hit / totalBlocks) * 100) : null;
  const cacheColor = cacheHitRatio === null ? 'var(--text-dim)' : cacheHitRatio >= 95 ? 'var(--ok)' : 'var(--warn)';

  const totalXact = db.xact_commit + db.xact_rollback;
  const rollbackRate = totalXact > 0 ? ((db.xact_rollback / totalXact) * 100).toFixed(1) : '0.0';

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <StatCard label="Size">
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-bright)', lineHeight: 1 }}>{formatBytes(db.size_bytes)}</div>
        </StatCard>
        <StatCard label="Active Connections">
          <div style={{ fontSize: 28, fontWeight: 700, color: db.numbackends > 0 ? 'var(--ok)' : 'var(--text-bright)', lineHeight: 1 }}>{db.numbackends}</div>
        </StatCard>
        <StatCard label="Cache Hit Ratio">
          <div style={{ fontSize: 28, fontWeight: 700, color: cacheColor, lineHeight: 1 }}>
            {cacheHitRatio === null ? 'N/A' : `${cacheHitRatio.toFixed(1)}%`}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
            {cacheHitRatio === null ? 'no reads yet' : cacheHitRatio >= 95 ? 'healthy' : 'below target'}
          </div>
        </StatCard>
        <StatCard label="Deadlocks">
          <div style={{ fontSize: 28, fontWeight: 700, color: db.deadlocks > 0 ? 'var(--err)' : 'var(--text-bright)', lineHeight: 1 }}>{db.deadlocks ?? 0}</div>
          {db.deadlocks > 0 && <div style={{ fontSize: 12, color: 'var(--err)', marginTop: 6 }}>investigate locks</div>}
        </StatCard>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Objects</div>
          <table className="kv-table"><tbody>
            <KVRow label="Tables" value={db.table_count} />
            <KVRow label="Indexes" value={db.index_count} />
            <KVRow label="Dead Tuples" value={(db.dead_tup_sum ?? 0).toLocaleString()} />
            <KVRow label="Last Autovacuum" value={db.last_autovacuum ? formatDate(db.last_autovacuum) : 'Never'} />
          </tbody></table>
        </div>
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Transactions</div>
          <table className="kv-table"><tbody>
            <KVRow label="Committed" value={(db.xact_commit ?? 0).toLocaleString()} />
            <KVRow label="Rolled Back" value={(db.xact_rollback ?? 0).toLocaleString()} />
            <KVRow label="Rollback Rate" value={`${rollbackRate}%`} />
          </tbody></table>
        </div>
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Database Info</div>
        <table className="kv-table"><tbody>
          <KVRow label="Owner" value={db.owner} />
          <KVRow label="Encoding" value={db.encoding} />
          <KVRow label="Collation" value={db.collation} />
          <KVRow label="Ctype" value={db.ctype} />
          <KVRow label="XID Age" value={db.xid_age?.toLocaleString()} />
        </tbody></table>
      </div>
    </div>
  );
}
