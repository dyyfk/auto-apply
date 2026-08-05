import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

export default function Dashboard({ profile }) {
  const [jobs, setJobs] = useState([]);
  const [pauseState, setPauseState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('pending');

  async function refresh() {
    try {
      const [jr, pr] = await Promise.all([
        apiFetch(`/api/jobs?profile_id=${profile.id}`),
        apiFetch('/api/jobs/paused'),
      ]);
      setJobs(await jr.json());
      setPauseState(await pr.json());
    } catch { /* transient */ }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  async function togglePause() {
    setBusy(true);
    await apiFetch(pauseState?.paused ? '/api/jobs/resume' : '/api/jobs/pause', { method: 'POST' }).catch(() => {});
    await refresh();
    setBusy(false);
  }

  const counts = jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {});
  const shown = jobs.filter((j) => (filter === 'all' ? true : j.status === filter));

  return (
    <div className="page">
      <h1>Queue</h1>
      <div className="stat-grid">
        {['pending', 'in_progress', 'done', 'failed'].map((s) => (
          <div className="stat" key={s}>
            <div className="n">{counts[s] || 0}</div>
            <div className="lbl">{s.replace('_', ' ')}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className={'btn' + (pauseState?.paused ? '' : ' danger')} onClick={togglePause} disabled={busy || !pauseState}>
          {pauseState?.paused ? 'Resume applying' : 'Pause applying'}
        </button>
        <span className="muted small">
          {pauseState?.paused
            ? 'Paused — apply sessions stop after their current role.'
            : 'Running. Start an apply session with: node scripts/apply.js --queue'}
        </span>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {['pending', 'in_progress', 'done', 'failed', 'skipped', 'all'].map((s) => (
            <button
              key={s}
              className={'btn secondary'}
              style={filter === s ? { background: '#eef1fb' } : {}}
              onClick={() => setFilter(s)}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <table>
          <thead>
            <tr><th>Company</th><th>Role</th><th>Status</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {shown.map((j) => (
              <tr key={j.id}>
                <td>{j.company}</td>
                <td>{j.role_url ? <a href={j.role_url} target="_blank" rel="noreferrer">{j.role_title}</a> : j.role_title}</td>
                <td><span className={'badge ' + j.status}>{j.status}</span>{j.submitted_at ? <span className="muted small"> submitted</span> : null}</td>
                <td className="small muted">{(j.error || j.notes || '').slice(0, 140)}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={4} className="muted">Nothing here. Run <code>node scripts/scout.js</code> to find roles.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
