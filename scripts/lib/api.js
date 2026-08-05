// The single choke-point for apply-side dedup + record-keeping.
//
// Every apply script MUST route its DB interaction through this module. NEVER
// write to the SQLite file directly from scripts — end-of-run CLI INSERTs are
// exactly how submission records get lost and double-applies happen.
//
// Fail-closed philosophy:
//   - checkApplied THROWS when the server is unreachable — never submit blind.
//   - claimExternal / markSubmitted / recordExternal / reportResult THROW on
//     non-2xx so a caller cannot silently proceed past a rejected fence write.
//   A false BLOCK costs one role; a false ALLOW burns an ATS cap (many tenants
//   allow 1-3 applications per applicant, period).
//
// LIVE external applies use the CLAIM PROTOCOL (same fences as queue agents):
//   checkApplied -> claimExternal -> fill form -> markSubmitted immediately
//   before the click -> click -> reportResult. A crash mid-flight is covered by
//   the server's stale-claim release.

'use strict';

// Share the server's .env (APP_PASSWORD, PORT) so scripts work without
// re-exporting everything. Real env vars still win.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const BASE_URL = process.env.JOBS_API || `http://localhost:${process.env.PORT || 3001}`;
const AUTH = process.env.APP_PASSWORD || null;

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH) h.Authorization = `Bearer ${AUTH}`;
  return h;
}

/** Drop undefined values so PATCH bodies only carry intended fields. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

async function request(method, pathname, body) {
  let res;
  try {
    res = await fetch(BASE_URL + pathname, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(compact(body)),
    });
  } catch (e) {
    const err = new Error(`jobs API unreachable (${method} ${pathname}): ${e.message}`);
    err.unreachable = true;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* 204 etc. */ }
  return { res, data };
}

function httpError(method, pathname, res, data) {
  const err = new Error(`${method} ${pathname} -> ${res.status} ${JSON.stringify(data || {}).slice(0, 300)}`);
  err.status = res.status;
  err.body = data;
  return err;
}

/** Fetch a profile (by id, or the deployment default) and normalize it into
 *  the shape the appliers consume. THROWS if intake is incomplete — the
 *  sanity questions must be answered before any form is touched. */
async function fetchProfile(profileId) {
  const pathname = profileId ? `/api/profiles/${profileId}` : '/api/profiles/default';
  const { res, data } = await request('GET', pathname);
  if (!res.ok) throw httpError('GET', pathname, res, data);
  const p = data;
  if (!p.intake?.complete) {
    throw new Error(
      'INTAKE_INCOMPLETE: profile is missing ' + JSON.stringify(p.intake?.missing || []) +
      ' — finish onboarding in the web UI before applying.'
    );
  }

  const firstName = p.first_name;
  const lastName = p.last_name;
  const city = p.city || '';
  const state = p.state || '';
  const country = p.country || 'United States';

  // Sponsorship explanation for "please explain your visa status" fields:
  // user-provided note wins; otherwise generate a truthful template.
  const VISA_LABELS = {
    citizen: 'a citizen', green_card: 'a permanent resident (green card holder)',
    h1b: 'on an H-1B visa', f1_opt: 'on F-1 OPT', tn: 'on a TN visa', o1: 'on an O-1 visa',
  };
  let sponsorshipExplain = p.sponsorship_note;
  if (!sponsorshipExplain) {
    const visa = VISA_LABELS[p.visa_status] || `on a ${p.visa_status || 'work'} visa`;
    sponsorshipExplain = p.needs_sponsorship
      ? `I am currently ${visa} and will require sponsorship for this position.`
      : `I am ${visa} and do not require sponsorship.`;
  }

  return {
    id: p.id,
    name: `${firstName} ${lastName}`,
    firstName,
    lastName,
    preferredName: p.preferred_name || firstName,
    email: p.email,
    phone: p.phone || '',
    linkedin: p.linkedin || '',
    github: p.github || '',
    website: p.website || p.github || '',

    city,
    state,
    location: city && state ? `${city}, ${state}` : city || state || country,
    locationFull: [city, state, country].filter(Boolean).join(', '),
    addressLine1: p.address_line1 || '',
    zip: p.zip || '',
    country,

    currentlyEmployed: !!p.currently_employed,
    currentEmployer: p.current_employer || '',
    currentTitle: p.current_title || '',
    yoe: p.years_of_experience || '',

    school: p.school || '',
    degree: p.degree || '',
    discipline: p.discipline || '',
    eduStartYear: p.edu_start_year || '',
    eduEndYear: p.edu_end_year || '',

    workAuthorized: !!p.work_authorized,
    needsSponsorship: !!p.needs_sponsorship,
    visaStatus: p.visa_status || '',
    sponsorshipExplain,
    isStudent: !!p.is_student,
    over18: !!p.over_18,
    willingToRelocate: !!p.willing_to_relocate,
    noNoncompete: !!p.no_noncompete,
    // tri-state: true = "no record", null/undefined = never auto-answer
    cleanRecord: p.clean_record === 1 ? true : p.clean_record === 0 ? false : null,

    background: p.background || '',
    positioning: p.positioning || p.background || '',
    desiredComp: p.desired_compensation || '',
    startAvailability: p.start_availability || 'Immediately',
    howHeard: p.how_heard || 'LinkedIn',

    resume: p.resume_path,
    resumeFilename: p.resume_filename || '',
  };
}

/**
 * GET /api/jobs/applied with ALL available identifiers.
 * Returns { applied: boolean, source?, ... }. THROWS if unreachable — fail
 * closed, never submit blind.
 */
async function checkApplied({ profileId, url, company, roleTitle } = {}) {
  if (!url && !(company && roleTitle)) {
    throw new Error('checkApplied: need url and/or company+roleTitle');
  }
  const params = new URLSearchParams();
  if (profileId) params.set('profile_id', profileId);
  if (url) params.set('url', url);
  if (company) params.set('company', company);
  if (roleTitle) params.set('role_title', roleTitle);
  const pathname = '/api/jobs/applied?' + params.toString();
  const { res, data } = await request('GET', pathname);
  if (!res.ok) throw httpError('GET', pathname, res, data);
  return data;
}

/**
 * POST /api/jobs/claim — grab the next pending queue row.
 * Returns the job or null when the queue is empty/paused.
 */
async function claimNext({ profileId, sessionId } = {}) {
  const pathname = '/api/jobs/claim';
  const { res, data } = await request('POST', pathname, {
    profile_id: profileId,
    session_id: sessionId,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw httpError('POST', pathname, res, data);
  return data;
}

/**
 * POST /api/jobs/claim-external — atomic claim-or-create for a LIVE
 * externally-driven apply. THROWS with .status/.body on 409s:
 *   already_applied | in_flight | already_terminal | conflict
 */
async function claimExternal({ profileId, company, roleTitle, roleUrl, ats, sessionId, notes } = {}) {
  if (!company || !roleTitle) throw new Error('claimExternal: company and roleTitle are required');
  const pathname = '/api/jobs/claim-external';
  const { res, data } = await request('POST', pathname, {
    profile_id: profileId,
    company,
    role_title: roleTitle,
    role_url: roleUrl,
    ats,
    session_id: sessionId,
    notes,
  });
  if (!res.ok) throw httpError('POST', pathname, res, data);
  return { job: data.job, reclaimedFrom: data.reclaimed_from, skippedAs: data.skipped_as };
}

/**
 * PATCH { submitted: true, claim_token } — call IMMEDIATELY BEFORE clicking
 * Submit. The timestamp survives a crash: any re-claimer sees it via /applied
 * and short-circuits. THROWS on non-2xx (=> do NOT submit).
 */
async function markSubmitted({ jobId, claimToken } = {}) {
  if (!jobId) throw new Error('markSubmitted: jobId is required');
  const pathname = '/api/jobs/' + jobId;
  const { res, data } = await request('PATCH', pathname, {
    submitted: true,
    claim_token: claimToken,
  });
  if (!res.ok) throw httpError('PATCH', pathname, res, data);
  return data;
}

/**
 * POST /api/jobs/record-external — MANUAL BOOKKEEPING ONLY: record a
 * submission (or attempt) that already happened outside the live claim flow.
 */
async function recordExternal({ profileId, company, roleTitle, roleUrl, ats, status, submitted, qaJson, error, notes } = {}) {
  if (!company || !roleTitle) throw new Error('recordExternal: company and roleTitle are required');
  if (status !== 'done' && status !== 'failed') throw new Error("recordExternal: status must be 'done' or 'failed'");
  const pathname = '/api/jobs/record-external';
  const { res, data } = await request('POST', pathname, {
    profile_id: profileId,
    company,
    role_title: roleTitle,
    role_url: roleUrl,
    ats,
    status,
    submitted,
    qa_json: qaJson,
    error,
    notes,
  });
  if (!res.ok) throw httpError('POST', pathname, res, data);
  return data;
}

/**
 * PATCH terminal/result wrapper for claimed rows.
 * skipClass ∈ 'permanent'|'conditional'|'transient'. THROWS on non-2xx;
 * err.status/err.body expose 409 already_terminal / stale_claim.
 */
async function reportResult({ jobId, claimToken, status, notes, error, qaJson, submitted, skipClass, reopenAfter } = {}) {
  if (!jobId) throw new Error('reportResult: jobId is required');
  const pathname = '/api/jobs/' + jobId;
  const { res, data } = await request('PATCH', pathname, {
    status,
    notes,
    error,
    qa_json: qaJson,
    claim_token: claimToken,
    submitted,
    skip_class: skipClass,
    reopen_after: reopenAfter,
  });
  if (!res.ok) throw httpError('PATCH', pathname, res, data);
  return data;
}

module.exports = {
  BASE_URL,
  fetchProfile,
  checkApplied,
  claimNext,
  claimExternal,
  markSubmitted,
  recordExternal,
  reportResult,
};
