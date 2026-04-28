import React, { useState } from 'react';
import PgLogo from './PgLogo';

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const d = await resp.json();
      if (resp.ok) onLogin();
      else setError(d.error || 'Login failed');
    } catch { setError('Connection failed'); }
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-base)' }}>
      <div style={{ width: 340, padding: 32, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ marginBottom: 12, display: 'inline-block' }}><PgLogo size={56} /></div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-bright)' }}>PostgreSQL Cluster Manager</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>Sign in to access the dashboard</div>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label>Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </div>
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <div style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
          <button type="submit" className="btn primary" aria-label="Sign in" aria-busy={loading}
            style={{ width: '100%', height: 36, fontSize: 13, fontWeight: 600 }} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
