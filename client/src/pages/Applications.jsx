import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

const STATUSES = ['Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'];

export default function Applications({ profile }) {
  const [apps, setApps] = useState([]);
  const [expanded, setExpanded] = useState(null);

  async function refresh() {
    try {
      const r = await apiFetch(`/api/applications?profile_id=${profile.id}`);
      setApps(await r.json());
    } catch { /* transient */ }
  }

  useEffect(() => { refresh(); }, []);

  async function setStatus(id, status) {
    await apiFetch(`/api/applications/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }).catch(() => {});
    refresh();
  }

  return (
    <div className="page">
      <h1>Applications ({apps.length})</h1>
      <div className="card">
        <table>
          <thead>
            <tr><th>Company</th><th>Role</th><th>Status</th><th>Applied</th><th></th></tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <React.Fragment key={a.id}>
                <tr>
                  <td>{a.company}</td>
                  <td>{a.role_url ? <a href={a.role_url} target="_blank" rel="noreferrer">{a.role_title}</a> : a.role_title}</td>
                  <td>
                    <select value={a.status} onChange={(e) => setStatus(a.id, e.target.value)} style={{ width: 'auto' }}>
                      {STATUSES.concat(STATUSES.includes(a.status) ? [] : [a.status]).map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="muted small">{(a.created_at || '').slice(0, 10)}</td>
                  <td>
                    {a.qa?.length > 0 && (
                      <button className="btn secondary" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                        Q&A ({a.qa.length})
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === a.id && (
                  <tr>
                    <td colSpan={5}>
                      <table>
                        <tbody>
                          {a.qa.map((qa, i) => (
                            <tr key={i}>
                              <td className="muted small" style={{ width: '40%' }}>{qa.question || qa.q}</td>
                              <td className="small">{String(qa.answer || qa.a || '').slice(0, 300)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {!apps.length && <tr><td colSpan={5} className="muted">No applications yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
