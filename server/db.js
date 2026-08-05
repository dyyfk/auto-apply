// SQLite via Node's built-in node:sqlite (Node 22+). Single file, WAL mode.
//
// Dedup design (inherited from the original pipeline, generalized per-profile):
// every role gets normalized keys —
//   company_key  : lowercase alnum of company name, routed through company_alias
//   role_key     : lowercase alnum of role title
//   role_url_key : canonicalized ATS URL (host+path, form-page suffix stripped,
//                  identifying query params only)
// UNIQUE indexes on (profile_id, company_key, role_key) and
// (profile_id, role_url_key) make double-inserts impossible even when the
// application-layer checks are raced. Claim tokens stop concurrent apply
// sessions from clobbering each other's terminal states.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'auto_apply.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- identity
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    preferred_name TEXT,
    email TEXT NOT NULL,
    phone TEXT,

    -- links
    linkedin TEXT,
    github TEXT,
    website TEXT,

    -- location
    city TEXT,
    state TEXT,
    country TEXT DEFAULT 'United States',
    zip TEXT,
    address_line1 TEXT,

    -- employment
    currently_employed INTEGER DEFAULT 0,
    current_employer TEXT,
    current_title TEXT,
    years_of_experience TEXT,

    -- education
    school TEXT,
    degree TEXT,
    discipline TEXT,
    edu_start_year TEXT,
    edu_end_year TEXT,

    -- work authorization (the "sanity questions" — asked at first onboarding)
    work_authorized INTEGER,            -- legally authorized to work in target country
    needs_sponsorship INTEGER,          -- requires sponsorship now or in the future
    visa_status TEXT,                   -- 'citizen'|'green_card'|'h1b'|'f1_opt'|'tn'|'o1'|'other'
    sponsorship_note TEXT,              -- free-text explanation used for "please explain" fields
    is_student INTEGER DEFAULT 0,
    over_18 INTEGER DEFAULT 1,
    willing_to_relocate INTEGER DEFAULT 1,
    no_noncompete INTEGER DEFAULT 1,    -- not bound by a non-compete / conflicting agreement
    clean_record INTEGER,               -- no felony convictions; NULL = never auto-answer

    -- application content
    background TEXT,                    -- long "tell us about yourself" answer
    positioning TEXT,                   -- short "why us" paragraph
    desired_compensation TEXT,
    start_availability TEXT DEFAULT 'Immediately',
    how_heard TEXT DEFAULT 'LinkedIn',

    -- resume
    resume_path TEXT,
    resume_filename TEXT,
    resume_uploaded_at DATETIME,

    intake_completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TRIGGER IF NOT EXISTS profiles_updated_at
    AFTER UPDATE ON profiles
    BEGIN
      UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

  -- Company-name aliases for dedup ("Sierra" vs "Sierra AI" → same key).
  CREATE TABLE IF NOT EXISTS company_alias (
    raw_key       TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL
  );

  -- The work queue. Scouts insert candidates; apply sessions claim rows.
  CREATE TABLE IF NOT EXISTS job_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    role_title TEXT NOT NULL,
    role_url TEXT,
    company_key TEXT NOT NULL,
    role_key TEXT NOT NULL,
    role_url_key TEXT,
    ats TEXT,
    priority INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',      -- pending|in_progress|done|failed|skipped
    claimed_by TEXT,
    claimed_at DATETIME,
    claim_token TEXT,
    submitted_at DATETIME,              -- set immediately BEFORE the submit click
    completed_at DATETIME,
    skip_class TEXT,                    -- permanent|conditional|transient
    reopen_after DATETIME,
    error TEXT,
    notes TEXT,
    qa_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_unique_key
    ON job_queue(profile_id, company_key, role_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_unique_url
    ON job_queue(profile_id, role_url_key) WHERE role_url_key IS NOT NULL;

  -- Source of truth for what was actually submitted. Queue rows come and go;
  -- rows here are permanent evidence and the strongest dedup surface.
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    role_title TEXT NOT NULL,
    role_url TEXT,
    company_key TEXT NOT NULL,
    role_key TEXT NOT NULL,
    role_url_key TEXT,
    status TEXT DEFAULT 'Applied',      -- Applied|Interviewing|Offer|Rejected|...
    notes TEXT,
    qa_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_unique_key
    ON applications(profile_id, company_key, role_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_unique_url
    ON applications(profile_id, role_url_key) WHERE role_url_key IS NOT NULL;

  -- Per-profile apply policy. 'blocked' = never claim; 'cooldown' = hold until
  -- reopen_after (NULL = hold indefinitely). Used for companies with
  -- per-applicant ATS submission caps or active interview loops.
  CREATE TABLE IF NOT EXISTS company_policy (
    profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    company_key  TEXT NOT NULL,
    policy       TEXT NOT NULL CHECK (policy IN ('blocked','cooldown')),
    reopen_after DATETIME,
    reason       TEXT,
    PRIMARY KEY (profile_id, company_key)
  );

  -- App-level flags that must survive restarts (e.g. 'paused').
  CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Generic aliases that surfaced from real dedup misses. Add here when a new
// company appears under two names.
const SEED_ALIASES = [
  ['sierraai', 'sierra'],
  ['blandai', 'bland'],
  ['mistralai', 'mistral'],
  ['modallabs', 'modal'],
  ['axiomco', 'axiom'],
  ['convexdev', 'convex'],
  ['perplexityai', 'perplexity'],
  ['togetherai', 'together'],
];
{
  const ins = db.prepare('INSERT OR IGNORE INTO company_alias (raw_key, canonical_key) VALUES (?, ?)');
  for (const [raw, canon] of SEED_ALIASES) ins.run(raw, canon);
}

// ── Sync triggers: job_queue → applications ─────────────────────────────────
// Enforced in the database so EVERY writer hits the mirror, not just one code
// path. TERMINAL ONLY: must not fire on the pre-click submitted_at PATCH — if
// the click then never happens, a phantom 'Applied' row would permanently block
// a never-submitted role. The pre-click window is covered by GET /applied's
// job_queue submitted_at branch.
db.exec('DROP TRIGGER IF EXISTS trg_jq_submit_sync_upd');
db.exec('DROP TRIGGER IF EXISTS trg_jq_submit_sync_ins');
db.exec(`
  CREATE TRIGGER trg_jq_submit_sync_upd
  AFTER UPDATE OF status, submitted_at ON job_queue
  WHEN NEW.status IN ('done','failed','skipped')
    AND (NEW.status = 'done' OR NEW.submitted_at IS NOT NULL)
  BEGIN
    INSERT OR IGNORE INTO applications
      (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, status, qa_json)
    VALUES
      (NEW.profile_id, NEW.company, NEW.role_title, NEW.company_key, NEW.role_key, NEW.role_url, NEW.role_url_key, 'Applied', NEW.qa_json);
  END;
`);
db.exec(`
  CREATE TRIGGER trg_jq_submit_sync_ins
  AFTER INSERT ON job_queue
  WHEN NEW.status IN ('done','failed','skipped')
    AND (NEW.status = 'done' OR NEW.submitted_at IS NOT NULL)
  BEGIN
    INSERT OR IGNORE INTO applications
      (profile_id, company, role_title, company_key, role_key, role_url, role_url_key, status, qa_json)
    VALUES
      (NEW.profile_id, NEW.company, NEW.role_title, NEW.company_key, NEW.role_key, NEW.role_url, NEW.role_url_key, 'Applied', NEW.qa_json);
  END;
`);

// ── Normalization helpers ───────────────────────────────────────────────────

function normalizeKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lookupCompanyKey(raw) {
  const k = normalizeKey(raw);
  const row = db.prepare('SELECT canonical_key FROM company_alias WHERE raw_key = ?').get(k);
  return row ? row.canonical_key : k;
}

// Query params that identify WHICH posting a URL points to. Without these,
// every Greenhouse embed collapses to the same path and one company's row
// poisons the URL dedup index for every other embed apply.
const URL_ID_PARAMS = ['for', 'token', 'gh_jid', 'gh_jid[]', 'ashby_jid', 'jobId', 'id'];

// Canonicalize an ATS URL: drop protocol/www/fragment/tracking params, lowercase
// the path, and strip the form-page suffix — the same posting is served at
// /Company/<id>, /company/<id>, and /company/<id>/application (Lever: /apply).
function normalizeUrl(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '').toLowerCase().replace(/\/(application|apply)$/, '');
    const ids = [];
    for (const param of URL_ID_PARAMS) {
      const v = u.searchParams.get(param);
      if (v != null && v !== '') ids.push(param + '=' + v);
    }
    ids.sort();
    return ids.length ? host + p + '?' + ids.join('&') : host + p;
  } catch {
    return null;
  }
}

// ── Skip taxonomy ───────────────────────────────────────────────────────────
// Free-text skip reasons make "should this re-scouted role re-enter the queue?"
// unanswerable. skip_class makes the policy explicit:
//   'permanent'   — never re-add (bad fit, seniority, location, clearance)
//   'conditional' — re-add once reopen_after passes (ATS submission windows)
//   'transient'   — re-add on next scout (form blocker, timeout, claim race)
// Unknown reasons default to 'permanent': a false block costs one role, a false
// re-add can burn a per-company ATS cap slot.
function classifySkip(text) {
  const t = String(text || '');
  if (/senior|staff|principal|distinguished|director|manager|clearance|on-?site|relocat|poor-?fit|not a fit|disqualif|over-?qualif|already applied|already_applied/i.test(t)) {
    return { skip_class: 'permanent', reopen_after: null };
  }
  if (/\bcap\b|limit|window|at.cap/i.test(t)) {
    return { skip_class: 'conditional', reopen_after: null };
  }
  if (/missing entry for required field|required field/i.test(t)) {
    // The filler refused to guess an unmapped required field (fail-safe).
    // Fixable by adding an override — but auto-resurrecting would just re-fail.
    return { skip_class: 'conditional', reopen_after: null };
  }
  if (/timeout|timed out|blocker|captcha|crash|cdp|network|econn|race|re-?claim|wedge|stale|hang|navigation|render/i.test(t)) {
    return { skip_class: 'transient', reopen_after: null };
  }
  return { skip_class: 'permanent', reopen_after: null };
}

db.normalizeKey = normalizeKey;
db.lookupCompanyKey = lookupCompanyKey;
db.normalizeUrl = normalizeUrl;
db.classifySkip = classifySkip;

module.exports = db;
