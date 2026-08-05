// Job queue + claim protocol. Ported from the original pipeline with the
// dedup/fence semantics intact, scoped per profile.
//
// Life of a role:
//   scout POST /bulk        → pending row (dedup + squatter-resurrection rules)
//   agent POST /claim       → in_progress + claim_token (atomic, one winner)
//   agent PATCH {submitted:true, claim_token}   ← immediately BEFORE the click
//   agent PATCH {status:'done'|'failed', claim_token}
//   'done' (or any terminal state with submission evidence) mirrors into
//   `applications` via DB triggers — the permanent dedup surface.
//
// Externally-driven applies (hand-curated batches) use POST /claim-external:
// the same fences, atomically claim-or-create.
//
// Why this much machinery: many ATS tenants allow 1-3 applications per
// applicant EVER. A duplicate submission burns a cap slot permanently, so every
// ambiguous state fails CLOSED (block) rather than open (re-apply).

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { isIntakeComplete, getDefaultProfile } = require('./profiles');

// 90 min: enough for slow Ashby flows + a Greenhouse security-code roundtrip.
// Shorter windows raced real apply sessions and re-pended rows mid-flight.
const STALE_MINUTES = 90;

// ── Profile resolution ──────────────────────────────────────────────────────
// Every endpoint operates on one profile. Callers pass profile_id (body or
// query); a single-profile deployment can omit it.
function resolveProfileId(req) {
  const raw = req.body?.profile_id ?? req.query?.profile_id;
  if (raw != null && raw !== '') {
    const id = Number(raw);
    return db.prepare('SELECT id FROM profiles WHERE id = ?').get(id) ? id : null;
  }
  const p = getDefaultProfile();
  return p ? p.id : null;
}

// ── Pause flag ──────────────────────────────────────────────────────────────
function isPaused() {
  const row = db.prepare("SELECT value FROM app_state WHERE key = 'paused'").get();
  return row?.value === '1';
}
function setPaused(value) {
  db.prepare(
    "INSERT INTO app_state (key, value) VALUES ('paused', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(value ? '1' : '0');
}

router.get('/paused', (req, res) => {
  const inProgress = db.prepare(
    "SELECT id, profile_id, company, role_title, claimed_by FROM job_queue WHERE status = 'in_progress'"
  ).all();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'pending'").get().n;
  res.json({ paused: isPaused(), in_progress: inProgress, pending });
});

router.post('/pause', (req, res) => {
  setPaused(true);
  res.json({ paused: true, message: 'Paused. Apply sessions stop after their current role.' });
});

router.post('/resume', (req, res) => {
  setPaused(false);
  res.json({ paused: false });
});

// ── Stale-claim release ─────────────────────────────────────────────────────
// Split by submitted_at: a stale claim whose form was already submitted must
// NEVER re-pend — that hands the role to another session for a second
// submission. Those park as failed for human review.
function releaseStale() {
  db.prepare(`
    UPDATE job_queue
    SET status = 'failed', skip_class = 'permanent',
        error = COALESCE(error, '') || ' [stale claim after submit — parked for review]'
    WHERE status = 'in_progress'
      AND submitted_at IS NOT NULL
      AND claimed_at < datetime('now', '-${STALE_MINUTES} minutes')
  `).run();
  db.prepare(`
    UPDATE job_queue
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_token = NULL
    WHERE status = 'in_progress'
      AND submitted_at IS NULL
      AND claimed_at < datetime('now', '-${STALE_MINUTES} minutes')
  `).run();
}

// GET /api/jobs — queue for a profile (all profiles when none resolvable)
router.get('/', (req, res) => {
  releaseStale();
  const profileId = resolveProfileId(req);
  const { status } = req.query;
  const clauses = [];
  const params = [];
  if (profileId != null) { clauses.push('profile_id = ?'); params.push(profileId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(db.prepare(
    `SELECT * FROM job_queue ${where} ORDER BY priority DESC, created_at ASC`
  ).all(...params));
});

const ALLOWED_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'skipped'];

// ── Dedup predicates ────────────────────────────────────────────────────────
// Two signals, OR'd: same canonical URL (strongest) or same normalized
// (company, role) pair (covers re-posts of the same role under another URL).
// Any row with submitted_at blocks regardless of status — a submit click that
// timed out before the confirmation page still really submitted.
function findExistingInQueue(profileId, companyKey, roleKey, roleUrlKey) {
  return db.prepare(`
    SELECT id FROM job_queue
    WHERE profile_id = ?
      AND (status IN ('pending','in_progress','done') OR submitted_at IS NOT NULL)
      AND ((company_key = ? AND role_key = ?) OR (? IS NOT NULL AND role_url_key = ?))
    LIMIT 1
  `).get(profileId, companyKey, roleKey, roleUrlKey, roleUrlKey);
}

function findExistingInApplications(profileId, companyKey, roleKey, roleUrlKey) {
  return db.prepare(`
    SELECT id FROM applications
    WHERE profile_id = ?
      AND ((company_key = ? AND role_key = ?) OR (? IS NOT NULL AND role_url_key = ?))
    LIMIT 1
  `).get(profileId, companyKey, roleKey, roleUrlKey, roleUrlKey);
}

// A terminal skipped/failed row still owns its UNIQUE index slots, so a blind
// INSERT of the re-scouted role would throw. Look the squatter up explicitly
// so the insert path can decide: resurrect it, or skip the candidate.
function findSquatter(profileId, companyKey, roleKey, roleUrlKey) {
  return db.prepare(`
    SELECT * FROM job_queue
    WHERE profile_id = ?
      AND ((company_key = ? AND role_key = ?) OR (? IS NOT NULL AND role_url_key = ?))
    LIMIT 1
  `).get(profileId, companyKey, roleKey, roleUrlKey, roleUrlKey);
}

// A squatter may re-enter the queue only when it was never submitted AND its
// skip taxonomy says the block was temporary.
function canResurrect(row) {
  if (row.submitted_at) return false;
  if (row.status !== 'skipped' && row.status !== 'failed') return false;
  if (row.skip_class === 'transient') return true;
  if (row.skip_class === 'conditional' && row.reopen_after) {
    const now = db.prepare("SELECT datetime('now') AS t").get().t;
    return row.reopen_after <= now;
  }
  return false;
}

// Flip a squatter back to pending in place (keeps the UNIQUE slots — no
// delete+reinsert). Refreshes the posting URL unless another row owns it.
function resurrectRow(row, candidate) {
  const urlOwner = candidate.role_url_key
    ? db.prepare('SELECT id FROM job_queue WHERE profile_id = ? AND role_url_key = ? AND id != ?')
        .get(row.profile_id, candidate.role_url_key, row.id)
    : null;
  db.prepare(`
    UPDATE job_queue
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
        error = NULL, skip_class = NULL, reopen_after = NULL,
        priority = MAX(COALESCE(priority, 0), ?),
        role_url = CASE WHEN ? THEN role_url ELSE COALESCE(?, role_url) END,
        role_url_key = CASE WHEN ? THEN role_url_key ELSE COALESCE(?, role_url_key) END,
        notes = COALESCE(notes, '') || ' [re-scouted ' || date('now') || ']',
        created_at = datetime('now')
    WHERE id = ?
  `).run(
    candidate.priority ?? 0,
    urlOwner ? 1 : 0, candidate.role_url || null,
    urlOwner ? 1 : 0, candidate.role_url_key || null,
    row.id
  );
}

function isBlockedCompany(profileId, companyKey) {
  return !!db.prepare(
    "SELECT 1 FROM company_policy WHERE profile_id = ? AND company_key = ? AND policy = 'blocked'"
  ).get(profileId, companyKey);
}

// ── Inserts ─────────────────────────────────────────────────────────────────

// POST /api/jobs — add one role. Body: { profile_id?, company, role_title, role_url?, ats?, priority?, notes? }
router.post('/', (req, res) => {
  const { company, role_title, role_url, ats, priority, notes } = req.body;
  if (!company || !role_title) {
    return res.status(400).json({ error: 'company and role_title are required' });
  }
  const profileId = resolveProfileId(req);
  if (profileId == null) return res.status(400).json({ error: 'no_profile' });

  const company_key = db.lookupCompanyKey(company);
  const role_key = db.normalizeKey(role_title);
  const role_url_key = db.normalizeUrl(role_url);

  if (isBlockedCompany(profileId, company_key)) {
    return res.status(409).json({ error: 'company_blocked' });
  }

  let result;
  let resurrectedId = null;
  // BEGIN IMMEDIATE takes the write lock upfront so check+insert is atomic.
  db.exec('BEGIN IMMEDIATE');
  try {
    const inQueue = findExistingInQueue(profileId, company_key, role_key, role_url_key);
    if (inQueue) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'duplicate', existing_id: inQueue.id });
    }
    const applied = findExistingInApplications(profileId, company_key, role_key, role_url_key);
    if (applied) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'already_applied', application_id: applied.id });
    }
    const squatter = findSquatter(profileId, company_key, role_key, role_url_key);
    if (squatter) {
      if (canResurrect(squatter)) {
        resurrectRow(squatter, { role_url, role_url_key, priority });
        resurrectedId = squatter.id;
        db.exec('COMMIT');
      } else {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: 'duplicate', existing_id: squatter.id, skipped_as: squatter.skip_class });
      }
    } else {
      result = db.prepare(`
        INSERT INTO job_queue (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, ats, priority, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(profileId, company, role_title, company_key, role_key, role_url || null, role_url_key, ats || null, priority ?? 0, notes || null);
      db.exec('COMMIT');
    }
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (resurrectedId) {
    return res.json({ resurrected: true, job: db.prepare('SELECT * FROM job_queue WHERE id = ?').get(resurrectedId) });
  }
  res.status(201).json(db.prepare('SELECT * FROM job_queue WHERE id = ?').get(result.lastInsertRowid));
});

// POST /api/jobs/bulk — scouts push candidate batches here.
// Body: { profile_id?, jobs: [{ company, role_title, role_url?, ats?, priority?, notes? }] }
// (a bare array is also accepted for backwards compatibility)
router.post('/bulk', (req, res) => {
  const jobs = Array.isArray(req.body) ? req.body : req.body?.jobs;
  if (!Array.isArray(jobs) || !jobs.length) {
    return res.status(400).json({ error: 'jobs must be a non-empty array' });
  }
  const profileId = resolveProfileId(req);
  if (profileId == null) return res.status(400).json({ error: 'no_profile' });

  const insert = db.prepare(`
    INSERT INTO job_queue (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, ats, priority, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0, resurrected = 0, skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { company, role_title, role_url, ats, priority, notes } of jobs) {
      if (!company || !role_title) continue;
      const company_key = db.lookupCompanyKey(company);
      const role_key = db.normalizeKey(role_title);
      const role_url_key = db.normalizeUrl(role_url);
      if (isBlockedCompany(profileId, company_key)
          || findExistingInApplications(profileId, company_key, role_key, role_url_key)
          || findExistingInQueue(profileId, company_key, role_key, role_url_key)) {
        skipped++;
        continue;
      }
      const squatter = findSquatter(profileId, company_key, role_key, role_url_key);
      if (squatter) {
        if (canResurrect(squatter)) { resurrectRow(squatter, { role_url, role_url_key, priority }); resurrected++; }
        else skipped++;
        continue;
      }
      try {
        insert.run(profileId, company, role_title, company_key, role_key, role_url || null, role_url_key, ats || null, priority ?? 0, notes || null);
        added++;
      } catch (e) {
        // findSquatter covers both UNIQUE indexes, so a constraint hit here is a
        // same-batch duplicate (two candidates normalizing to the same key).
        if (e && e.errcode === 2067 /* SQLITE_CONSTRAINT_UNIQUE */) { skipped++; continue; }
        throw e;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({ added, resurrected, skipped, total: jobs.length });
});

// ── Applied check ───────────────────────────────────────────────────────────
// GET /api/jobs/applied?url=...&company=...&role_title=...&profile_id=...
// Defense-in-depth check the apply script runs before touching a form AND
// immediately before clicking Submit. Fail closed on the caller side: if this
// endpoint is unreachable, do not submit.
router.get('/applied', (req, res) => {
  const { url, company, role_title } = req.query;
  const profileId = resolveProfileId(req);
  if (profileId == null) return res.status(400).json({ error: 'no_profile' });

  const role_url_key = db.normalizeUrl(url || null);
  const company_key = company ? db.lookupCompanyKey(company) : null;
  const role_key = role_title ? db.normalizeKey(role_title) : null;

  if (!role_url_key && !(company_key && role_key)) {
    return res.status(400).json({ error: 'pass url, or company+role_title' });
  }

  const appHit = db.prepare(`
    SELECT id, company, role_title FROM applications
    WHERE profile_id = ?
      AND ((? IS NOT NULL AND role_url_key = ?)
        OR (? IS NOT NULL AND ? IS NOT NULL AND company_key = ? AND role_key = ?))
    LIMIT 1
  `).get(profileId, role_url_key, role_url_key, company_key, role_key, company_key, role_key);
  if (appHit) return res.json({ applied: true, source: 'applications', ...appHit });

  // Covers the window between "form submitted" and "PATCH status=done".
  const jqHit = db.prepare(`
    SELECT id, company, role_title, status, submitted_at FROM job_queue
    WHERE profile_id = ? AND submitted_at IS NOT NULL
      AND ((? IS NOT NULL AND role_url_key = ?)
        OR (? IS NOT NULL AND ? IS NOT NULL AND company_key = ? AND role_key = ?))
    LIMIT 1
  `).get(profileId, role_url_key, role_url_key, company_key, role_key, company_key, role_key);
  if (jqHit) return res.json({ applied: true, source: 'job_queue_submitted', ...jqHit });

  res.json({ applied: false });
});

// ── Claiming ────────────────────────────────────────────────────────────────

function requireIntake(profileId, res) {
  const status = isIntakeComplete(profileId);
  if (!status.complete) {
    res.status(412).json({
      error: 'intake_incomplete',
      missing: status.missing,
      hint: 'Finish onboarding (resume upload + work-authorization questions) before applying.',
    });
    return false;
  }
  return true;
}

// POST /api/jobs/claim — atomically grab the next pending role.
// Body: { session_id, profile_id? } → job (with claim_token) or 204 when empty/paused.
router.post('/claim', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  const profileId = resolveProfileId(req);
  if (profileId == null) return res.status(400).json({ error: 'no_profile' });
  if (!requireIntake(profileId, res)) return;

  if (isPaused()) return res.status(204).end();
  releaseStale();

  const claim_token = crypto.randomUUID();

  db.exec('BEGIN IMMEDIATE');
  let job = null;
  try {
    // Eligibility is enforced HERE, not in agent prompts (prompt-encoded policy
    // drifts under long unattended runs):
    //   - submitted_at IS NULL: a submitted row is never served again
    //   - company_policy: blocked never; cooldown held until reopen_after
    //   - velocity cap: max 5 submissions per company per rolling 24h
    //   - lifetime ceiling: max 10 applications per company
    const next = db.prepare(`
      SELECT id FROM job_queue jq
      WHERE profile_id = ?
        AND status = 'pending'
        AND submitted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM company_policy p
          WHERE p.profile_id = jq.profile_id AND p.company_key = jq.company_key
            AND (p.policy = 'blocked' OR p.reopen_after IS NULL OR p.reopen_after > datetime('now'))
        )
        AND (
          SELECT COUNT(*) FROM applications a
          WHERE a.profile_id = jq.profile_id AND a.company_key = jq.company_key
            AND a.created_at > datetime('now', '-1 day')
        ) < 5
        AND (
          SELECT COUNT(*) FROM applications a2
          WHERE a2.profile_id = jq.profile_id AND a2.company_key = jq.company_key
        ) < 10
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get(profileId);
    if (next) {
      db.prepare(`
        UPDATE job_queue
        SET status = 'in_progress', claimed_by = ?, claimed_at = datetime('now'), claim_token = ?
        WHERE id = ? AND status = 'pending'
      `).run(session_id, claim_token, next.id);
      job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(next.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (!job || job.status !== 'in_progress') return res.status(204).end();
  res.json(job);
});

// POST /api/jobs/claim-external — atomic claim-or-create for externally-driven
// applies (hand-curated batches). Same fences as queue claims.
// Body: { profile_id?, company, role_title, role_url?, ats?, session_id?, notes? }
router.post('/claim-external', (req, res) => {
  const { company, role_title, role_url, ats, session_id, notes } = req.body;
  if (!company || !role_title) {
    return res.status(400).json({ error: 'company and role_title are required' });
  }
  const profileId = resolveProfileId(req);
  if (profileId == null) return res.status(400).json({ error: 'no_profile' });
  if (!requireIntake(profileId, res)) return;

  const company_key = db.lookupCompanyKey(company);
  const role_key = db.normalizeKey(role_title);
  const role_url_key = db.normalizeUrl(role_url);
  const claim_token = crypto.randomUUID();
  const claimer = session_id || 'external';

  let jobId;
  let reclaimedFrom = null;
  let skippedAs = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const applied = findExistingInApplications(profileId, company_key, role_key, role_url_key);
    if (applied) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'already_applied', application_id: applied.id });
    }
    const existing = findSquatter(profileId, company_key, role_key, role_url_key);
    if (existing) {
      if (existing.status === 'in_progress') {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: 'in_flight', existing_id: existing.id, claimed_by: existing.claimed_by });
      }
      if (existing.status === 'done' || existing.submitted_at) {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: 'already_terminal', existing_id: existing.id, current_status: existing.status });
      }
      // pending, or terminal skipped/failed without submission evidence: claim
      // it. A curated batch deliberately re-attempting a skip overrides the
      // taxonomy — surface what it overrode so the runner logs it.
      reclaimedFrom = existing.status;
      skippedAs = existing.skip_class || null;
      db.prepare(`
        UPDATE job_queue
        SET status = 'in_progress', claimed_by = ?, claimed_at = datetime('now'), claim_token = ?,
            error = NULL, skip_class = NULL, reopen_after = NULL,
            role_url = COALESCE(role_url, ?), role_url_key = COALESCE(role_url_key, ?),
            ats = COALESCE(?, ats), notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(claimer, claim_token, role_url || null, role_url_key, ats || null, notes || null, existing.id);
      jobId = existing.id;
    } else {
      const r = db.prepare(`
        INSERT INTO job_queue
          (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, ats, notes,
           status, claimed_by, claimed_at, claim_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, datetime('now'), ?)
      `).run(
        profileId, company, role_title, company_key, role_key, role_url || null, role_url_key,
        ats || null, notes || null, claimer, claim_token
      );
      jobId = r.lastInsertRowid;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (e && e.errcode === 2067) {
      return res.status(409).json({ error: 'conflict', detail: 'unique index collision with an existing row' });
    }
    throw e;
  }

  const body = { job: db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId) };
  if (reclaimedFrom) { body.reclaimed_from = reclaimedFrom; body.skipped_as = skippedAs; }
  res.json(body);
});

// POST /api/jobs/record-external — bookkeeping for a submission that ALREADY
// happened outside the live claim flow (manual applies, imports). Refuses rows
// other actors own. Live applies must use claim-external + PATCH instead.
router.post('/record-external', (req, res) => {
  const { company, role_title, role_url, ats, status, qa_json, error, notes } = req.body;
  if (!company || !role_title) {
    return res.status(400).json({ error: 'company and role_title are required' });
  }
  if (status !== 'done' && status !== 'failed') {
    return res.status(400).json({ error: "status must be 'done' or 'failed'" });
  }
  const profileId = resolveProfileId(req);
  if (profileId == null) return res.status(400).json({ error: 'no_profile' });

  const submitted = req.body.submitted ?? (status === 'done');
  const company_key = db.lookupCompanyKey(company);
  const role_key = db.normalizeKey(role_title);
  const role_url_key = db.normalizeUrl(role_url);

  let jobId;
  let existed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = findSquatter(profileId, company_key, role_key, role_url_key);
    if (existing) {
      if (existing.status === 'in_progress') {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: 'in_flight', existing_id: existing.id, claimed_by: existing.claimed_by });
      }
      if (existing.status === 'done' || existing.submitted_at) {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: 'already_terminal', existing_id: existing.id, current_status: existing.status });
      }
      existed = true;
      jobId = existing.id;
      db.prepare(`
        UPDATE job_queue
        SET status = ?, notes = COALESCE(?, notes), error = COALESCE(?, error),
            qa_json = COALESCE(?, qa_json), ats = COALESCE(?, ats),
            role_url = COALESCE(role_url, ?), role_url_key = COALESCE(role_url_key, ?),
            skip_class = NULL, reopen_after = NULL, claimed_by = NULL, claim_token = NULL,
            submitted_at = CASE WHEN ? = 1 THEN COALESCE(submitted_at, datetime('now')) ELSE submitted_at END,
            completed_at = datetime('now')
        WHERE id = ?
      `).run(
        status, notes || null, error || null,
        qa_json ? JSON.stringify(qa_json) : null, ats || null,
        role_url || null, role_url_key,
        submitted ? 1 : 0,
        existing.id
      );
    } else {
      const r = db.prepare(`
        INSERT INTO job_queue
          (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, ats,
           status, notes, error, qa_json, submitted_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
      `).run(
        profileId, company, role_title, company_key, role_key, role_url || null, role_url_key,
        ats || null, status, notes || null, error || null,
        qa_json ? JSON.stringify(qa_json) : null,
        submitted ? 1 : 0
      );
      jobId = r.lastInsertRowid;
    }
    // DB triggers mirror terminal done/submitted rows into applications.
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (e && e.errcode === 2067) {
      return res.status(409).json({ error: 'conflict', detail: 'unique index collision with an existing row' });
    }
    throw e;
  }

  res.json({ job: db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId), existed });
});

// ── Terminal PATCH ──────────────────────────────────────────────────────────
// Body: { status?, notes?, error?, qa_json?, claim_token?, submitted?, skip_class?, reopen_after? }
// Idempotency rules:
//   - terminal → terminal is rejected (409 already_terminal)
//   - if the row carries a claim_token, any state-changing PATCH must present
//     the matching token (409 stale_claim otherwise) — fail closed
router.patch('/:id', (req, res) => {
  const { status, notes, error, qa_json, claim_token, submitted, skip_class, reopen_after } = req.body;
  const terminal = status === 'done' || status === 'failed' || status === 'skipped';

  if (status && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', allowed: ALLOWED_STATUSES });
  }
  if (skip_class && !['permanent', 'conditional', 'transient'].includes(skip_class)) {
    return res.status(400).json({ error: 'invalid_skip_class' });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const job = db.prepare('SELECT * FROM job_queue WHERE id = ?').get(req.params.id);
    if (!job) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }

    const wasTerminal = ['done', 'failed', 'skipped'].includes(job.status);
    if (wasTerminal && terminal) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'already_terminal', current_status: job.status });
    }

    // The fence guards anything that changes apply-side state: terminal
    // transitions and BOTH submitted flips (submitted:false erases real
    // submission evidence, so it needs the fence most of all).
    const needsFence = terminal || submitted === true || submitted === false;
    if (needsFence && job.claim_token && job.claim_token !== claim_token) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'stale_claim' });
    }

    // Skip taxonomy: explicit skip_class wins; otherwise classify from the
    // CURRENT reason only (row history poisons the result), falling back to row
    // text only when this PATCH carries no reason of its own.
    let effSkipClass = null;
    let effReopen = null;
    if (status === 'skipped' || status === 'failed') {
      if (skip_class) {
        effSkipClass = skip_class;
        effReopen = reopen_after || null;
      } else {
        const currentReason = [notes, error].filter(Boolean).join(' | ');
        const auto = db.classifySkip(currentReason || [job.notes, job.error].filter(Boolean).join(' | '));
        effSkipClass = auto.skip_class;
        effReopen = auto.reopen_after;
      }
    }

    db.prepare(`
      UPDATE job_queue
      SET
        status       = COALESCE(?, status),
        notes        = COALESCE(?, notes),
        error        = COALESCE(?, error),
        qa_json      = COALESCE(?, qa_json),
        skip_class   = COALESCE(?, skip_class),
        reopen_after = COALESCE(?, reopen_after),
        submitted_at = CASE
          WHEN ? = 1 THEN COALESCE(submitted_at, datetime('now'))
          WHEN ? = 1 THEN NULL
          ELSE submitted_at
        END,
        completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END
      WHERE id = ?
    `).run(
      status || null,
      notes || null,
      error || null,
      qa_json ? JSON.stringify(qa_json) : null,
      effSkipClass,
      effReopen,
      submitted === true ? 1 : 0,
      submitted === false ? 1 : 0,
      terminal ? 1 : 0,
      job.id
    );

    if (status === 'done') {
      // Honor both UNIQUE indexes on applications: upsert against
      // (profile_id, company_key, role_key), pre-check the URL index.
      const urlExists = job.role_url_key
        ? db.prepare('SELECT id FROM applications WHERE profile_id = ? AND role_url_key = ?')
            .get(job.profile_id, job.role_url_key)
        : null;
      if (!urlExists) {
        db.prepare(`
          INSERT INTO applications (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, status, qa_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Applied', ?)
          ON CONFLICT(profile_id, company_key, role_key) DO UPDATE
            SET qa_json = COALESCE(excluded.qa_json, applications.qa_json)
        `).run(
          job.profile_id, job.company, job.role_title, job.company_key, job.role_key,
          job.role_url || null, job.role_url_key || null,
          qa_json ? JSON.stringify(qa_json) : null
        );
      } else if (qa_json) {
        db.prepare('UPDATE applications SET qa_json = COALESCE(?, qa_json) WHERE id = ?')
          .run(JSON.stringify(qa_json), urlExists.id);
      }
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json(db.prepare('SELECT * FROM job_queue WHERE id = ?').get(req.params.id));
});

// ── Deletion (with submission-evidence reconciliation) ──────────────────────
// A pruned queue row must never take the only record of a real submission with
// it — mirror submitted/done rows into applications before deleting.
function reconcileBeforeDelete(whereSql, params) {
  db.prepare(`
    INSERT OR IGNORE INTO applications
      (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, status, qa_json)
    SELECT profile_id, company, role_title, company_key, role_key, role_url, role_url_key, 'Applied', qa_json
    FROM job_queue
    WHERE (status = 'done' OR submitted_at IS NOT NULL)
      AND ${whereSql}
  `).run(...params);
}

router.delete('/:id', (req, res) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    reconcileBeforeDelete('id = ?', [req.params.id]);
    db.prepare('DELETE FROM job_queue WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ success: true });
});

// DELETE /api/jobs — clear terminal rows (per profile when profile_id given)
router.delete('/', (req, res) => {
  const profileId = resolveProfileId(req);
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    const where = profileId != null
      ? "status IN ('done','failed','skipped') AND profile_id = " + Number(profileId)
      : "status IN ('done','failed','skipped')";
    reconcileBeforeDelete(where, []);
    result = db.prepare(`DELETE FROM job_queue WHERE ${where}`).run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ deleted: result.changes });
});

module.exports = router;
