import React, { useState } from 'react';
import { apiFetch } from '../api.js';

// Post-onboarding profile editor: everything editable in one page, plus
// resume re-upload.

const FIELDS = [
  ['Identity', [
    ['first_name', 'First name'], ['last_name', 'Last name'], ['preferred_name', 'Preferred name'],
    ['email', 'Email'], ['phone', 'Phone'],
  ]],
  ['Links', [
    ['linkedin', 'LinkedIn'], ['github', 'GitHub'], ['website', 'Website'],
  ]],
  ['Location', [
    ['city', 'City'], ['state', 'State'], ['country', 'Country'],
    ['zip', 'ZIP'], ['address_line1', 'Street address'],
  ]],
  ['Employment & education', [
    ['current_employer', 'Employer (add "(until …)" if ended)'], ['current_title', 'Title'],
    ['years_of_experience', 'Years of experience'], ['school', 'School'], ['degree', 'Degree'],
    ['discipline', 'Field of study'], ['edu_start_year', 'Edu start year'], ['edu_end_year', 'Edu end year'],
  ]],
  ['Answers', [
    ['desired_compensation', 'Desired compensation'], ['start_availability', 'Start availability'],
    ['how_heard', '"How did you hear" answer'],
  ]],
];

const BOOLS = [
  ['work_authorized', 'Legally authorized to work'],
  ['needs_sponsorship', 'Requires sponsorship (now or future)'],
  ['currently_employed', 'Currently employed'],
  ['is_student', 'Currently a student'],
  ['over_18', '18 or older'],
  ['willing_to_relocate', 'Willing to relocate / hybrid'],
  ['no_noncompete', 'Free of non-competes'],
  ['clean_record', 'Auto-answer "No" to criminal-history questions'],
];

const AREAS = [
  ['sponsorship_note', 'Sponsorship explanation'],
  ['background', 'Long background'],
  ['positioning', 'Short positioning'],
];

export default function Profile({ profile, onSaved }) {
  const [form, setForm] = useState({ ...profile });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await apiFetch(`/api/profiles/${profile.id}`, { method: 'PUT', body: JSON.stringify(form) });
    setMsg(r.ok ? 'Saved.' : 'Save failed: ' + ((await r.json()).error || r.status));
    setBusy(false);
    if (r.ok) onSaved();
  }

  async function uploadResume(file) {
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append('resume', file);
    const r = await apiFetch(`/api/profiles/${profile.id}/resume`, { method: 'POST', body: fd });
    if (r.ok) {
      const saved = await r.json();
      setForm((f) => ({ ...f, resume_filename: saved.resume_filename }));
      setMsg('Resume updated: ' + saved.resume_filename);
      onSaved();
    } else {
      setMsg('Upload failed: ' + ((await r.json()).error || r.status));
    }
    setBusy(false);
  }

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h1>Profile</h1>

      <div className="card">
        <h2>Resume</h2>
        <p className="muted small">Current: {form.resume_filename || 'none'}</p>
        <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => e.target.files[0] && uploadResume(e.target.files[0])} />
      </div>

      {FIELDS.map(([section, fields]) => (
        <div className="card" key={section}>
          <h2>{section}</h2>
          <div className="row">
            {fields.map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input type="text" value={form[k] ?? ''} onChange={set(k)} />
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <h2>Screening answers</h2>
        {BOOLS.map(([k, label]) => (
          <div className="radio-group" key={k}>
            <span style={{ minWidth: 320 }}>{label}</span>
            <label><input type="radio" checked={form[k] === 1} onChange={() => setForm((f) => ({ ...f, [k]: 1 }))} /> Yes</label>
            <label><input type="radio" checked={form[k] === 0} onChange={() => setForm((f) => ({ ...f, [k]: 0 }))} /> No</label>
          </div>
        ))}
        <label className="field" style={{ maxWidth: 320 }}>
          <span>Visa / citizenship status</span>
          <select value={form.visa_status || ''} onChange={set('visa_status')}>
            <option value="">Select…</option>
            {['citizen', 'green_card', 'h1b', 'f1_opt', 'tn', 'o1', 'other'].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>

      <div className="card">
        <h2>Free-text answers</h2>
        {AREAS.map(([k, label]) => (
          <label className="field" key={k}>
            <span>{label}</span>
            <textarea value={form[k] ?? ''} onChange={set(k)} rows={4} />
          </label>
        ))}
      </div>

      {msg && <p className={msg.startsWith('Saved') || msg.startsWith('Resume') ? 'ok-text' : 'error-text'}>{msg}</p>}
      <button className="btn" onClick={save} disabled={busy}>Save profile</button>
    </div>
  );
}
