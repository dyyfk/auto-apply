#!/usr/bin/env node
// Unified apply runner. Claims roles (from the queue or a batch file), routes
// each to the matching ATS engine, and reports results through the fence API.
//
// Usage:
//   node scripts/apply.js --queue [--max N]            # drain the server queue
//   node scripts/apply.js roles.json                   # hand-curated batch
//   Common flags: --profile-id N  --dry-run  --prep (Lever: leave tab open for
//   manual captcha+submit)
//
//   roles.json = [{ "company", "role_title", "url",
//                   "overrides"?: { "why"?, "essay"?, "answers"?: [{re, flags?, val}] } }]
//
// Environment: JOBS_API (default http://localhost:3001), CDP_PORT (default
// 9222), APP_PASSWORD (when the server is password-protected).
//
// Per-role CLAIM PROTOCOL (order matters — see lib/api.js):
//   1. GET /applied — skip if applied; ABORT THE RUN if the server is
//      unreachable (never submit blind).
//   2. DRY RUN stops on the DB side here: no claim, no writes.
//   3. LIVE: claim (queue row already claimed, batch → claim-external).
//   4. Fill via the ATS engine.
//   5. PATCH {submitted:true, claim_token} IMMEDIATELY BEFORE the click
//      (the engine's beforeSubmit hook).
//   6. Click; report done/failed with the claim token.
// A crash mid-flight is covered by the server's stale-claim release.
//
// NEVER add direct SQLite writes here — all records go through the API.

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const api = require('./lib/api');
const { buildPolicy } = require('./lib/answers');
const { applyAshbyRole } = require('./lib/ashby');
const { applyGreenhouseRole } = require('./lib/greenhouse');
const { applyLeverRole } = require('./lib/lever');

const CDP_PORT = process.env.CDP_PORT || '9222';
const SESSION_ID = 'apply-runner-' + process.pid;

function usage(msg) {
  if (msg) console.error('ERROR:', msg);
  console.error('Usage: node scripts/apply.js (--queue [--max N] | roles.json) [--profile-id N] [--dry-run] [--prep]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { queue: false, file: null, profileId: null, dryRun: false, prep: false, max: Infinity };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--queue') out.queue = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--prep') out.prep = true;
    else if (a === '--profile-id') out.profileId = Number(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (!a.startsWith('--')) out.file = a;
    else usage('unknown flag ' + a);
  }
  if (!out.queue && !out.file) usage();
  if (out.queue && out.file) usage('pass --queue OR a roles file, not both');
  return out;
}

function detectAts(url, hint) {
  if (hint) return hint;
  if (/ashbyhq\.com/i.test(url || '')) return 'ashby';
  if (/greenhouse\.io/i.test(url || '')) return 'greenhouse';
  if (/lever\.co/i.test(url || '')) return 'lever';
  return null;
}

function loadRoles(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) usage('roles file not found: ' + abs);
  let roles;
  try { roles = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { usage('roles file is not valid JSON: ' + e.message); }
  if (!Array.isArray(roles) || !roles.length) usage('roles file must be a non-empty JSON array');
  for (const [i, r] of roles.entries()) {
    if (!r || !r.company || !r.role_title || !r.url) usage(`roles[${i}] must have company, role_title, url`);
  }
  return roles;
}

async function connectBrowser() {
  // 127.0.0.1, not localhost: localhost can resolve to ::1 while Chrome binds
  // the debug port on IPv4 only.
  try {
    const browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${CDP_PORT}`, timeout: 90000 });
    console.log('CONNECT: attached to Chrome via CDP :' + CDP_PORT);
    return { browser, ctx: browser.contexts()[0], persistent: false };
  } catch (e) {
    console.log(`CONNECT: CDP :${CDP_PORT} failed (${e.message.split('\n')[0]}) — launching persistent browser`);
    // Persistent profile matters for Greenhouse: its email-verification gate
    // trusts a device after the first code, so reusing one profile dir means
    // verifying once.
    const profileDir = process.env.BROWSER_PROFILE_DIR || path.join(__dirname, '..', '.apply-browser-profile');
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    });
    return { browser: ctx.browser(), ctx, persistent: true };
  }
}

async function applyOne(ctx, role, policy, opts) {
  const ats = detectAts(role.url, role.ats);
  if (!ats) return { company: role.company, title: role.role_title, url: role.url, status: 'failed', note: 'unsupported_ats', warnings: [] };
  const page = await ctx.newPage();
  const keepOpen = ats === 'lever' && opts.prep; // manual captcha flow
  try {
    if (ats === 'ashby') return await applyAshbyRole(page, role, policy, { dryRun: opts.dryRun, beforeSubmit: opts.beforeSubmit });
    if (ats === 'greenhouse') return await applyGreenhouseRole(page, role, policy, { dryRun: opts.dryRun, beforeSubmit: opts.beforeSubmit });
    return await applyLeverRole(page, role, policy, { dryRun: opts.dryRun, prep: opts.prep, beforeSubmit: opts.beforeSubmit });
  } finally {
    if (!keepOpen) { try { await page.close(); } catch { /* browser gone */ } }
  }
}

// Report a fill result for a claimed row. Returns true when bookkeeping failed
// after a real submit attempt (the caller exits nonzero).
async function reportOutcome({ jobId, claimToken, role, r, dryRun }) {
  const warn = r.warnings && r.warnings.length ? ' warnings=' + JSON.stringify(r.warnings) : '';
  if (r.status === 'dry_run' || r.status === 'prep' || dryRun) {
    console.log(`${r.status === 'prep' ? 'PREP' : 'DRY_RUN'}: ${role.company} — ${role.role_title} (${r.note})${warn}`);
    return false;
  }
  if (r.status === 'done') {
    try {
      await api.reportResult({
        jobId, claimToken,
        status: 'done',
        qaJson: r.qa || undefined,
        notes: ('applied via apply.js; shot=' + (r.shot || '') + warn).slice(0, 500),
      });
      console.log('RECORDED done id=' + jobId);
      return false;
    } catch (e) {
      // Submission SUCCEEDED but bookkeeping failed — the submitted_at fence
      // still blocks re-applies, but the row is not terminal.
      console.error(`RECORD FAILED after successful submit for ${role.company} — ${role.role_title}: ${e.message} ` +
        `(finish manually with PATCH /api/jobs/${jobId} {status:'done', claim_token})`);
      return true;
    }
  }

  // Failed. `submitted` reflects whether the click actually dispatched:
  //  - clicked: leave submitted_at set (the form may have gone through without
  //    a confirmation page), no skip_class — a human reviews it.
  //  - never clicked / client-side validation reject: nothing reached the ATS —
  //    clear the fence, mark transient (retryable). Leaving the fence on a
  //    never-submitted role would burn it forever.
  //  - security_code_timeout: the form POST already happened — submission
  //    evidence must stay.
  const clickDispatched = (!!r.submitClicked && !r.validationBlocked) || r.note === 'security_code_timeout';
  try {
    await api.reportResult({
      jobId, claimToken,
      status: 'failed',
      error: (r.note + warn).slice(0, 500),
      submitted: clickDispatched,
      skipClass: clickDispatched ? undefined : 'transient',
    });
    if (clickDispatched) {
      console.error(`REVIEW NEEDED: ${role.company} — ${role.role_title} clicked Submit without confirmed success (${r.note}). Row failed+submitted (blocks re-apply).`);
    } else {
      console.error(`FAILED pre-click (recorded transient, retryable): ${role.company} — ${role.role_title}: ${r.note}`);
    }
    return false;
  } catch (e) {
    console.error(`RECORD FAILED for ${role.company} — ${role.role_title}: ${e.message} (job id=${jobId} clickDispatched=${clickDispatched})`);
    return true;
  }
}

(async () => {
  const args = parseArgs(process.argv);

  // Profile first — fetchProfile throws when intake (sanity questions + resume)
  // is incomplete, before any browser work.
  let profile;
  try { profile = await api.fetchProfile(args.profileId); }
  catch (e) { console.error('ABORT:', e.message); process.exit(2); }
  if (!fs.existsSync(profile.resume)) {
    console.error('ABORT: resume file missing on disk:', profile.resume);
    process.exit(2);
  }
  const policy = buildPolicy(profile);
  console.log(`apply.js: profile=${profile.name} <${profile.email}> dryRun=${args.dryRun} prep=${args.prep} api=${api.BASE_URL}`);

  const { browser, ctx, persistent } = await connectBrowser();
  const results = [];
  let recordFailure = false;

  try {
    if (args.queue && args.dryRun) {
      // ── Queue dry run: NO claims, no writes — fill pending rows and stop
      // before each submit so the field mapping can be reviewed.
      const res = await fetch(`${api.BASE_URL}/api/jobs?status=pending&profile_id=${profile.id}`, {
        headers: process.env.APP_PASSWORD ? { Authorization: `Bearer ${process.env.APP_PASSWORD}` } : {},
      });
      const pending = (await res.json()).slice(0, args.max === Infinity ? undefined : args.max);
      console.log(`DRY RUN over ${pending.length} pending row(s) — nothing claimed, nothing recorded.`);
      for (const job of pending) {
        if (!job.role_url) continue;
        const role = { company: job.company, role_title: job.role_title, title: job.role_title, url: job.role_url, ats: job.ats };
        results.push(await applyOne(ctx, role, policy, { dryRun: true }));
      }
    } else if (args.queue) {
      // ── Queue mode: claim → fill → report, until empty or --max ──────────
      let count = 0;
      while (count < args.max) {
        let job;
        try { job = await api.claimNext({ profileId: profile.id, sessionId: SESSION_ID }); }
        catch (e) { console.error('ABORT (fail closed): claim failed —', e.message); break; }
        if (!job) { console.log('Queue empty (or paused).'); break; }
        count++;
        console.log(`CLAIMED id=${job.id}: ${job.company} — ${job.role_title}`);

        const role = { company: job.company, role_title: job.role_title, title: job.role_title, url: job.role_url, ats: job.ats };
        if (!job.role_url) {
          await api.reportResult({ jobId: job.id, claimToken: job.claim_token, status: 'skipped', notes: 'no role_url', skipClass: 'permanent' }).catch(() => {});
          continue;
        }
        const r = await applyOne(ctx, role, policy, {
          dryRun: false,
          prep: args.prep,
          beforeSubmit: async () => {
            await api.markSubmitted({ jobId: job.id, claimToken: job.claim_token });
            console.log('SUBMIT_FENCE_SET — clicking Submit');
          },
        });
        recordFailure = (await reportOutcome({ jobId: job.id, claimToken: job.claim_token, role, r, dryRun: false })) || recordFailure;
        results.push(r);
        await new Promise((res) => setTimeout(res, 1500));
      }
    } else {
      // ── Batch mode: external claim protocol per role ─────────────────────
      const roles = loadRoles(args.file);

      // Fail-closed reachability check up front.
      try { await api.checkApplied({ profileId: profile.id, url: roles[0].url, company: roles[0].company, roleTitle: roles[0].role_title }); }
      catch (e) { console.error('ABORT (fail closed): jobs API check failed —', e.message); process.exit(2); }

      for (const role of roles) {
        const ident = { profileId: profile.id, url: role.url, company: role.company, roleTitle: role.role_title };

        // (1) Pre-flight dedup — ALWAYS, before touching the form.
        let check;
        try { check = await api.checkApplied(ident); }
        catch (e) {
          console.error('ABORT RUN (fail closed): /applied check failed —', e.message);
          results.push({ ...role, status: 'aborted', note: 'applied_check_unreachable' });
          break;
        }
        if (check.applied) {
          console.log(`SKIP (already applied via ${check.source}): ${role.company} — ${role.role_title}`);
          results.push({ ...role, status: 'skipped', note: 'already_applied' });
          continue;
        }

        // (2)/(3) DRY RUN claims nothing; LIVE claims atomically.
        let claim = null;
        if (!args.dryRun && !args.prep) {
          try {
            claim = await api.claimExternal({
              profileId: profile.id,
              company: role.company,
              roleTitle: role.role_title,
              roleUrl: role.url,
              ats: detectAts(role.url, role.ats),
              sessionId: SESSION_ID,
              notes: 'claimed by apply.js batch',
            });
          } catch (e) {
            const kind = (e.body && e.body.error) || null;
            if (e.status === 409) {
              console.log(`SKIP (409 ${kind || 'conflict'}): ${role.company} — ${role.role_title}`);
              results.push({ ...role, status: 'skipped', note: '409 ' + (kind || 'conflict') });
              continue;
            }
            console.error('ABORT RUN (fail closed): claim-external failed —', e.message);
            results.push({ ...role, status: 'aborted', note: 'claim_failed' });
            break;
          }
          if (claim.reclaimedFrom) {
            console.log(`RECLAIMED: was ${claim.reclaimedFrom}${claim.skippedAs ? ` (skip_class=${claim.skippedAs})` : ''} — this run overrides that skip`);
          }
          console.log(`CLAIMED id=${claim.job.id}: ${role.company} — ${role.role_title}`);
        }
        const jobId = claim ? claim.job.id : null;
        const claimToken = claim ? claim.job.claim_token : null;

        const r = await applyOne(ctx, role, policy, {
          dryRun: args.dryRun,
          prep: args.prep,
          beforeSubmit: claim ? async () => {
            await api.markSubmitted({ jobId, claimToken });
            console.log('SUBMIT_FENCE_SET — clicking Submit');
          } : null,
        });
        if (claim) {
          recordFailure = (await reportOutcome({ jobId, claimToken, role, r, dryRun: args.dryRun })) || recordFailure;
        } else {
          console.log(`${r.status.toUpperCase()}: ${role.company} — ${role.role_title} ${r.note || ''}` +
            (r.warnings?.length ? ' warnings=' + JSON.stringify(r.warnings) : ''));
        }
        results.push(r);
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  } finally {
    console.log('\n===== SUMMARY =====');
    for (const r of results) {
      console.log(`${r.company || r.url} | ${r.title || r.role_title || ''}: ${r.status} ${r.note || ''}`);
    }
    // Keep the browser open for prep mode (human still needs the tabs).
    if (!args.prep) {
      try { if (persistent) await ctx.close(); else await browser.close(); } catch { /* CDP: disconnect only */ }
    }
  }

  const bad = results.filter((r) => r.status === 'failed' || r.status === 'aborted');
  if (recordFailure) {
    console.error('\nRECORD FAILED — at least one bookkeeping write was rejected after a real submit attempt. Fix via PATCH /api/jobs/:id before rerunning.');
  }
  process.exit(bad.length || recordFailure ? 1 : 0);
})();
