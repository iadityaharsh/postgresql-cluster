import React, { useState, useEffect } from 'react';

const NAME_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

function generatePassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => chars[b % chars.length]).join('');
}

export default function CreateDatabaseModal({ onClose, onCreated }) {
  const [step, setStep] = useState('form');
  const [dbname, setDbname] = useState('');
  const [owner, setOwner] = useState('');
  const [ownerEdited, setOwnerEdited] = useState(false);
  const [password, setPassword] = useState(() => generatePassword());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successData, setSuccessData] = useState(null);

  useEffect(() => {
    if (!ownerEdited) setOwner(dbname ? `${dbname}_user` : '');
  }, [dbname, ownerEdited]);

  const dbnameValid = NAME_REGEX.test(dbname);
  const ownerValid = NAME_REGEX.test(owner);
  const passwordValid = password.length >= 8;
  const canSubmit = dbnameValid && ownerValid && passwordValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/databases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: dbname, owner, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create database');
      } else {
        setSuccessData({ database: data.database, owner: data.owner, password });
        setStep('success');
        onCreated();
      }
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, width: 440, maxWidth: '95vw', padding: 24, boxShadow: '0 8px 32px var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <strong style={{ fontSize: 15 }}>Create Database</strong>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {step === 'form' && (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Database Name</label>
              <input
                value={dbname}
                onChange={e => setDbname(e.target.value.toLowerCase())}
                placeholder="e.g. myapp"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', background: 'var(--bg-input)', border: `1px solid ${dbname && !dbnameValid ? '#e74c3c' : 'var(--border)'}`, borderRadius: 4, color: 'var(--text)', fontSize: 13 }}
              />
              {dbname && !dbnameValid && <div style={{ fontSize: 11, color: '#e74c3c', marginTop: 3 }}>Lowercase letters, digits, underscore. Must start with a letter.</div>}
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Owner Username</label>
              <input
                value={owner}
                onChange={e => { setOwner(e.target.value.toLowerCase()); setOwnerEdited(true); }}
                placeholder="e.g. myapp_user"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', background: 'var(--bg-input)', border: `1px solid ${owner && !ownerValid ? '#e74c3c' : 'var(--border)'}`, borderRadius: 4, color: 'var(--text)', fontSize: 13 }}
              />
              {owner && !ownerValid && <div style={{ fontSize: 11, color: '#e74c3c', marginTop: 3 }}>Lowercase letters, digits, underscore. Must start with a letter.</div>}
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Password</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  style={{ flex: 1, padding: '7px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 13, fontFamily: 'Consolas, monospace' }}
                />
                <button onClick={() => setPassword(generatePassword())}
                  style={{ padding: '7px 10px', background: 'var(--bg-btn)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  Regenerate
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#f0ad4e', marginTop: 5 }}>Save this password — it will not be shown again.</div>
            </div>

            {error && <div style={{ marginBottom: 12, padding: '8px 10px', background: 'rgba(231,76,60,0.15)', border: '1px solid rgba(231,76,60,0.4)', borderRadius: 4, fontSize: 12, color: '#e74c3c' }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ padding: '7px 16px', background: 'var(--bg-btn)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSubmit} disabled={!canSubmit}
                style={{ padding: '7px 16px', background: canSubmit ? 'var(--accent)' : 'var(--border)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 13, cursor: canSubmit ? 'pointer' : 'default', opacity: submitting ? 0.6 : 1 }}>
                {submitting ? 'Creating…' : 'Create Database'}
              </button>
            </div>
          </>
        )}

        {step === 'success' && successData && (
          <>
            <div style={{ marginBottom: 16, padding: '10px 12px', background: 'rgba(80,200,120,0.12)', border: '1px solid rgba(80,200,120,0.35)', borderRadius: 4, fontSize: 13, color: '#50c878' }}>
              Database <strong>{successData.database}</strong> created successfully.
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 3 }}>Owner</div>
              <div style={{ fontFamily: 'Consolas, monospace', fontSize: 13, background: 'var(--bg-input)', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', userSelect: 'all' }}>{successData.owner}</div>
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 3 }}>Password</div>
              <div style={{ fontFamily: 'Consolas, monospace', fontSize: 13, background: 'var(--bg-input)', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', userSelect: 'all', wordBreak: 'break-all' }}>{successData.password}</div>
            </div>
            <div style={{ fontSize: 11, color: '#f0ad4e', marginBottom: 16 }}>Save these credentials — the password will not be shown again.</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ padding: '7px 20px', background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 13, cursor: 'pointer' }}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
