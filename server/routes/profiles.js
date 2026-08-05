// Profiles: who is applying. Every queue row and application belongs to a
// profile. The apply scripts fetch the profile (with resume path) from here.
//
// Intake gating: a profile can be created incrementally, but the apply pipeline
// (POST /api/jobs/claim, claim-external) refuses to serve work for a profile
// until intake is complete — resume uploaded AND the work-authorization sanity
// questions answered. That check lives in isIntakeComplete(), exported for the
// jobs routes.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_RESUME_EXT = new Set(['.pdf', '.doc', '.docx']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `resume-${req.params.id}-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_RESUME_EXT.has(ext)) {
      return cb(new Error('resume must be a .pdf, .doc, or .docx file'));
    }
    cb(null, true);
  },
});

// Fields settable via POST / PUT. Everything else (resume_*, intake_completed_at,
// timestamps) is managed by dedicated endpoints.
const EDITABLE_FIELDS = [
  'first_name', 'last_name', 'preferred_name', 'email', 'phone',
  'linkedin', 'github', 'website',
  'city', 'state', 'country', 'zip', 'address_line1',
  'currently_employed', 'current_employer', 'current_title', 'years_of_experience',
  'school', 'degree', 'discipline', 'edu_start_year', 'edu_end_year',
  'work_authorized', 'needs_sponsorship', 'visa_status', 'sponsorship_note',
  'is_student', 'over_18', 'willing_to_relocate', 'no_noncompete', 'clean_record',
  'background', 'positioning', 'desired_compensation', 'start_availability', 'how_heard',
];

const BOOL_FIELDS = new Set([
  'currently_employed', 'work_authorized', 'needs_sponsorship', 'is_student',
  'over_18', 'willing_to_relocate', 'no_noncompete', 'clean_record',
]);

function coerce(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (BOOL_FIELDS.has(field)) return value === true || value === 1 || value === '1' ? 1 : 0;
  return String(value);
}

// The sanity questions that MUST be answered before any application is sent.
// visa_status is intentionally included: sponsorship "please explain" fields
// need it, and a wrong work-auth answer on an ATS form is unrecoverable.
const REQUIRED_INTAKE = ['first_name', 'last_name', 'email', 'work_authorized', 'needs_sponsorship', 'visa_status'];

function intakeStatus(profile) {
  const missing = REQUIRED_INTAKE.filter((f) => profile[f] === null || profile[f] === undefined || profile[f] === '');
  if (!profile.resume_path) missing.push('resume');
  else if (!fs.existsSync(profile.resume_path)) missing.push('resume (file missing on disk)');
  return { complete: missing.length === 0, missing };
}

function isIntakeComplete(profileId) {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  if (!p) return { complete: false, missing: ['profile'] };
  return intakeStatus(p);
}

function getDefaultProfile() {
  return db.prepare('SELECT * FROM profiles ORDER BY id ASC LIMIT 1').get() || null;
}

function serialize(p) {
  if (!p) return null;
  return { ...p, intake: intakeStatus(p) };
}

// GET /api/profiles — list all (id, name, intake state)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM profiles ORDER BY id ASC').all();
  res.json(rows.map(serialize));
});

// GET /api/profiles/default — the profile apply scripts use when none is named.
// 404 (not 200-with-null) so scripts fail loudly before touching a form.
router.get('/default', (req, res) => {
  const p = getDefaultProfile();
  if (!p) return res.status(404).json({ error: 'no_profile', hint: 'complete onboarding first' });
  res.json(serialize(p));
});

// POST /api/profiles — create (onboarding step 1). Body: any EDITABLE_FIELDS.
router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.first_name || !body.last_name || !body.email) {
    return res.status(400).json({ error: 'first_name, last_name, and email are required' });
  }
  const fields = [];
  const values = [];
  for (const f of EDITABLE_FIELDS) {
    const v = coerce(f, body[f]);
    if (v !== undefined) { fields.push(f); values.push(v); }
  }
  const result = db.prepare(
    `INSERT INTO profiles (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`
  ).run(...values);
  res.status(201).json(serialize(db.prepare('SELECT * FROM profiles WHERE id = ?').get(result.lastInsertRowid)));
});

// GET /api/profiles/:id
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json(serialize(p));
});

// PUT /api/profiles/:id — partial update of any editable fields.
router.put('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const sets = [];
  const values = [];
  for (const f of EDITABLE_FIELDS) {
    const v = coerce(f, body[f]);
    if (v !== undefined) { sets.push(`${f} = ?`); values.push(v); }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  values.push(req.params.id);
  db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  res.json(serialize(db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id)));
});

// POST /api/profiles/:id/resume — multipart upload, field name "resume".
// Replaces any previous resume (old file deleted).
router.post('/:id/resume', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });

  upload.single('resume')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file — send multipart field "resume"' });

    if (p.resume_path && p.resume_path !== req.file.path) {
      try { fs.unlinkSync(p.resume_path); } catch { /* already gone */ }
    }
    db.prepare(`
      UPDATE profiles
      SET resume_path = ?, resume_filename = ?, resume_uploaded_at = datetime('now')
      WHERE id = ?
    `).run(req.file.path, req.file.originalname, req.params.id);
    res.json(serialize(db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id)));
  });
});

// GET /api/profiles/:id/resume — download the stored resume.
router.get('/:id/resume', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!p || !p.resume_path || !fs.existsSync(p.resume_path)) {
    return res.status(404).json({ error: 'no_resume' });
  }
  res.download(p.resume_path, p.resume_filename || path.basename(p.resume_path));
});

// POST /api/profiles/:id/complete-intake — final onboarding step. Validates the
// sanity questions are answered and the resume exists, then stamps the profile.
router.post('/:id/complete-intake', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const status = intakeStatus(p);
  if (!status.complete) {
    return res.status(400).json({ error: 'intake_incomplete', missing: status.missing });
  }
  db.prepare("UPDATE profiles SET intake_completed_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json(serialize(db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id)));
});

module.exports = { router, isIntakeComplete, getDefaultProfile };
