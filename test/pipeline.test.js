// End-to-end API tests for the core invariants: intake gating, dedup, the
// claim protocol, and the applications mirror.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { start, stop, req, getBaseUrl, tmpDir } = require('./helpers/app');

let profileId;

before(async () => { await start(); });
after(async () => { await stop(); });

test('profile creation and intake gating', async () => {
  // Create a minimal profile — intake incomplete (no resume, no work-auth).
  let r = await req('POST', '/api/profiles', {
    first_name: 'Test', last_name: 'User', email: 'test@example.com',
  });
  assert.equal(r.status, 201);
  profileId = r.data.id;
  assert.equal(r.data.intake.complete, false);
  assert.ok(r.data.intake.missing.includes('work_authorized'));
  assert.ok(r.data.intake.missing.includes('resume'));

  // Claims are refused while intake is incomplete.
  r = await req('POST', '/api/jobs/claim', { session_id: 's1', profile_id: profileId });
  assert.equal(r.status, 412);
  assert.equal(r.data.error, 'intake_incomplete');

  // complete-intake refuses too.
  r = await req('POST', `/api/profiles/${profileId}/complete-intake`);
  assert.equal(r.status, 400);

  // Answer the sanity questions.
  r = await req('PUT', `/api/profiles/${profileId}`, {
    work_authorized: 1, needs_sponsorship: 1, visa_status: 'f1_opt',
  });
  assert.equal(r.status, 200);

  // Upload a resume (multipart).
  const resumePath = path.join(tmpDir, 'resume.pdf');
  fs.writeFileSync(resumePath, '%PDF-1.4 test');
  const form = new FormData();
  form.append('resume', new Blob([fs.readFileSync(resumePath)], { type: 'application/pdf' }), 'resume.pdf');
  const upload = await fetch(`${getBaseUrl()}/api/profiles/${profileId}/resume`, { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal(uploaded.resume_filename, 'resume.pdf');
  assert.equal(uploaded.intake.complete, true);

  // Now intake completes.
  r = await req('POST', `/api/profiles/${profileId}/complete-intake`);
  assert.equal(r.status, 200);
  assert.ok(r.data.intake_completed_at);
});

test('queue insert, dedup, and URL canonicalization', async () => {
  let r = await req('POST', '/api/jobs', {
    profile_id: profileId,
    company: 'Sierra AI',
    role_title: 'Software Engineer',
    role_url: 'https://jobs.ashbyhq.com/Sierra/abc-123/application',
    ats: 'ashby',
  });
  assert.equal(r.status, 201);
  const jobId = r.data.id;
  assert.equal(r.data.company_key, 'sierra'); // alias applied

  // Same role via alias company name + URL case/suffix variant → duplicate.
  r = await req('POST', '/api/jobs', {
    profile_id: profileId,
    company: 'Sierra',
    role_title: 'Software  Engineer!',
    role_url: 'http://jobs.ashbyhq.com/sierra/abc-123',
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'duplicate');
  assert.equal(r.data.existing_id, jobId);

  // Bulk with one dup and one new.
  r = await req('POST', '/api/jobs/bulk', {
    profile_id: profileId,
    jobs: [
      { company: 'Sierra', role_title: 'Software Engineer' },
      { company: 'Acme', role_title: 'Backend Engineer', role_url: 'https://boards.greenhouse.io/acme/jobs/1' },
    ],
  });
  assert.equal(r.data.added, 1);
  assert.equal(r.data.skipped, 1);
});

test('claim protocol: token fence, submitted evidence, applications mirror', async () => {
  // Claim the highest-priority pending row.
  let r = await req('POST', '/api/jobs/claim', { session_id: 'agent-a', profile_id: profileId });
  assert.equal(r.status, 200);
  const job = r.data;
  assert.equal(job.status, 'in_progress');
  assert.ok(job.claim_token);

  // A second claim gets a different row (not the same one).
  const r2 = await req('POST', '/api/jobs/claim', { session_id: 'agent-b', profile_id: profileId });
  if (r2.status === 200) assert.notEqual(r2.data.id, job.id);

  // Terminal PATCH without the token is rejected.
  r = await req('PATCH', `/api/jobs/${job.id}`, { status: 'done' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'stale_claim');

  // markSubmitted with the token.
  r = await req('PATCH', `/api/jobs/${job.id}`, { submitted: true, claim_token: job.claim_token });
  assert.equal(r.status, 200);
  assert.ok(r.data.submitted_at);

  // /applied now blocks on submitted evidence (pre-done window).
  r = await req('GET', `/api/jobs/applied?profile_id=${profileId}&company=${encodeURIComponent(job.company)}&role_title=${encodeURIComponent(job.role_title)}`);
  assert.equal(r.data.applied, true);
  assert.equal(r.data.source, 'job_queue_submitted');

  // done → mirrored into applications.
  r = await req('PATCH', `/api/jobs/${job.id}`, { status: 'done', claim_token: job.claim_token, qa_json: [{ question: 'q', answer: 'a' }] });
  assert.equal(r.status, 200);

  r = await req('GET', `/api/applications?profile_id=${profileId}`);
  assert.equal(r.status, 200);
  const app = r.data.find((a) => a.company === job.company && a.role_title === job.role_title);
  assert.ok(app, 'application row exists');
  assert.equal(app.status, 'Applied');
  assert.equal(app.qa.length, 1);

  // Terminal → terminal is rejected.
  r = await req('PATCH', `/api/jobs/${job.id}`, { status: 'failed', claim_token: job.claim_token });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'already_terminal');

  // Re-inserting the applied role is blocked (the done queue row matches
  // first; the applications surface backstops it once the queue is purged).
  r = await req('POST', '/api/jobs', { profile_id: profileId, company: job.company, role_title: job.role_title });
  assert.equal(r.status, 409);
  assert.ok(['duplicate', 'already_applied'].includes(r.data.error));

  // Purge terminal queue rows, then the applications surface must still block.
  r = await req('DELETE', `/api/jobs?profile_id=${profileId}`);
  assert.equal(r.status, 200);
  r = await req('POST', '/api/jobs', { profile_id: profileId, company: job.company, role_title: job.role_title });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'already_applied');
});

test('claim-external: atomic claim-or-create and 409s', async () => {
  let r = await req('POST', '/api/jobs/claim-external', {
    profile_id: profileId,
    company: 'BatchCo',
    role_title: 'Infrastructure Engineer',
    role_url: 'https://jobs.lever.co/batchco/xyz',
    ats: 'lever',
  });
  assert.equal(r.status, 200);
  const job = r.data.job;
  assert.equal(job.status, 'in_progress');
  assert.ok(job.claim_token);

  // A second external claim on the same role → in_flight.
  r = await req('POST', '/api/jobs/claim-external', {
    profile_id: profileId,
    company: 'BatchCo',
    role_title: 'Infrastructure Engineer',
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'in_flight');

  // Fail it WITHOUT submission evidence, transient → resurrectable.
  r = await req('PATCH', `/api/jobs/${job.id}`, {
    status: 'failed', claim_token: job.claim_token, error: 'page timeout', skip_class: 'transient',
  });
  assert.equal(r.status, 200);

  // Re-scout of the same role resurrects the squatter instead of dropping it.
  r = await req('POST', '/api/jobs/bulk', {
    profile_id: profileId,
    jobs: [{ company: 'BatchCo', role_title: 'Infrastructure Engineer', role_url: 'https://jobs.lever.co/batchco/xyz' }],
  });
  assert.equal(r.data.resurrected, 1);
});

test('skipped role with submission evidence blocks resurrection', async () => {
  let r = await req('POST', '/api/jobs/claim-external', {
    profile_id: profileId, company: 'EvidenceCo', role_title: 'Platform Engineer',
  });
  const job = r.data.job;
  await req('PATCH', `/api/jobs/${job.id}`, { submitted: true, claim_token: job.claim_token });
  await req('PATCH', `/api/jobs/${job.id}`, { status: 'failed', claim_token: job.claim_token, error: 'timeout after click' });

  // failed + submitted mirrors into applications (the Swarmia case) …
  r = await req('GET', `/api/applications?profile_id=${profileId}`);
  assert.ok(r.data.some((a) => a.company === 'EvidenceCo'));

  // … so a re-scout is skipped, never resurrected.
  r = await req('POST', '/api/jobs/bulk', {
    profile_id: profileId,
    jobs: [{ company: 'EvidenceCo', role_title: 'Platform Engineer' }],
  });
  assert.equal(r.data.added, 0);
  assert.equal(r.data.resurrected, 0);
  assert.equal(r.data.skipped, 1);
});

test('company policy blocks inserts and claims', async () => {
  const db = require('../server/db');
  db.prepare('INSERT OR REPLACE INTO company_policy (profile_id, company_key, policy, reason) VALUES (?, ?, ?, ?)')
    .run(profileId, 'blockedco', 'blocked', 'test');

  const r = await req('POST', '/api/jobs', { profile_id: profileId, company: 'BlockedCo', role_title: 'Engineer' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'company_blocked');
});

test('profiles are isolated: same role can be queued for another profile', async () => {
  let r = await req('POST', '/api/profiles', {
    first_name: 'Second', last_name: 'User', email: 'second@example.com',
  });
  const otherId = r.data.id;

  // Sierra/Software Engineer is applied for profile 1; profile 2 can queue it.
  r = await req('POST', '/api/jobs', {
    profile_id: otherId, company: 'Sierra', role_title: 'Software Engineer',
    role_url: 'https://jobs.ashbyhq.com/sierra/abc-123',
  });
  assert.equal(r.status, 201);
});
