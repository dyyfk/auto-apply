// Lever (jobs.lever.co) form driver.
//
// Lever forms carry an hCaptcha, so fully-automated submits often fail. Modes:
//   dryRun — fill everything, dump committed values, do not submit.
//   prep   — fill everything and LEAVE THE TAB OPEN for a human to solve the
//            captcha and click Submit (the recommended live mode).
//   live   — attempt the submit click directly (works on tenants without a
//            visible captcha gate).
//
// NO DB writes in here — the runner owns the claim/fence protocol.

'use strict';

const path = require('path');
const fs = require('fs');
const { DECLINE_RE } = require('./answers');

const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Desired option-text regex for multi-option custom fields (EEO declines etc.)
function optionRegex(q, policy) {
  q = (q || '').toLowerCase();
  const profile = policy.profile;
  if (policy.isSourceQuestion(q)) return new RegExp(escapeRe(profile.howHeard) + '|social|other|website', 'i');
  if (/years|experience/.test(q) && profile.yoe) {
    const y = parseInt(profile.yoe, 10);
    if (!Number.isNaN(y)) return new RegExp(`${y}.?${y + 2}|${y}-${y + 2}|${y}\\+|${y} to |^${y}\\b`, 'i');
  }
  if (/gender|race|ethnicity|hispanic|pronoun/.test(q)) return DECLINE_RE;
  if (/veteran/.test(q)) return /not a (protected )?veteran|decline|prefer not/i;
  if (/disability/.test(q)) return /do not (wish|want)|don.?t wish|decline|prefer not/i;
  if (/authorized to work|legally authorized|work authorization/.test(q) && !/without|unrestricted/.test(q)) {
    return profile.workAuthorized ? /^yes/i : /^no/i;
  }
  if (/require.*sponsor|need.*sponsor|sponsorship/.test(q)) return profile.needsSponsorship ? /^yes/i : /^no/i;
  if (/share (with|about)|information.*(share|referr)|what.*share|referr/.test(q)) return /nothing|prefer not|decline/i;
  return null;
}

/**
 * Fill + (optionally) submit one Lever application.
 *
 * @param page    Playwright page.
 * @param role    { company, title|role_title, url, overrides?: { why?, answers?: [{re, flags?, val}] } }
 * @param policy  answer policy from lib/answers.buildPolicy(profile)
 * @param opts    { dryRun?, prep?, beforeSubmit? }
 * @returns { company, title, url, status: 'done'|'failed'|'dry_run'|'prep',
 *            note, qa, submitClicked, warnings: [] }
 */
async function applyLeverRole(page, role, policy, opts = {}) {
  const profile = policy.profile;
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const title = role.title || role.role_title;
  const positioning = role.overrides?.why || profile.positioning;
  const answerOverrides = Array.isArray(role.overrides?.answers) ? role.overrides.answers : [];
  const findOverride = (label) => answerOverrides.find((o) => {
    try { return new RegExp(o.re, o.flags || 'i').test(label || ''); } catch { return false; }
  });
  const qa = [];
  const result = { company: role.company, title, url: role.url, status: 'unknown', note: '', qa, submitClicked: false, warnings: [] };

  try {
    let url = role.url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500);
    // Posting pages have no form — go to /apply.
    if (await page.locator('input[name="name"]').count() === 0) {
      url = role.url.replace(/\/$/, '') + '/apply';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2500);
    }
    const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    for (const d of ['no longer accepting', 'position is closed', 'no longer available', 'posting is closed']) {
      if (body.includes(d)) { result.status = 'failed'; result.note = 'closed:' + d; return result; }
    }
    if (await page.locator('input[name="name"]').count() === 0) {
      result.status = 'failed'; result.note = 'no_form'; return result;
    }

    // Core fields
    const setVal = async (sel, val) => {
      if (val == null || val === '') return;
      try {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.fill(String(val)); qa.push({ q: sel, a: String(val) }); }
      } catch { /* optional field */ }
    };
    await setVal('input[name="name"]', profile.name);
    await setVal('input[name="email"]', profile.email);
    await setVal('input[name="phone"]', profile.phone);
    await setVal('input[name="org"]', profile.currentEmployer);
    await setVal('input[name="urls[LinkedIn]"]', profile.linkedin);
    await setVal('input[name="urls[GitHub]"]', profile.github);
    await setVal('input[name="urls[Github]"]', profile.github);
    await setVal('input[name="urls[Portfolio]"]', profile.website);
    await setVal('input[name="urls[Other]"]', profile.website);

    // Resume — upload, then WAIT for Lever's async parse ("Analyzing resume...")
    // to finish. Submitting mid-analysis makes Lever reject with a bogus
    // "exceeds 100MB" error.
    try {
      const rf = page.locator('input[type="file"][name="resume"], input[type="file"]').first();
      if (await rf.count()) {
        await rf.setInputFiles(profile.resume);
        const resumeBase = path.basename(profile.resume, path.extname(profile.resume));
        const fileRe = new RegExp(escapeRe(resumeBase).slice(0, 30) + '|\\.pdf\\b', 'i');
        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
          await sleep(1500);
          const st = await page.evaluate((src) => ({
            analyzing: /analyzing resume/i.test(document.body.innerText),
            hasFile: new RegExp(src, 'i').test(document.body.innerText),
          }), fileRe.source);
          if (!st.analyzing && st.hasFile) { ready = true; break; }
        }
        if (!ready) ready = !(await page.evaluate(() => /analyzing resume/i.test(document.body.innerText)));
        // Re-assert core identity fields AFTER parse — resume autofill can
        // overwrite them.
        await setVal('input[name="name"]', profile.name);
        await setVal('input[name="email"]', profile.email);
        await setVal('input[name="phone"]', profile.phone);
        qa.push({ q: 'resume', a: ready ? 'uploaded+parsed' : 'uploaded(parse-uncertain)' });
      } else result.warnings.push('resume_input_not_found');
    } catch (e) { console.log('resume err', e.message); }

    // Enumerate custom question cards
    const cards = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('li.application-question, .application-question, ul.application-additional li').forEach((li) => {
        const label = (li.querySelector('.application-label, label, .text')?.innerText || '').trim();
        const texts = Array.from(li.querySelectorAll('input[type="text"], input:not([type]), input[type="email"], input[type="tel"], textarea')).map((e) => ({ tag: e.tagName, name: e.name, id: e.id, itype: e.type }));
        const radios = Array.from(li.querySelectorAll('input[type="radio"]')).map((e) => ({ name: e.name, value: e.value, label: (document.querySelector(`label[for="${e.id}"]`)?.innerText || e.closest('label')?.innerText || e.parentElement?.innerText || '').trim() }));
        const checks = Array.from(li.querySelectorAll('input[type="checkbox"]')).map((e) => ({ name: e.name, value: e.value, label: (document.querySelector(`label[for="${e.id}"]`)?.innerText || e.closest('label')?.innerText || e.parentElement?.innerText || '').trim() }));
        const selects = Array.from(li.querySelectorAll('select')).map((e) => ({ name: e.name, options: Array.from(e.options).map((o) => o.text) }));
        out.push({ label, texts, radios, checks, selects });
      });
      return out;
    });

    for (const card of cards) {
      const q = card.label;
      if (policy.isDemographic(q)) {
        // Demographic questions in the custom section: only ever pick a
        // decline option; otherwise leave untouched.
        if (card.radios.length || card.selects.length) {
          const declineRadio = card.radios.find((r) => DECLINE_RE.test(r.label || ''));
          if (declineRadio) {
            try { await page.locator(`input[type="radio"][name="${declineRadio.name}"][value="${(declineRadio.value || '').replace(/"/g, '\\"')}"]`).first().check({ force: true }); } catch { /* leave blank */ }
          }
        }
        continue;
      }
      const ov = findOverride(q);

      // radios
      if (card.radios.length) {
        const norm = (r) => (((r.label || '') + ' ' + (r.value || '')).toLowerCase().trim());
        let target = null;
        if (ov && ov.val !== '') target = card.radios.find((r) => norm(r).includes(String(ov.val).toLowerCase()));
        if (ov && String(ov.val) === '') continue;
        if (!target) {
          const orx = optionRegex(q, policy);
          target = orx ? card.radios.find((r) => orx.test(norm(r))) : null;
        }
        const yn = policy.pickYesNo(q);
        if (!target && yn) target = card.radios.find((r) => new RegExp('\\b' + yn + '\\b', 'i').test(norm(r)));
        if (!target && yn) target = card.radios.find((r) => new RegExp('^' + yn, 'i').test(norm(r)));
        if (target) {
          try {
            await page.locator(`input[type="radio"][name="${target.name}"][value="${(target.value || '').replace(/"/g, '\\"')}"]`).first().check({ force: true });
            qa.push({ q: q.slice(0, 60), a: target.label.slice(0, 40) });
          } catch (e) { console.log('radio err', e.message); }
        } else {
          result.warnings.push('radio_skipped: "' + q.slice(0, 70) + '"');
        }
        continue;
      }
      // selects
      if (card.selects.length) {
        for (const s of card.selects) {
          const orx = optionRegex(q, policy);
          const opts2 = s.options;
          let pick = null;
          if (ov && ov.val !== '') pick = opts2.find((o) => o.toLowerCase().includes(String(ov.val).toLowerCase()));
          if (!pick && orx) pick = opts2.find((o) => orx.test(o));
          if (!pick) pick = opts2.find((o) => o && !/^(select|choose|--|please)/i.test(o) && !DECLINE_RE.test(o)) || opts2[1] || opts2[0];
          try {
            await page.locator(`select[name="${s.name}"]`).selectOption({ label: pick });
            qa.push({ q: q.slice(0, 60), a: pick });
          } catch (e) { console.log('select err', e.message); }
        }
        continue;
      }
      // checkboxes (consent / how-did-you-hear multi)
      if (card.checks.length) {
        const orx = optionRegex(q, policy);
        let target = orx ? card.checks.find((c) => orx.test(c.label)) : null;
        if (!target && ov && ov.val) target = card.checks.find((c) => (c.label || '').toLowerCase().includes(String(ov.val).toLowerCase()));
        if (!target && /agree|consent|acknowledge|privacy|terms|confirm|certify|accurate|true and|to the best of|i have read|i understand/i.test(q)) target = card.checks[0];
        if (target) {
          try {
            const loc = page.locator(`input[type="checkbox"][name="${target.name}"][value="${(target.value || '').replace(/"/g, '\\"')}"]`).first();
            if (await loc.count()) await loc.check({ force: true });
            else await page.locator(`input[type="checkbox"][name="${target.name}"]`).first().check({ force: true });
            qa.push({ q: q.slice(0, 60), a: target.label.slice(0, 40) });
          } catch (e) { console.log('check err', e.message); }
        }
        continue;
      }
      // text / textarea
      if (card.texts.length) {
        for (const t of card.texts) {
          if (!t.name) continue;
          const ql = q.toLowerCase().trim();
          let val = null;
          if (ov) val = ov.val === '' ? null : ov.val;
          else if (/middle name|middle initial/.test(ql)) val = null;
          else if (/address line 2|apt|suite|unit/.test(ql)) val = null;
          else if (/twitter|(^| )x (url|profile|handle)/.test(ql)) val = null;
          else val = policy.textAnswer(q);
          if (val == null && /why|excite|interest|tell us|describe your|what.*(interest|excite|draw|motivat)|reason for|motivat|cover letter|anything else you|what makes you|why (are|do) you/.test(ql)) val = positioning;
          if (val == null && t.tag === 'TEXTAREA' && /✱|\*|required/.test(q)) val = positioning;
          if (val != null && val !== '') {
            try {
              await page.locator(`[name="${t.name}"]`).first().fill(String(val));
              qa.push({ q: q.slice(0, 60), a: String(val).slice(0, 50) });
            } catch (e) { console.log('text err', e.message); }
          }
        }
      }
    }

    // EEO block (Lever renders selects named 'eeo[...]') → decline options only
    for (const [rx, want] of [
      [/gender/i, DECLINE_RE],
      [/race|ethnic/i, DECLINE_RE],
      [/veteran/i, /not a (protected )?veteran|decline|prefer not/i],
      [/disability/i, /do not (wish|want)|decline|prefer not/i],
    ]) {
      const sels = await page.locator('select').all();
      for (const s of sels) {
        const nm = await s.getAttribute('name').catch(() => '') || '';
        if (!/eeo|gender|race|veteran|disab/i.test(nm)) continue;
        const opts2 = await s.evaluate((el) => Array.from(el.options).map((o) => o.text));
        const pick = opts2.find((o) => want.test(o));
        if (pick && rx.test(nm + ' ' + opts2.join(' '))) { try { await s.selectOption({ label: pick }); } catch { /* optional */ } }
      }
    }

    // Committed values sanity dump
    const dump = await page.evaluate(() => {
      const g = (n) => (document.querySelector(`[name="${n}"]`) || {}).value || '';
      return { name: g('name'), email: g('email'), phone: g('phone'), org: g('org') };
    });
    console.log('CORE_COMMITTED:', JSON.stringify(dump));
    if (result.warnings.length) console.log('FIELD WARNINGS:', JSON.stringify(result.warnings));

    const shotBase = (role.url.match(/lever\.co\/([^/]+)/) || [])[1] || 'x';
    try { await page.screenshot({ path: path.join(SHOT_DIR, `lever_${shotBase}.png`), fullPage: true }); } catch { /* best-effort */ }

    if (opts.prep) {
      console.log('PREP_READY — form filled; a human must solve the hCaptcha and click Submit. Leaving the tab OPEN.');
      result.status = 'prep';
      result.note = 'manual_captcha_submit';
      return result;
    }
    if (opts.dryRun) {
      result.status = 'dry_run';
      result.note = 'filled_not_submitted';
      return result;
    }

    // Pre-submit fence hook.
    if (opts.beforeSubmit) {
      try { await opts.beforeSubmit(result); }
      catch (e) {
        result.status = 'failed';
        result.note = 'submit_fence_failed_no_submit: ' + (e.message || '').slice(0, 150);
        return result;
      }
    }

    // Submit — target Lever's real submit button (#btn-submit); the generic
    // selector also matches a hidden #hcaptchaSubmitBtn (not clickable).
    let submitBtn = page.locator('button#btn-submit').first();
    if (await submitBtn.count() === 0) submitBtn = page.locator('button:has-text("Submit application"), button[type="submit"]:not(.hidden):not(#hcaptchaSubmitBtn)').first();
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await submitBtn.click({ force: true }).catch(async () => { try { await submitBtn.click(); } catch (e) { console.log('submit retry err', e.message); } });
    result.submitClicked = true;
    await sleep(7000);
    let final = ''; try { final = await page.evaluate(() => document.body.innerText); } catch { /* navigated */ }
    let curUrl = ''; try { curUrl = page.url(); } catch { /* navigated */ }
    const success = /thanks|thank you|application (received|submitted)|received your application|we'?ll be in touch/i.test(final)
      || /thanks|confirmation|\/apply\/success/i.test(curUrl)
      || (await page.locator('input[name="name"]').count()) === 0;
    const errs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.form-field-error, [class*="error"], [aria-invalid="true"]'))
        .map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 200)
    ).catch(() => []);
    try { await page.screenshot({ path: path.join(SHOT_DIR, `lever_${shotBase}_after.png`), fullPage: true }); } catch { /* best-effort */ }
    if (success) result.status = 'done';
    else { result.status = 'failed'; result.note = 'submit_no_success ' + JSON.stringify(errs.slice(0, 5)).slice(0, 160); }
  } catch (e) {
    console.log('FATAL', e.message);
    result.status = 'failed';
    result.note = 'fatal:' + e.message.slice(0, 150);
  }
  return result;
}

module.exports = { applyLeverRole, SHOT_DIR };
