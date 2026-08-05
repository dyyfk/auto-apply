import React, { useState } from 'react';
import { apiFetch } from '../api.js';

// First-run intake wizard. The apply pipeline is blocked server-side until
// this completes: resume uploaded + the work-authorization sanity questions
// answered. Wrong answers on ATS forms are unrecoverable, so we ask up front.

const STEPS = ['Basics', 'Resume', 'Work authorization', 'Background', 'Review'];

const VISA_OPTIONS = [
  ['citizen', 'U.S. citizen'],
  ['green_card', 'Permanent resident (green card)'],
  ['h1b', 'H-1B'],
  ['f1_opt', 'F-1 OPT / STEM OPT'],
  ['tn', 'TN'],
  ['o1', 'O-1'],
  ['other', 'Other'],
];

function YesNo({ label, value, onChange, help }) {
  return (
    <div>
      <div style={{ marginBottom: 4 }}>{label}</div>
      {help && <div className="muted small" style={{ marginBottom: 4 }}>{help}</div>}
      <div className="radio-group">
        <label><input type="radio" checked={value === 1} onChange={() => onChange(1)} /> Yes</label>
        <label><input type="radio" checked={value === 0} onChange={() => onChange(0)} /> No</label>
      </div>
    </div>
  );
}

export default function Onboarding({ profile, onDone }) {
  const [step, setStep] = useState(0);
  const [profileId, setProfileId] = useState(profile?.id ?? null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resumeName, setResumeName] = useState(profile?.resume_filename || null);
  const [form, setForm] = useState({
    first_name: profile?.first_name || '',
    last_name: profile?.last_name || '',
    preferred_name: profile?.preferred_name || '',
    email: profile?.email || '',
    phone: profile?.phone || '',
    linkedin: profile?.linkedin || '',
    github: profile?.github || '',
    website: profile?.website || '',
    city: profile?.city || '',
    state: profile?.state || '',
    country: profile?.country || 'United States',
    zip: profile?.zip || '',
    address_line1: profile?.address_line1 || '',
    work_authorized: profile?.work_authorized ?? null,
    needs_sponsorship: profile?.needs_sponsorship ?? null,
    visa_status: profile?.visa_status || '',
    sponsorship_note: profile?.sponsorship_note || '',
    currently_employed: profile?.currently_employed ?? 0,
    current_employer: profile?.current_employer || '',
    current_title: profile?.current_title || '',
    years_of_experience: profile?.years_of_experience || '',
    is_student: profile?.is_student ?? 0,
    over_18: profile?.over_18 ?? 1,
    willing_to_relocate: profile?.willing_to_relocate ?? 1,
    no_noncompete: profile?.no_noncompete ?? 1,
    clean_record: profile?.clean_record ?? null,
    school: profile?.school || '',
    degree: profile?.degree || '',
    discipline: profile?.discipline || '',
    edu_start_year: profile?.edu_start_year || '',
    edu_end_year: profile?.edu_end_year || '',
    background: profile?.background || '',
    positioning: profile?.positioning || '',
    desired_compensation: profile?.desired_compensation || '',
    start_availability: profile?.start_availability || 'Immediately',
    how_heard: profile?.how_heard || 'LinkedIn',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setV = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  async function saveProfile() {
    const body = JSON.stringify(form);
    const r = profileId
      ? await apiFetch(`/api/profiles/${profileId}`, { method: 'PUT', body })
      : await apiFetch('/api/profiles', { method: 'POST', body });
    if (!r.ok) throw new Error((await r.json()).error || 'save failed');
    const saved = await r.json();
    setProfileId(saved.id);
    return saved;
  }

  async function next() {
    setError(null);
    setBusy(true);
    try {
      if (step === 0) {
        if (!form.first_name || !form.last_name || !form.email) throw new Error('Name and email are required.');
        await saveProfile();
      } else if (step === 1) {
        if (!resumeName) throw new Error('Please upload your resume — the appliers attach it to every application.');
      } else if (step === 2) {
        if (form.work_authorized === null) throw new Error('Please answer the work-authorization question.');
        if (form.needs_sponsorship === null) throw new Error('Please answer the sponsorship question.');
        if (!form.visa_status) throw new Error('Please select your visa / citizenship status.');
        await saveProfile();
      } else if (step === 3) {
        await saveProfile();
      } else if (step === 4) {
        await saveProfile();
        const r = await apiFetch(`/api/profiles/${profileId}/complete-intake`, { method: 'POST' });
        if (!r.ok) {
          const d = await r.json();
          throw new Error('Intake incomplete: missing ' + (d.missing || []).join(', '));
        }
        onDone();
        return;
      }
      setStep((s) => s + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadResume(file) {
    setError(null);
    setBusy(true);
    try {
      let id = profileId;
      if (!id) { const saved = await saveProfile(); id = saved.id; }
      const fd = new FormData();
      fd.append('resume', file);
      const r = await apiFetch(`/api/profiles/${id}/resume`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error((await r.json()).error || 'upload failed');
      const saved = await r.json();
      setResumeName(saved.resume_filename);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <h1>Welcome — let's set up your profile</h1>
      <p className="muted">
        These answers fill every job application on your behalf, so accuracy matters more than speed.
        Nothing is submitted anywhere until you run the apply script yourself.
      </p>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={'step' + (i === step ? ' active' : i < step ? ' done' : '')}>{s}</div>
        ))}
      </div>

      <div className="card">
        {step === 0 && (
          <>
            <h2>Who are you?</h2>
            <div className="row">
              <label className="field"><span>First name *</span><input type="text" value={form.first_name} onChange={set('first_name')} /></label>
              <label className="field"><span>Last name *</span><input type="text" value={form.last_name} onChange={set('last_name')} /></label>
            </div>
            <div className="row">
              <label className="field"><span>Preferred name</span><input type="text" value={form.preferred_name} onChange={set('preferred_name')} /></label>
              <label className="field"><span>Email (used on applications) *</span><input type="email" value={form.email} onChange={set('email')} /></label>
            </div>
            <div className="row">
              <label className="field"><span>Phone</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
              <label className="field"><span>LinkedIn URL</span><input type="text" value={form.linkedin} onChange={set('linkedin')} /></label>
            </div>
            <div className="row">
              <label className="field"><span>GitHub URL</span><input type="text" value={form.github} onChange={set('github')} /></label>
              <label className="field"><span>Personal website</span><input type="text" value={form.website} onChange={set('website')} /></label>
            </div>
            <div className="row3">
              <label className="field"><span>City</span><input type="text" value={form.city} onChange={set('city')} /></label>
              <label className="field"><span>State</span><input type="text" value={form.state} onChange={set('state')} /></label>
              <label className="field"><span>Country</span><input type="text" value={form.country} onChange={set('country')} /></label>
            </div>
            <div className="row">
              <label className="field"><span>Street address (some forms require it)</span><input type="text" value={form.address_line1} onChange={set('address_line1')} /></label>
              <label className="field"><span>ZIP</span><input type="text" value={form.zip} onChange={set('zip')} /></label>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Upload your resume</h2>
            <p className="muted">PDF preferred (.pdf, .doc, .docx accepted, max 10 MB). This exact file is attached to every application.</p>
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={(e) => e.target.files[0] && uploadResume(e.target.files[0])}
            />
            {resumeName && <p className="ok-text">Uploaded: {resumeName}</p>}
          </>
        )}

        {step === 2 && (
          <>
            <h2>Work authorization — answer carefully</h2>
            <p className="muted">
              ATS forms ask these on nearly every application, and a wrong answer is unrecoverable
              (many companies allow only 1–3 applications per person, ever).
            </p>
            <YesNo
              label="Are you legally authorized to work in the country you're applying in? *"
              value={form.work_authorized}
              onChange={setV('work_authorized')}
            />
            <YesNo
              label="Will you now or in the future require visa sponsorship? *"
              value={form.needs_sponsorship}
              onChange={setV('needs_sponsorship')}
              help='Answer "Yes" if you will ever need the employer to sponsor a visa (e.g. H-1B transfer, OPT→H-1B).'
            />
            <label className="field">
              <span>Visa / citizenship status *</span>
              <select value={form.visa_status} onChange={set('visa_status')}>
                <option value="">Select…</option>
                {VISA_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Sponsorship explanation (used when forms ask "please explain your visa situation"; leave blank to auto-generate)</span>
              <textarea value={form.sponsorship_note} onChange={set('sponsorship_note')} placeholder='e.g. "I am on F-1 STEM OPT valid through June 2027 and will require H-1B sponsorship."' />
            </label>
            <YesNo label="Are you currently employed?" value={form.currently_employed} onChange={setV('currently_employed')} />
            <div className="row">
              <label className="field">
                <span>{form.currently_employed ? 'Current employer' : 'Most recent employer (include the end date, e.g. "Acme (until Jun 2026)")'}</span>
                <input type="text" value={form.current_employer} onChange={set('current_employer')} />
              </label>
              <label className="field"><span>Job title there</span><input type="text" value={form.current_title} onChange={set('current_title')} /></label>
            </div>
            <label className="field" style={{ maxWidth: 200 }}>
              <span>Years of experience</span>
              <input type="text" value={form.years_of_experience} onChange={set('years_of_experience')} placeholder="3" />
            </label>
            <YesNo label="Are you currently enrolled as a student?" value={form.is_student} onChange={setV('is_student')} />
            <YesNo label="Are you 18 or older?" value={form.over_18} onChange={setV('over_18')} />
            <YesNo
              label="Are you willing to relocate / work on-site or hybrid if asked?"
              value={form.willing_to_relocate}
              onChange={setV('willing_to_relocate')}
              help='Forms asking "are you willing to commute / work hybrid" are answered with this.'
            />
            <YesNo
              label="Are you free of non-compete or conflicting agreements?"
              value={form.no_noncompete}
              onChange={setV('no_noncompete')}
            />
            <YesNo
              label='Auto-answer "No" to criminal-history questions?'
              value={form.clean_record}
              onChange={setV('clean_record')}
              help='Choose "Yes" only if you have no convictions. Choose "No" to leave those questions blank for your manual review.'
            />
          </>
        )}

        {step === 3 && (
          <>
            <h2>Background</h2>
            <p className="muted">Used for education fields and "tell us about yourself / why us" questions.</p>
            <div className="row">
              <label className="field"><span>School (exact official name, e.g. "University of California, Los Angeles")</span><input type="text" value={form.school} onChange={set('school')} /></label>
              <label className="field">
                <span>Degree</span>
                <select value={form.degree} onChange={set('degree')}>
                  <option value="">Select…</option>
                  {["Bachelor's Degree", "Master's Degree", 'Doctorate', 'Associate Degree', 'High School'].map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </div>
            <div className="row3">
              <label className="field"><span>Field of study</span><input type="text" value={form.discipline} onChange={set('discipline')} placeholder="Computer Science" /></label>
              <label className="field"><span>Start year</span><input type="text" value={form.edu_start_year} onChange={set('edu_start_year')} placeholder="2019" /></label>
              <label className="field"><span>End year</span><input type="text" value={form.edu_end_year} onChange={set('edu_end_year')} placeholder="2023" /></label>
            </div>
            <label className="field">
              <span>Long background (for "tell us about yourself" — a solid paragraph about what you've built)</span>
              <textarea value={form.background} onChange={set('background')} rows={6} />
            </label>
            <label className="field">
              <span>Short positioning (for "why do you want to work here" — 3–4 sentences)</span>
              <textarea value={form.positioning} onChange={set('positioning')} rows={4} />
            </label>
            <div className="row3">
              <label className="field"><span>Desired compensation (text is fine)</span><input type="text" value={form.desired_compensation} onChange={set('desired_compensation')} placeholder="Open to discussion" /></label>
              <label className="field"><span>Start availability</span><input type="text" value={form.start_availability} onChange={set('start_availability')} /></label>
              <label className="field"><span>"How did you hear about us" answer</span><input type="text" value={form.how_heard} onChange={set('how_heard')} /></label>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>Review</h2>
            <table>
              <tbody>
                <tr><td className="muted">Name</td><td>{form.first_name} {form.last_name} ({form.email})</td></tr>
                <tr><td className="muted">Resume</td><td>{resumeName || <span className="error-text">missing</span>}</td></tr>
                <tr><td className="muted">Authorized to work</td><td>{form.work_authorized ? 'Yes' : 'No'}</td></tr>
                <tr><td className="muted">Needs sponsorship</td><td>{form.needs_sponsorship ? 'Yes' : 'No'}</td></tr>
                <tr><td className="muted">Visa status</td><td>{(VISA_OPTIONS.find(([v]) => v === form.visa_status) || ['', form.visa_status])[1]}</td></tr>
                <tr><td className="muted">Employment</td><td>{form.currently_employed ? `Employed at ${form.current_employer}` : `Not currently employed (last: ${form.current_employer || '—'})`}</td></tr>
                <tr><td className="muted">Education</td><td>{form.school} — {form.degree} {form.discipline}</td></tr>
              </tbody>
            </table>
            <p className="muted small" style={{ marginTop: 12 }}>
              Demographic and EEO survey questions are never auto-answered (the appliers always pick
              "decline to answer" or leave them blank).
            </p>
          </>
        )}

        {error && <div className="error-text">{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {step > 0 && <button className="btn secondary" onClick={() => setStep((s) => s - 1)} disabled={busy}>Back</button>}
          <button className="btn" onClick={next} disabled={busy}>
            {step === STEPS.length - 1 ? 'Finish setup' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
