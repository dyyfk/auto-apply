import React, { useState } from 'react';
import { setToken } from '../api.js';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) { setError('Wrong password.'); return; }
    const { token } = await r.json();
    setToken(token);
    onLogin();
  }

  return (
    <div className="page" style={{ maxWidth: 420 }}>
      <div className="card">
        <h1>Auto Apply</h1>
        <form onSubmit={submit}>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          {error && <div className="error-text">{error}</div>}
          <button className="btn" type="submit">Log in</button>
        </form>
      </div>
    </div>
  );
}
