const express = require('express');
const router = express.Router();
const db = require('../db');
const { getDefaultProfile } = require('./profiles');

function resolveProfileId(req) {
  const raw = req.query?.profile_id ?? req.body?.profile_id;
  if (raw != null && raw !== '') return Number(raw);
  const p = getDefaultProfile();
  return p ? p.id : null;
}

// GET /api/applications — everything submitted for a profile, newest first.
router.get('/', (req, res) => {
  const profileId = resolveProfileId(req);
  const rows = profileId != null
    ? db.prepare(`
        SELECT id, profile_id, company, role_title, role_url, status, notes, qa_json, created_at
        FROM applications WHERE profile_id = ? ORDER BY created_at DESC
      `).all(profileId)
    : db.prepare(`
        SELECT id, profile_id, company, role_title, role_url, status, notes, qa_json, created_at
        FROM applications ORDER BY created_at DESC
      `).all();

  res.json(rows.map((r) => ({
    ...r,
    qa: r.qa_json ? (() => { try { return JSON.parse(r.qa_json); } catch { return []; } })() : [],
    qa_json: undefined,
  })));
});

// PATCH /api/applications/:id — track pipeline progress (Applied → Interviewing → …)
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM applications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const { status, notes } = req.body;
  const sets = [];
  const vals = [];
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });

  vals.push(req.params.id);
  db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id));
});

module.exports = router;
