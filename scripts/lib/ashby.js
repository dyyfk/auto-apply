// Ashby (jobs.ashbyhq.com) form driver. Fills and (optionally) submits one
// application, driven by the applicant profile + answer policy.
//
// Inherited hard-won behavior — the inline comments record the incidents that
// forced each rule; keep them when refactoring:
//   - EEO / diversity questions are SKIPPED, never auto-answered.
//   - Unknown radio groups (no option matching the intended answer) are
//     SKIPPED and surfaced in result.warnings instead of guessed.
//   - Cap/dup banners ("application limit", "previously received your
//     application") are FAILURE — a cap banner is not a success banner.
//   - Ashby's submit mutation carries NO field values; fields commit via
//     debounced ApiSetFormValue calls. The COMMIT LEDGER below records what the
//     server was actually told — the DOM and screenshots both lie.
//   - opts.beforeSubmit is the fence hook (markSubmitted); if it throws we do
//     NOT click (fail closed).
//
// NO DB writes in here — recording is the caller's job via lib/api.js.

'use strict';

const path = require('path');
const fs = require('fs');
const { startDateFourWeeksOut } = require('./answers');

const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'screenshots');

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function reactFill(page, id, value) {
  await page.evaluate((args) => {
    const el = document.getElementById(args.id);
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, args.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, { id, value });
  await page.waitForTimeout(200);
}

// Two fixes found via validation probe (a REQUIRED salary field showed its
// value on screen yet submitted as "Missing entry for required field"):
//   * blur: locator.blur() does not reliably make Ashby commit the typed value
//     to its form store. A real Tab keypress does.
//   * Control+a: on macOS that is "move to line start", not select-all, so
//     re-filling a non-empty field PREPENDED instead of replacing.
//     ControlOrMeta maps to Meta on darwin and Control elsewhere.
async function ashbyFill(page, id, value) {
  const sel = /^[0-9]/.test(id) || /\s/.test(id) ? `[id="${id}"]` : `#${id}`;
  await page.locator(sel).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(String(value), { delay: 12 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
}

async function probe(page) {
  return await page.evaluate(() => {
    const out = { inputs: [], textareas: [], radios: [], yesNoQs: [], checkboxes: [] };
    document.querySelectorAll('input').forEach((t) => {
      if (t.type === 'file' || t.type === 'hidden' || t.type === 'radio' || t.type === 'checkbox') return;
      const fld = t.closest('.ashby-application-form-field-entry, fieldset, [class*="field"]');
      const lab = fld?.querySelector('label, legend')?.innerText || '';
      out.inputs.push({ id: t.id, name: t.name, type: t.type, label: lab, placeholder: t.placeholder });
    });
    document.querySelectorAll('textarea').forEach((t) => {
      const fld = t.closest('.ashby-application-form-field-entry, [class*="field"]');
      const lab = fld?.querySelector('label')?.innerText || '';
      out.textareas.push({ id: t.id, label: lab });
    });
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      let labText = '';
      if (r.id) { const forLab = document.querySelector(`label[for="${r.id}"]`); if (forLab) labText = forLab.innerText || ''; }
      if (!labText) labText = r.closest('label')?.innerText || '';
      if (!labText) { const sib = r.parentElement?.querySelector('label, span'); labText = sib?.innerText || ''; }
      if (!labText) labText = r.parentElement?.innerText || '';
      const fld = r.closest('.ashby-application-form-field-entry, fieldset');
      const qLab = fld?.querySelector('label, legend')?.innerText || '';
      out.radios.push({ id: r.id, name: r.name, value: r.value, optionLabel: labText.trim(), questionLabel: qLab });
    });
    document.querySelectorAll('.ashby-application-form-field-entry, fieldset').forEach((f) => {
      const btns = Array.from(f.querySelectorAll('button')).map((b) => b.innerText.trim());
      if (btns.includes('Yes') && btns.includes('No')) out.yesNoQs.push(f.querySelector('label, legend')?.innerText || '');
    });
    document.querySelectorAll('input[type="checkbox"]').forEach((c) => {
      let labText = '';
      if (c.id) { const forLab = document.querySelector(`label[for="${c.id}"]`); if (forLab) labText = forLab.innerText || ''; }
      if (!labText) labText = c.closest('label')?.innerText || '';
      const fld = c.closest('.ashby-application-form-field-entry, fieldset');
      const qLab = fld?.querySelector('label, legend')?.innerText || '';
      out.checkboxes.push({ id: c.id, name: c.name, optionLabel: labText.trim(), questionLabel: qLab });
    });
    return out;
  });
}

async function checkOption(page, opt, groupName) {
  try {
    const sel = opt.id ? `[id="${opt.id}"]` : `input[name="${groupName}"][value="${opt.value}"]`;
    await page.locator(sel).first().scrollIntoViewIfNeeded();
    await page.locator(sel).first().check({ force: true });
  } catch {
    try {
      if (opt.id) {
        const lbl = page.locator(`label[for="${opt.id}"]`).first();
        if (await lbl.count() > 0) await lbl.click({ force: true, timeout: 2000 });
      }
    } catch { /* surfaced by caller's verification */ }
  }
  await page.waitForTimeout(200);
}

/**
 * Fill + (optionally) submit one Ashby application.
 *
 * @param page    Playwright page (caller closes it).
 * @param role    { company, title|role_title, url, overrides?: { why?, essay?, answers?: [{re, flags?, val}] } }
 *                overrides.answers match on field LABEL, highest priority.
 *                val === '' means "leave this field blank/unanswered".
 * @param policy  answer policy from lib/answers.buildPolicy(profile)
 * @param opts    { dryRun?: boolean, beforeSubmit?: async fn(result) }
 * @returns { company, title, url, company_key, role_key, status: 'done'|'failed'|'dry_run',
 *            note, shot, submitClicked, validationBlocked?, missingFields?, warnings: [] }
 */
async function applyAshbyRole(page, role, policy, opts = {}) {
  const profile = policy.profile;
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const overrides = role.overrides || {};
  const title = role.title || role.role_title;
  const companyKey = normKey(role.company);
  const roleKey = normKey(title);
  const why = role.why || overrides.why || profile.background;
  const essay = role.essay || overrides.essay || profile.background;
  const answerOverrides = Array.isArray(overrides.answers) ? overrides.answers : [];
  const findOverride = (label) => answerOverrides.find((o) => {
    try { return new RegExp(o.re, o.flags || 'i').test(label || ''); } catch { return false; }
  });

  const numberFills = []; // re-asserted against the commit ledger before submit
  const result = {
    company: role.company, title, url: role.url,
    company_key: companyKey, role_key: roleKey,
    status: 'unknown', note: '', submitClicked: false,
    warnings: [],
  };
  console.log(`\n=== ${role.company} — ${title} ===`);

  // COMMIT LEDGER: the only trustworthy record of "did this value take" is the
  // set of ApiSetFormValue calls the page made — not the DOM, not a screenshot.
  const committed = new Map();
  page.on('request', (req) => {
    try {
      if (req.method() !== 'POST') return;
      const u = req.url();
      if (!/non-user-graphql/.test(u) || !/ApiSetFormValue/.test(u)) return;
      const v = (JSON.parse(req.postData() || '{}').variables) || {};
      if (v.path !== undefined) committed.set(String(v.path), v.value);
    } catch { /* ledger is best-effort */ }
  });

  try {
    await page.goto(role.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    if (await page.locator('#_systemfield_name').count() === 0) {
      await page.goto(role.url + '/application', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
    }
    if (await page.locator('#_systemfield_name').count() === 0) {
      result.status = 'failed'; result.note = 'no_form_found'; return result;
    }

    // 1) Resume first (avoid autofill races). Ashby can FAIL the async upload
    // while still rendering the filename chip — verify no failure toast, retry.
    if (await page.locator('#_systemfield_resume').count() > 0) {
      const uploadFailedRe = /failed to upload|upload failed|error uploading/i;
      let uploaded = false;
      for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
        try {
          await page.setInputFiles('#_systemfield_resume', profile.resume);
          await page.waitForTimeout(2600);
          const bodyTxt = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (!uploadFailedRe.test(bodyTxt)) { uploaded = true; break; }
          console.log(`resume upload FAILED (attempt ${attempt}/3) — retrying`);
          try {
            const closeBtn = page.locator('[class*="toast"] button, [role="alert"] button, [class*="Toast"] button').first();
            if (await closeBtn.count() > 0) await closeBtn.click({ timeout: 2000 });
          } catch { /* toast may have auto-dismissed */ }
          await page.waitForTimeout(1200);
        } catch (e) { console.log('resume err', e.message); await page.waitForTimeout(1200); }
      }
      if (!uploaded) result.warnings.push('resume_upload_failed');
    }

    // 2) Name + email
    await ashbyFill(page, '_systemfield_name', profile.name);
    await ashbyFill(page, '_systemfield_email', profile.email);

    // 3) Probe
    const p1 = await probe(page);
    console.log('INPUTS:', p1.inputs.length, 'TXT:', p1.textareas.length, 'RADIOS:', p1.radios.length, 'YESNO:', p1.yesNoQs.length, 'CHK:', p1.checkboxes.length);

    // 4) Phone
    for (const pf of await page.locator('input[type="tel"]').all()) {
      try { await pf.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(profile.phone, { delay: 20 }); await pf.blur(); } catch { /* re-checked in 11b */ }
    }

    // 5) Location autocomplete → the candidate's actual city.
    // NOT every "Start typing..." combobox is a location: "How did you hear
    // about this job?" can use the same widget — typing the city into it left a
    // required field effectively blank at submit. Skip source questions here.
    for (const f of await page.locator('input[placeholder="Start typing..."]').all()) {
      try {
        const entryLab = await f.evaluate((el) => {
          const fld = el.closest('.ashby-application-form-field-entry, fieldset, [class*="field"]');
          const l = fld && fld.querySelector('label, legend');
          return l ? l.innerText : '';
        }).catch(() => '') || '';
        if (policy.isSourceQuestion(entryLab)) continue;
        await f.click(); await page.keyboard.type(profile.city, { delay: 30 }); await page.waitForTimeout(900);
        const opt = page.locator('[role="option"]').filter({ hasText: new RegExp(profile.city) }).first();
        if (await opt.count() > 0) await opt.click(); else await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } catch (e) { console.log('autocomp err', e.message); }
    }

    // 6) Text inputs by label
    for (const t of p1.inputs) {
      if (!t.id || t.id.startsWith('_systemfield_')) continue;
      if (t.type !== 'text' && t.type !== '' && t.type !== 'url' && t.type !== 'number') continue;
      const lab = (t.label || '').toLowerCase();
      const ov = findOverride(t.label);
      // Empty override value = "leave this field blank" — the only way to
      // suppress a label rule that would otherwise answer wrongly.
      if (ov && String(ov.val) === '') continue;
      // type="url" inputs reject anything that isn't a bare URL and block the
      // submit. Ignore a non-URL override on a URL field.
      let ovVal = ov ? ov.val : null;
      if (ovVal !== null && t.type === 'url' && !/^https?:\/\/\S+$/i.test(String(ovVal).trim())) {
        result.warnings.push('url_override_not_url: "' + (t.label || '').slice(0, 80) + '"');
        ovVal = null;
      }
      // number inputs must never receive prose; only an explicit override or a
      // numeric-intent label. Anything else is left blank + warned.
      if (t.type === 'number' && !ov) {
        if (/years of (relevant )?(software|engineering|professional) experience|years of experience|yoe/.test(lab) && profile.yoe) {
          await ashbyFill(page, t.id, profile.yoe);
          numberFills.push({ id: t.id, value: String(profile.yoe), label: t.label });
        } else {
          result.warnings.push('number_blank: "' + (t.label || '').slice(0, 80) + '"');
        }
        continue;
      }
      if (ovVal !== null) {
        await ashbyFill(page, t.id, ovVal);
        if (t.type === 'number') numberFills.push({ id: t.id, value: String(ovVal), label: t.label });
        continue;
      }

      // "Preferred Name" can be REQUIRED with helper text "enter your legal
      // first name if you don't have one". Label may carry a double space.
      if (/preferred\s+(first\s+)?name/.test(lab)) { await ashbyFill(page, t.id, profile.preferredName); continue; }
      if (/applying to work on something specific|are you applying.*specific|work on specifically/.test(lab)) {
        await ashbyFill(page, t.id, profile.positioning); continue;
      }
      if (/other links|portfolio links|relevant links/.test(lab) && profile.website) {
        await ashbyFill(page, t.id, profile.website); continue;
      }

      const answer = policy.textAnswer(t.label);
      if (answer) { await ashbyFill(page, t.id, answer); continue; }

      // Catch-all essay matcher — never on url/number fields.
      if (t.type !== 'url' && /long[- ]?answer|why|tell us|describe|introduce yourself|self[- ]?intro|what|how/.test(lab) && lab.length > 12) {
        await reactFill(page, t.id, essay || why);
        continue;
      }
      // NO RULE MATCHED → left blank, loudly. A silent blank on a required
      // field is the classic "clean warning log != filled form" trap.
      result.warnings.push('text_blank: "' + (t.label || '').slice(0, 80) + '" type=' + t.type);
    }

    // 6b) Text inputs with NO id — the id pass can't touch these; address them
    // positionally and type Playwright-natively so Ashby's form-store handler
    // actually fires. Iterate the INPUTS (some fieldsets carry none of the
    // standard container classes and are invisible to a container loop).
    for (const inp of await page.locator('input[type="text"], input[type="number"], input[role="combobox"], input:not([type])').all()) {
      try {
        if (await inp.getAttribute('id')) continue;
        if (await inp.inputValue()) continue;
      } catch { continue; }
      const rawLab = await inp.evaluate((el) => {
        const fld = el.closest('.ashby-application-form-field-entry, fieldset, [class*="fieldEntry"], [class*="field"]');
        const l = fld && fld.querySelector('label, legend');
        return l ? l.innerText : '';
      }).catch(() => '') || '';
      const lab = rawLab.toLowerCase();
      const ov = findOverride(rawLab);
      const isDatePicker = /pick date/i.test(await inp.getAttribute('placeholder').catch(() => '') || '');
      const isSourceQ = policy.isSourceQuestion(rawLab);
      let value = null;
      if (ov) value = ov.val;
      else if (isDatePicker) value = policy.textAnswer(rawLab, { isDatePicker: true }) || startDateFourWeeksOut();
      else value = policy.textAnswer(rawLab);
      if (!value) {
        result.warnings.push('idless_blank: "' + rawLab.slice(0, 80) + '"');
        continue;
      }
      try {
        await inp.scrollIntoViewIfNeeded();
        await inp.click();
        // Many of these are autocomplete combos: type the short form, take a
        // matching option if one opens, else fall back to the literal string.
        const short = /location|residence/.test(lab) ? profile.city : value;
        await page.keyboard.type(short, { delay: 25 });
        await page.waitForTimeout(1100);
        const opt = page.locator('[role="option"]:visible').filter({ hasText: new RegExp(profile.city) }).first();
        if (isSourceQ) {
          // Source questions are usually a strict combobox: commit by picking
          // the matching option, never by leaving free text behind.
          const sOpt = page.locator('[role="option"]:visible')
            .filter({ hasText: new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
          if (await sOpt.count() > 0) await sOpt.click();
          else await inp.blur().catch(() => {});
        } else if (/location|residence/.test(lab) && await opt.count() > 0) {
          await opt.click();
        } else if (short !== value) {
          await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.type(value, { delay: 15 });
          await inp.blur().catch(() => {});
        } else {
          await inp.blur().catch(() => {});
        }
        await page.waitForTimeout(300);
        const after = await inp.inputValue().catch(() => '');
        if (!after) result.warnings.push('idless_blank_after_fill: "' + rawLab.slice(0, 80) + '"');
      } catch (e) {
        result.warnings.push('idless_fill_error: "' + rawLab.slice(0, 80) + '"');
      }
    }

    // 7) Textareas
    for (const ta of p1.textareas) {
      if (!ta.id || ta.id.startsWith('g-recaptcha')) continue;
      const lab = (ta.label || '').toLowerCase();
      const ov = findOverride(ta.label);
      let value = why;
      if (ov) value = ov.val;
      else if (/self[- ]?intro|introduce yourself|tell us about yourself|about you|essay|elaborate|anything else/.test(lab) && essay) value = essay;
      else if (/sponsorship.*explain|if yes.*explain|please explain|explain.*sponsorship|visa status/i.test(lab)) value = profile.sponsorshipExplain;
      await reactFill(page, ta.id, value);
    }

    // 8) Pronouns → the non-disclosing option, scoped to the pronoun QUESTION
    // (a global "Prefer not to say" click once grabbed whichever decline-label
    // appeared first on the page). Declining is not a demographic claim, so
    // this one is safe to auto-answer — unlike the groups skipped below.
    {
      const declineRe = /prefer not to (answer|say|disclose)|do not wish|don'?t wish/i;
      const pronounOpts = [...p1.radios, ...p1.checkboxes]
        .filter((o) => /pronoun/i.test(o.questionLabel || ''))
        .filter((o) => declineRe.test(o.optionLabel || ''));
      for (const o of pronounOpts.slice(0, 1)) await checkOption(page, o, o.name);
    }

    // 8b) Checkbox groups with an explicit caller override — REQUIRED checkbox
    // groups (e.g. office-location multi-select) otherwise reach submit
    // unchecked. Fires ONLY on an explicit override, never a guess; the
    // demographic guard still applies.
    {
      const chkGroups = {};
      for (const c of p1.checkboxes) {
        const q = c.questionLabel || '';
        if (!q) continue;
        (chkGroups[q] = chkGroups[q] || []).push(c);
      }
      for (const qLab in chkGroups) {
        if (policy.isDemographic(qLab) || /pronoun/i.test(qLab)) continue;
        const cov = findOverride(qLab);
        if (!cov || !cov.val) continue;
        // Yes/No BUTTON questions are backed by a hidden checkbox with an empty
        // option label — answered by the Yes/No pass, not here.
        if (chkGroups[qLab].every((o) => !(o.optionLabel || '').trim())) continue;
        const wanted = String(cov.val).toLowerCase();
        const target = chkGroups[qLab].find((o) => (o.optionLabel || '').toLowerCase().includes(wanted));
        if (!target) {
          result.warnings.push('checkbox_override_miss: "' + qLab.slice(0, 80) + '"');
          continue;
        }
        await checkOption(page, target, target.name);
        await page.waitForTimeout(100);
      }
    }

    // 9) Radio groups
    const radioGroups = {};
    for (const r of p1.radios) { if (!r.name) continue; (radioGroups[r.name] = radioGroups[r.name] || []).push(r); }
    for (const name in radioGroups) {
      const group = radioGroups[name];
      const qLab = group[0].questionLabel || '';
      // SAFETY: never auto-fill demographic / diversity-survey questions.
      if (policy.isDemographic(qLab) || /pronoun/i.test(qLab)) {
        console.log('RADIO Q (demographic, SKIPPED):', qLab.slice(0, 70));
        continue;
      }
      // "How did you hear about us" — pick a sensible source option.
      if (policy.isSourceQuestion(qLab)) {
        const pref = [profile.howHeard, 'linkedin', 'company website', 'website', 'job board', 'other'].filter(Boolean);
        let src = null;
        for (const p of pref) { src = group.find((o) => new RegExp(p, 'i').test(o.optionLabel || '')); if (src) break; }
        if (!src) src = group[group.length - 1]; // last option is usually "Other"
        await checkOption(page, src, name);
        continue;
      }
      // EXPLICIT ENUM OVERRIDE: pick the option containing the override value.
      // Runs AFTER the demographic guard, so an override can never touch a
      // diversity group.
      const rov = findOverride(qLab);
      if (rov && rov.val) {
        const ovVal = String(rov.val).toLowerCase();
        const ovTarget = group.find((o) => (o.optionLabel || '').toLowerCase().includes(ovVal))
          || group.find((o) => (o.value || '').toLowerCase().includes(ovVal));
        if (ovTarget) { await checkOption(page, ovTarget, name); continue; }
        result.warnings.push('radio_override_miss: "' + qLab.slice(0, 80) + '"');
      }
      // MARKETING/SMS CONSENT OPT-IN → decline. Keyed on OPTION labels, not the
      // question label (consent radios can render inside the "Phone Number"
      // field entry). Consent opt-ins must never default to Yes.
      const consentNo = group.find((o) => /^no\b.*\b(consent|opt)/i.test((o.optionLabel || '').trim()));
      const consentYes = group.find((o) => /^yes\b.*\bconsent(ing)? to receiv/i.test((o.optionLabel || '').trim()));
      if (consentNo && consentYes) { await checkOption(page, consentNo, name); continue; }

      const want = policy.pickYesNo(qLab);
      let target = want && group.find((o) => new RegExp('^' + want + '\\b', 'i').test((o.optionLabel || '').trim().split('\n')[0].trim()));
      if (!target && want) target = group.find((o) => new RegExp('^' + want + '$', 'i').test((o.value || '').trim()));
      // SAFETY: no option matches the intended answer => this is NOT a plain
      // Yes/No group and we cannot know which option asserts what. SKIP + warn.
      // If the field is required, the submit fails validation — correct
      // fail-safe: the role records failed+transient and a human reviews it,
      // instead of the form carrying a false claim.
      if (!target) {
        const opts2 = group.map((o) => (o.optionLabel || o.value || '').slice(0, 40));
        result.warnings.push('radio_skipped: "' + qLab.slice(0, 80) + '" wanted=' + want + ' options=' + JSON.stringify(opts2.slice(0, 5)));
        continue;
      }
      console.log('RADIO Q:', qLab.slice(0, 70), '->', want);
      await checkOption(page, target, name);
    }

    // 10) Yes/No buttons — per fieldset (avoid global index drift)
    for (const fsEl of await page.locator('.ashby-application-form-field-entry, fieldset').all()) {
      const yesBtn = fsEl.locator('button').filter({ hasText: /^Yes$/ });
      const noBtn = fsEl.locator('button').filter({ hasText: /^No$/ });
      if (await yesBtn.count() === 0 || await noBtn.count() === 0) continue;
      const lab = await fsEl.locator('label, legend').first().innerText().catch(() => '');
      // Same demographic guard as the radio pass — a form rendering "Do you
      // identify as LGBTQ+?" as Yes/No buttons must not get the default Yes.
      if (policy.isDemographic(lab)) continue;
      // Explicit caller override; "val": "" means LEAVE UNANSWERED (used for
      // optional questions we should not answer on the user's behalf).
      const yov = findOverride(lab);
      let answer;
      if (yov !== undefined && yov !== null) {
        const v = String(yov.val).trim();
        if (v === '') continue;
        if (/^y/i.test(v)) answer = 'yes';
        else if (/^n/i.test(v)) answer = 'no';
        else result.warnings.push('yesno_override_unparsed: "' + lab.slice(0, 80) + '"');
      }
      if (!answer) answer = policy.pickYesNo(lab);
      if (!answer) {
        // Tri-state skip (e.g. criminal-record question with no profile answer).
        result.warnings.push('yesno_skipped: "' + lab.slice(0, 80) + '"');
        continue;
      }
      console.log('Q:', lab.slice(0, 80), '->', answer);
      // A single click paints the button active but does NOT reliably register
      // with Ashby's form store — sponsorship questions came back "Missing
      // entry for required field" while the screenshot showed Yes selected.
      // Clicking the OTHER option first forces a real transition and commits
      // every time. Final state is the intended answer.
      const wantedBtn = answer === 'yes' ? yesBtn.first() : noBtn.first();
      const otherBtn = answer === 'yes' ? noBtn.first() : yesBtn.first();
      try {
        await otherBtn.click({ timeout: 3000 });
        await page.waitForTimeout(400);
        await wantedBtn.click({ timeout: 3000 });
      } catch (e) { console.log('btn click fail', e.message); }
      await page.waitForTimeout(500);
      const activeOk = await wantedBtn.evaluate((el) => /_active_/.test(el.className)).catch(() => null);
      if (activeOk === false) {
        result.warnings.push('yesno_not_active: "' + lab.slice(0, 80) + '" wanted=' + answer);
      }
    }

    // 11) Re-probe conditional follow-up textareas (revealed by Yes answers)
    await page.waitForTimeout(800);
    const p2 = await probe(page);
    for (const ta of p2.textareas) {
      if (!ta.id || ta.id.startsWith('g-recaptcha')) continue;
      const cur = await page.evaluate((id) => { const el = document.getElementById(id); return el ? el.value : ''; }, ta.id);
      if (cur && cur.length > 5) continue;
      const lab = (ta.label || '').toLowerCase();
      const ov = findOverride(ta.label);
      let value = why;
      if (ov) value = ov.val;
      else if (/sponsorship.*explain|if yes.*explain|please explain|explain.*sponsorship|visa status/i.test(lab)) value = profile.sponsorshipExplain;
      else if (/self[- ]?intro|introduce yourself|tell us about yourself|about you|essay|anything else/.test(lab) && essay) value = essay;
      await reactFill(page, ta.id, value);
    }

    // 11b) Ensure phone fields are actually filled (a required Phone Number
    // once reached submit blank).
    for (const pf of await page.locator('input[type="tel"]').all()) {
      try {
        const v = await pf.inputValue().catch(() => '');
        if (!v || v.replace(/\D/g, '').length < 7) {
          await pf.click(); await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.type(profile.phone, { delay: 20 }); await pf.blur();
        }
      } catch { /* checked again below */ }
    }
    const p3 = await probe(page);
    for (const inp of p3.inputs) {
      if (!inp.id || inp.id.startsWith('_systemfield_')) continue;
      const lab = (inp.label || '').toLowerCase();
      const ph = (inp.placeholder || '').toLowerCase();
      if (/phone/.test(lab) || /phone/.test(ph)) {
        const cur = await page.evaluate((id) => { const el = document.getElementById(id); return el ? el.value : ''; }, inp.id);
        if (!cur || cur.replace(/\D/g, '').length < 7) await ashbyFill(page, inp.id, profile.phone);
      }
    }

    // 12) Submit

    // 12a) RE-ASSERT + FLUSH number inputs against the COMMIT LEDGER. A number
    // input emits null mid-edit and its real value lands a beat later, so a
    // submit click can outrun the debounced flush while the DOM shows the value
    // the whole time. Re-type until the ledger agrees, then give up loudly.
    for (const nf of numberFills) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const seen = committed.has(nf.id) ? String(committed.get(nf.id)) : null;
        if (seen === String(nf.value)) break;
        console.log(`NUMBER NOT COMMITTED (attempt ${attempt}/3):`, (nf.label || nf.id).slice(0, 50));
        try {
          // Blank first so the re-type is a real transition Ashby resends.
          await ashbyFill(page, nf.id, '');
          await page.waitForTimeout(600);
          await ashbyFill(page, nf.id, nf.value);
        } catch (e) { console.log('number re-assert err', e.message); }
        await page.waitForTimeout(2200);
      }
      const finalSeen = committed.has(nf.id) ? String(committed.get(nf.id)) : null;
      if (finalSeen !== String(nf.value)) {
        result.warnings.push('number_not_committed: "' + (nf.label || nf.id).slice(0, 70) + '"');
      }
    }

    await page.waitForTimeout(800);

    if (result.warnings.length) console.log('FIELD WARNINGS:', JSON.stringify(result.warnings));

    // DRY RUN: everything above ran (field mapping is reviewable in the logs +
    // screenshot) but stop HERE — no click, no ATS burn.
    if (opts.dryRun) {
      const shotPath = path.join(SHOT_DIR, `dryrun_${companyKey}_${roleKey}.png`);
      try { await page.screenshot({ path: shotPath, fullPage: true }); } catch { /* screenshot is best-effort */ }
      result.shot = shotPath;
      result.status = 'dry_run';
      result.note = 'dry_run_no_submit';
      console.log('DRY_RUN — form filled, NOT submitting. screenshot:', shotPath);
      return result;
    }

    // Pre-submit fence hook (markSubmitted). If it throws, do NOT click.
    if (opts.beforeSubmit) {
      try { await opts.beforeSubmit(result); }
      catch (e) {
        result.status = 'failed';
        result.note = 'submit_fence_failed_no_submit: ' + (e.message || '').slice(0, 150);
        return result;
      }
    }

    // First-click-wins guard: a single click once double-fired onclick+onsubmit
    // → two POSTs, two confirmation emails.
    await page.evaluate(() => {
      let clicked = false, submitted = false;
      document.querySelectorAll('button[type="submit"], button:not([type])').forEach((b) => {
        b.addEventListener('click', (e) => {
          if (clicked) { e.preventDefault(); e.stopImmediatePropagation(); return false; }
          clicked = true;
        }, true);
      });
      document.querySelectorAll('form').forEach((f) => {
        f.addEventListener('submit', (e) => {
          if (submitted) { e.preventDefault(); e.stopImmediatePropagation(); return false; }
          submitted = true;
        }, true);
      });
    });

    await page.locator('button:has-text("Submit Application")').first().click();
    result.submitClicked = true;
    await page.waitForTimeout(7000);

    // 13) Success check. Form-unmount is the reliable half; cap/dup banners
    // also unmount the form and are FAILURE.
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const formGone = (await page.locator('#_systemfield_name').count().catch(() => 1)) === 0;
    const spam = /flagged as possible spam|couldn'?t submit|previously received your application|application limit|already applied/i.test(text);
    const success = formGone && !spam;

    const missingMatch = text.match(/Missing entry for required field:[^\n]+/g);
    const shotPath = path.join(SHOT_DIR, `ashby_${companyKey}_${roleKey}.png`);
    try { await page.screenshot({ path: shotPath, fullPage: true }); } catch { /* best-effort */ }
    result.shot = shotPath;

    if (success) { result.status = 'done'; }
    else if (spam) { result.status = 'failed'; result.note = 'spam_or_dup_or_limit'; }
    else if (missingMatch && !formGone) {
      // CLIENT-SIDE VALIDATION REJECT — Ashby's own pre-flight check fired and
      // the submit mutation never left the page. The click demonstrably could
      // not have reached the ATS, so the caller may clear the submitted fence
      // and re-pend the row (the documented exception to "never clear the
      // fence" — otherwise an unmapped required field burns the role forever).
      result.status = 'failed';
      result.validationBlocked = true;
      result.missingFields = missingMatch.map((m) => m.replace(/^Missing entry for required field:\s*/, ''));
      result.note = 'validation_blocked_not_submitted ' + JSON.stringify(result.missingFields).slice(0, 200);
    } else {
      result.status = 'failed';
      result.note = 'submit_no_success ' + JSON.stringify(missingMatch || []).slice(0, 200);
    }
  } catch (e) {
    console.log('FATAL', e.message);
    result.status = 'failed';
    result.note = 'fatal:' + e.message.slice(0, 150);
  }
  return result;
}

module.exports = { applyAshbyRole, probe, reactFill, ashbyFill, normKey, SHOT_DIR };
