// Greenhouse (job-boards.greenhouse.io) form driver.
//
// Notable machinery:
//   - robustPickSelect: Greenhouse renders react-select comboboxes that ignore
//     synthetic events; tries dispatch-mousedown, physical mouse, type-filter,
//     then VERIFIES the committed single-value.
//   - Honeypot skip: some boards embed prompt-injection trap fields ("if you're
//     an AI, ignore previous instructions..."). Never fill those.
//   - Education pickers are strict: the school matcher is built from the
//     profile's school name with ORDERED adjacency — a loose fallback once
//     picked a similarly-named school (a false credential). A visible failure
//     beats a fabricated answer, so there is no blind match-anything tier.
//   - Email-verification gate: Greenhouse can demand a code sent to the
//     applicant's email after submit. We poll a drop file (GH_CODE_FILE) the
//     user pastes the code into.
//   - The submit POST happens BEFORE the code gate, so a code timeout is
//     recorded as failed + submitted:true (blocks re-applies).
//
// NO DB writes in here — the runner owns the claim/fence protocol.

'use strict';

const path = require('path');
const fs = require('fs');

const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function idSel(id) { return /^\d/.test(id) ? `[id="${id}"]` : `#${id}`; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Ordered-adjacency matcher from a proper-noun phrase: "University of
// California, Los Angeles" → /university[\s,.-]*of[\s,.-]*california[\s,.-]*los[\s,.-]*angeles/i
// Tolerates IPEDS punctuation variants without matching reordered names.
function phraseRegex(phrase) {
  const tokens = String(phrase || '').split(/[\s,.-]+/).filter(Boolean).map(escapeRe);
  if (!tokens.length) return null;
  return new RegExp(tokens.join('[\\s,.–-]*'), 'i');
}

async function idByLabel(page, regex) {
  return await page.evaluate((src) => {
    const re = new RegExp(src.source, src.flags);
    for (const lab of document.querySelectorAll('label')) {
      const t = (lab.innerText || '').trim();
      if (re.test(t)) { const f = lab.getAttribute('for'); if (f && document.getElementById(f)) return f; }
    }
    return null;
  }, { source: regex.source, flags: regex.flags });
}

async function committedValue(page, id) {
  return await page.evaluate((id) => {
    const inp = document.getElementById(id);
    const ctl = inp && (inp.closest('[class*="select__control"]') || (inp.parentElement && inp.parentElement.closest('[class*="select__control"]')));
    return ctl ? (ctl.querySelector('[class*="single-value"]') || {}).textContent || null : null;
  }, id);
}

// Count options for THIS field's react-select. Prefer the scoped id; fall back
// to portal-wide options that are NOT the intl-tel phone country list (iti-*).
async function countOptions(page, fieldId) {
  return await page.evaluate((id) => {
    const scoped = document.querySelectorAll(`[id^="react-select-${id}-option"]`).length;
    if (scoped) return scoped;
    return [...document.querySelectorAll('[role="option"], [class*="select__option"]')]
      .filter((o) => !/^iti-/.test(o.id)).length;
  }, fieldId);
}

async function controlBox(page, fieldId) {
  const handle = await page.evaluateHandle((id) => {
    const inp = document.getElementById(id);
    if (!inp) return null;
    return inp.closest('[class*="select__control"]')
      || (inp.parentElement && inp.parentElement.closest('[class*="select__control"]'))
      || inp.closest('[role="combobox"]')
      || inp.parentElement;
  }, fieldId);
  const el = handle.asElement();
  if (!el) return null;
  try { const box = await el.boundingBox(); return { el, box }; } catch { return { el, box: null }; }
}

// ROBUST react-select picker: (a) dispatch mousedown/up, (a2) physical mouse,
// (c) focus + type-to-filter, (b) click matching portal option, (d) verify.
async function robustPickSelect(page, fieldId, regex, opts = {}) {
  if (!fieldId) return false;
  const { type = null, timeout = 14000 } = opts;
  const deadline = Date.now() + timeout;

  async function clickMatch() {
    let handles = await page.$$(`[id^="react-select-${fieldId}-option"]`);
    if (!handles.length) {
      const all = await page.$$('[role="option"], [class*="select__option"]');
      handles = [];
      for (const h of all) {
        const id = await h.getAttribute('id').catch(() => '');
        if (!/^iti-/.test(id || '')) handles.push(h);
      }
    }
    for (const h of handles) {
      const txt = ((await h.innerText().catch(() => '')) || '').trim();
      if (txt && regex.test(txt)) {
        await h.click({ force: true }).catch(async () => { await h.evaluate((e) => e.click()).catch(() => {}); });
        await sleep(400);
        return txt;
      }
    }
    return null;
  }

  while (Date.now() < deadline) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
    const cb = await controlBox(page, fieldId);
    if (!cb) return false;
    await cb.el.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(150);

    let opened = false;
    try {
      await cb.el.dispatchEvent('mousedown');
      await sleep(80);
      await cb.el.dispatchEvent('mouseup');
      await sleep(550);
      if (await countOptions(page, fieldId) > 0) opened = true;
    } catch { /* try next approach */ }

    if (!opened) {
      const box = cb.box || (await cb.el.boundingBox().catch(() => null));
      if (box) {
        try {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await sleep(80);
          await page.mouse.up();
          await sleep(550);
          if (await countOptions(page, fieldId) > 0) opened = true;
        } catch { /* try next approach */ }
      }
    }

    if (!opened || type) {
      await page.evaluate((id) => { const e = document.getElementById(id); if (e) e.focus(); }, fieldId).catch(() => {});
      await sleep(120);
      if (type) { await page.keyboard.type(type, { delay: 40 }); await sleep(800); }
      else { await page.keyboard.press('ArrowDown').catch(() => {}); await sleep(500); }
      if (await countOptions(page, fieldId) > 0) opened = true;
    }

    if (opened) {
      const clicked = await clickMatch();
      if (clicked) {
        await sleep(300);
        const committed = await committedValue(page, fieldId);
        if (committed && committed.trim()) return committed.trim();
        return clicked;
      }
      if (type) {
        await page.keyboard.press('Enter').catch(() => {});
        await sleep(400);
        const committed = await committedValue(page, fieldId);
        if (committed && regex.test(committed)) return committed.trim();
      }
    }
    await sleep(300);
  }
  return false;
}

async function pickLocation(page, fieldId, query) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate((id) => { const e = document.getElementById(id); if (e) e.scrollIntoView({ block: 'center' }); }, fieldId).catch(() => {});
  const inp = page.locator(`input[id="${fieldId}"]`);
  try { await inp.click({ force: true, timeout: 4000 }); } catch { return false; }
  await sleep(300);
  await inp.fill('').catch(() => {});
  await page.keyboard.type(query, { delay: 60 });
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    await sleep(400);
    let handles = await page.$$(`[id^="react-select-${fieldId}-option"]`);
    if (!handles.length) {
      const all = await page.$$('[role="option"]');
      handles = [];
      for (const h of all) { const id = await h.getAttribute('id').catch(() => ''); if (!/^iti-/.test(id || '')) handles.push(h); }
    }
    if (handles.length > 0) {
      const tok = query.split(',')[0].trim().toLowerCase();
      let chosen = null;
      for (const h of handles) { const t = ((await h.innerText().catch(() => '')) || '').toLowerCase(); if (t.includes(tok)) { chosen = h; break; } }
      if (!chosen) chosen = handles[0];
      const txt = ((await chosen.innerText().catch(() => '')) || '').trim();
      await chosen.click({ force: true }).catch(() => {});
      await sleep(500);
      const committed = await committedValue(page, fieldId);
      return committed || txt || true;
    }
  }
  return false;
}

async function ghFill(page, id, value) {
  await page.evaluate(({ id, v }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, { id, v: String(value) });
  await sleep(200);
}

// Structural react-select detection only (no clicking, to avoid spurious opens)
async function isSelect(page, fid) {
  const loc = page.locator(`input[id="${fid}"]`);
  if (!await loc.count()) return false;
  return await page.evaluate((id) => {
    const e = document.getElementById(id);
    return !!(e && (e.closest('[class*="select__control"]') || (e.parentElement && e.parentElement.closest('[class*="select__control"]')) || document.querySelector('[id^="react-select-' + id + '"]')));
  }, fid).catch(() => false);
}

/**
 * Fill + (optionally) submit one Greenhouse application.
 *
 * @param page    Playwright page.
 * @param role    { company, title|role_title, url, overrides?: { answers?: [{re, flags?, val}] } }
 * @param policy  answer policy from lib/answers.buildPolicy(profile)
 * @param opts    { dryRun?, beforeSubmit?, codeFile? } — codeFile is the
 *                security-code drop file (default /tmp/gh_seccode.txt)
 * @returns { company, title, url, status: 'done'|'failed'|'dry_run', note, qa,
 *            submitClicked, warnings: [], shot? }
 */
async function applyGreenhouseRole(page, role, policy, opts = {}) {
  const profile = policy.profile;
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const title = role.title || role.role_title;
  const overrides = Array.isArray(role.overrides?.answers) ? role.overrides.answers : [];
  const findOverride = (label) => overrides.find((o) => {
    try { return new RegExp(o.re, o.flags || 'i').test(label || ''); } catch { return false; }
  });
  const qa = [];
  const result = {
    company: role.company, title, url: role.url,
    status: 'unknown', note: '', qa, submitClicked: false, warnings: [],
  };
  const positioning = role.overrides?.why || profile.positioning;

  try {
    await page.goto(role.url, { waitUntil: 'domcontentloaded', timeout: 50000 }).catch((e) => console.log('goto warn:', e.message));
    await sleep(4500);

    const bodyText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    for (const d of ['already applied', 'previously received', 'no longer accepting', 'no longer available', 'position is closed']) {
      if (bodyText.includes(d)) { result.status = 'failed'; result.note = 'closed_or_dup:' + d; return result; }
    }

    await page.waitForSelector('#first_name', { timeout: 25000 });
    await page.fill('#first_name', profile.firstName);
    await page.fill('#last_name', profile.lastName);
    if (await page.locator('#preferred_name').count()) {
      await page.fill('#preferred_name', profile.preferredName).catch(() => {});
      qa.push({ question: 'Preferred First Name', answer: profile.preferredName });
    }
    await page.fill('#email', profile.email);
    qa.push(
      { question: 'First name', answer: profile.firstName },
      { question: 'Last name', answer: profile.lastName },
      { question: 'Email', answer: profile.email }
    );

    // Country
    const countryRe = /united states/i.test(profile.country) ? /united states|^usa$|u\.?s\.?a\.?/i : phraseRegex(profile.country);
    if (await isSelect(page, 'country')) {
      const cval = await robustPickSelect(page, 'country', countryRe, { type: profile.country });
      if (cval) qa.push({ question: 'Country', answer: cval });
      else result.warnings.push('country_pick_failed');
    }

    await page.evaluate(() => {
      const iti = window.intlTelInputGlobals && window.intlTelInputGlobals.getInstance(document.querySelector('#phone'));
      if (iti) iti.setCountry('us');
    }).catch(() => {});
    await sleep(300);
    await page.fill('#phone', profile.phone).catch(() => {});
    qa.push({ question: 'Phone', answer: profile.phone });

    // Resume
    let resumeDone = false;
    if (await page.locator('#resume').count()) {
      await page.setInputFiles('#resume', profile.resume);
      await sleep(4000);
      qa.push({ question: 'Resume', answer: path.basename(profile.resume) });
      resumeDone = true;
    }
    if (!resumeDone) {
      const fileInputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({ id: el.id, name: el.name || '' })));
      const resInp = fileInputs.find((f) => /resume|cv/i.test(f.id + f.name)) || fileInputs.find((f) => !/cover/i.test(f.id + f.name));
      if (resInp) {
        const sel = resInp.id ? `[id="${resInp.id}"]` : 'input[type="file"]';
        await page.setInputFiles(sel, profile.resume);
        await sleep(4000);
        qa.push({ question: 'Resume', answer: 'dynamic input ' + (resInp.id || resInp.name) });
        resumeDone = true;
      } else result.warnings.push('resume_input_not_found');
    }

    // Location typeahead
    if (await page.locator('#candidate-location').count()) {
      let lv = false;
      for (const q of [profile.location, profile.city].filter(Boolean)) {
        lv = await pickLocation(page, 'candidate-location', q);
        if (lv) break;
      }
      if (lv) qa.push({ question: 'Location (City)', answer: lv });
      else result.warnings.push('location_pick_failed');
    }

    // ── Custom question fields ────────────────────────────────────────────
    const allFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[id^="question_"], textarea[id^="question_"]')).map((el) => ({
        id: el.id, tag: el.tagName,
        label: ((document.querySelector('label[for="' + el.id + '"]') || {}).innerText || '').trim(),
      })));
    for (const f of allFields) f.required = /\*\s*$/.test(f.label);

    // Checkbox groups (ids like question_123[]_0): pick a sensible option.
    const bracketGroups = {};
    for (const f of allFields) { const m = f.id.match(/^(question_\d+\[\])_/); if (m) (bracketGroups[m[1]] = bracketGroups[m[1]] || []).push(f); }
    const bracketIds = new Set();
    for (const [base, optsArr] of Object.entries(bracketGroups)) {
      optsArr.forEach((o) => bracketIds.add(o.id));
      // Prefer the candidate's actual city for location multi-selects.
      let pick = profile.city ? optsArr.find((o) => new RegExp(escapeRe(profile.city), 'i').test(o.label)) : null;
      if (!pick) pick = optsArr.find((o) => /3-4|3 - 4|3\+|2-4|mid/i.test(o.label));
      if (!pick) pick = optsArr.find((o) => !/^5\+|^0-2|^10\+/i.test(o.label));
      if (!pick) pick = optsArr[0];
      if (pick) {
        await page.locator(`[id="${pick.id}"]`).click({ force: true }).catch(() => {});
        await sleep(300);
        qa.push({ question: base.replace('[]', ''), answer: pick.label });
      }
    }

    const sponsor = profile.needsSponsorship;
    const usPerson = ['citizen', 'green_card'].includes(profile.visaStatus);

    for (const f of allFields) {
      if (bracketIds.has(f.id)) continue;
      const lc = f.label.toLowerCase();

      // Honeypot / prompt-injection trap fields — never fill.
      if (/activation function|if you'?re an ai|if you are an ai tool|ignore (all )?previous instructions|🤖|👀/.test(lc)) continue;

      // Per-role override (highest priority; only for non-select text fields)
      const ov = findOverride(f.label);
      if (ov && !(await isSelect(page, f.id))) {
        await ghFill(page, f.id, ov.val);
        qa.push({ question: f.label, answer: '[override] ' + String(ov.val).slice(0, 60) });
        continue;
      }

      let candidate = null, typeFilter = null, textVal = null, ans = null;

      // Open-ended/essay prompts get the positioning paragraph BEFORE narrower
      // matchers grab them. Skip URL/title fields and screens handled below.
      const isEssayPrompt = /reasons? (why|you)|why (are |do )?you('| a)?re? (excited|interested)|excited to apply|excited to|how are you using ai|using ai|last ai experiment|describe|tell us|share (a few|why|your)|what (interests|excites|motivat|draws)|why this|why (do you )?(want|interested)|what is your experience with|elaborate|in your own words|cover letter/;
      if (isEssayPrompt.test(lc) && !/linkedin|github|\bwebsite\b|portfolio|^how did you hear|used .*(before|previously)|experience (is )?with it|have you used|clearance|post-government|restrictions on post|non[\s-]?compete|bound by any|government employee|civilian or military/.test(lc)) {
        textVal = positioning; ans = positioning;
      }
      else if (/linkedin/.test(lc)) { textVal = profile.linkedin; ans = profile.linkedin; }
      else if (/github/.test(lc)) { textVal = profile.github; ans = profile.github; }
      else if (/\bwebsite\b|portfolio|personal site/.test(lc)) { if (!f.required) continue; textVal = profile.website; ans = profile.website; }
      else if (/preferred first name/.test(lc)) { textVal = profile.preferredName; ans = textVal; }
      else if (/preferred last name/.test(lc)) { textVal = profile.lastName; ans = textVal; }
      else if (/preferred name|name you.*go by|what.*you.*go by|name you.*prefer/.test(lc) && !/pronunciation|pronounce/.test(lc)) { textVal = profile.preferredName; ans = textVal; }

      // Work authorization. The inverted "unrestricted / without sponsorship"
      // phrasing must be checked FIRST.
      else if (/unrestricted|permanent work auth|without (requiring )?sponsor|without.*sponsorship|not require sponsor|do you have.*permanent/.test(lc)) {
        const yes = !sponsor && profile.workAuthorized;
        candidate = yes ? /^Yes\b/i : /^No\b/i; typeFilter = yes ? 'Yes' : 'No'; ans = yes ? 'Yes' : 'No';
      }
      else if (/authorized to work|work authorization|legally authorized/.test(lc)) {
        if (!profile.workAuthorized) { candidate = /^No\b/i; typeFilter = 'No'; ans = 'No'; }
        else if (sponsor) {
          // Prefer the option that says "authorized but requires sponsorship"
          // when the tenant offers one; a plain Yes is the fallback.
          candidate = /require.{0,25}sponsor|need.{0,25}sponsor|but.{0,25}(require|need|sponsor)|authoriz.{0,40}(sponsor|visa)|\bvisa\b|f-?1|\bopt\b|h-?1b|\bead\b|work permit|not.{0,15}any employer|with sponsor/i;
          typeFilter = 'sponsor'; ans = 'authorized, requires sponsorship';
        } else { candidate = /^Yes\b/i; typeFilter = 'Yes'; ans = 'Yes'; }
      }
      else if (/security clearance|clearance level|do you (have|hold|possess|currently hold).*clearance|active clearance|government clearance|post-government employment|restrictions on post/.test(lc)) {
        candidate = /^No\b|^None\b|do not|no clearance|not applicable|^n\/a/i; typeFilter = 'No'; textVal = 'No'; ans = 'No';
      }
      // Export control (10 CFR 810 A/B/C scheme): answer from citizenship/PR
      // status. Picking the wrong tier asserts a false immigration status.
      else if (/export control/.test(lc)) {
        candidate = usPerson ? /^A\b/i : /^C\b|not a u\.?s\.? person/i;
        typeFilter = usPerson ? 'A' : 'C'; ans = usPerson ? 'A' : 'C';
      }
      else if (/country of residence|current country|country (do you|you) (reside|live|are)|residence country|what country.*(reside|live|based|located|residence)|country.*current location/.test(lc)) {
        candidate = countryRe; typeFilter = profile.country; textVal = profile.country; ans = profile.country;
      }
      else if (/require.*sponsor|need.*sponsor|sponsorship|immigration (support|status)/.test(lc)) {
        candidate = sponsor ? /h-?1b|f-?1\b|\bopt\b|optional practical training|^yes$|yes,? i (will|would|do|am|currently)|will require sponsor/i : /^No\b/i;
        typeFilter = sponsor ? 'Yes' : 'No'; ans = sponsor ? 'Yes' : 'No';
      }
      else if (/how did you hear|how.*hear about|how did you (first )?learn about|first learn about|learn about .* as an employer|where did you (hear|learn)/.test(lc)) {
        candidate = new RegExp(escapeRe(profile.howHeard), 'i'); typeFilter = profile.howHeard; textVal = profile.howHeard; ans = profile.howHeard;
      }
      else if (/gdpr|consent|disclosure|acknowledge|i agree|privacy|i have read|i confirm/.test(lc) && !/restrictive (agreement|covenant)|non[\s-]?compete|non[\s-]?solicit|bound by any|subject to any.*agreement/.test(lc)) {
        candidate = /yes|agree|acknowledge|consent|i have read|confirm|accept/i; ans = 'Acknowledged';
      }
      else if (/visa status|current visa/.test(lc)) { textVal = profile.sponsorshipExplain; ans = textVal; candidate = /visa/i; }
      else if (/\brefer|do you know (anyone|someone)|know.*current.*employee/.test(lc)) { candidate = /^No\b/i; typeFilter = 'No'; textVal = 'No'; ans = 'No'; }
      else if (/have you (ever )?(interviewed|applied|worked|been employed|been an intern)|previously (interviewed|applied|worked)|interviewed.*(past|last|previous).*(month|year|six)|applied.*(before|previously|in the past)/.test(lc)) {
        candidate = /^No\b/i; typeFilter = 'No'; textVal = 'No'; ans = 'No';
      }
      else if (/have you (used|tried|worked with).*(before|previously)|used .* before/.test(lc)) {
        candidate = /haven'?t used|excited to learn|^No\b|never used|not yet/i; textVal = 'No'; ans = 'No';
      }
      else if (/have you (ever )?(worked|been employed|been an employee|interned).*(for|at|by)\b|previously (worked|been employed|interned)|(former|current|previous).*(employee|intern|contractor) (of|at|for)|are you a (former|current|previous).*(employee|intern|contractor)/.test(lc)) {
        candidate = /^No\b/i; textVal = 'No'; ans = 'No';
      }
      else if (/restrictive (agreement|covenant)|non[\s-]?compete|non[\s-]?solicit|bound by any|subject to any.*agreement/.test(lc)) {
        const no = profile.noNoncompete;
        candidate = no ? /^No\b/i : /^Yes\b/i; typeFilter = no ? 'No' : 'Yes'; textVal = no ? 'No' : 'Yes'; ans = textVal;
      }
      else if (/(current|recent|present|most recent)[\w\s]{0,20}employer|employer name|name of.*employer|who is your.*employer/.test(lc)) { textVal = profile.currentEmployer; ans = textVal; }
      else if (/(current|recent|present|more recent|most recent)[\w\s]{0,20}(job )?title|present (job )?title|your (job )?title|current role\b/.test(lc)) { textVal = profile.currentTitle; ans = textVal; }
      else if (/at least.*years|do you have.*years/.test(lc)) { candidate = /^Yes/i; typeFilter = 'Yes'; ans = 'Yes'; }
      else if (/how many years|years of.*experience|years of related/.test(lc)) { textVal = profile.yoe; ans = profile.yoe; candidate = profile.yoe ? new RegExp('\\b' + escapeRe(profile.yoe) + '\\b') : null; }
      else if (/familiar|how.*familiar|comfort/.test(lc)) { candidate = /somewhat|familiar|moderate|intermediate|some|^yes|comfortable/i; textVal = 'Familiar'; ans = 'Familiar'; }
      // Spoken languages — scoped to "speak" phrasing so it never hijacks
      // "which programming languages" questions.
      else if (/language.{0,20}(do you |you )?speak|which (spoken )?language|spoken language|what language.{0,15}speak/.test(lc) && !/programming|coding|code\b|technical/.test(lc)) {
        candidate = /^english/i; typeFilter = 'English'; textVal = 'English'; ans = 'English';
      }
      else if (/city and state|what city and state|city, state/.test(lc)) { textVal = profile.location; ans = textVal; }
      else if (/address line 2|apt|suite|unit number/.test(lc)) { if (!f.required) continue; textVal = 'N/A'; ans = 'N/A'; }
      else if (/address line 1|street address|^address\b|mailing address|home address/.test(lc)) { textVal = profile.addressLine1; ans = textVal; }
      else if (/^city\b|^city\*|town\/city|city name|^town\b/.test(lc)) { textVal = profile.city; ans = textVal; }
      else if (/postal\/?zip|zip code|postal code|^zip\b|post code/.test(lc)) { textVal = profile.zip; ans = textVal; }
      else if (/^country\*?\s*$|^country\b/.test(lc)) { candidate = countryRe; typeFilter = profile.country; textVal = profile.country; ans = profile.country; }
      else if (/current company|most recent company|company.*work/.test(lc)) { textVal = profile.currentEmployer; ans = textVal; }
      else if (/salary|compensation expectation|expected (pay|comp)|desired.{0,25}(pay|comp)|base compensation/.test(lc)) {
        textVal = profile.desiredComp || 'Open to discussion based on the full role and total compensation.'; ans = textVal;
      }
      else if (/current location|what(?:'|’|\s+i)?s your location|what is your (current )?location|where are you (currently )?(located|based)|your (current )?(city|location)|city of residence|where do you (currently )?(live|reside)/.test(lc) && f.tag !== 'SELECT') {
        textVal = profile.locationFull; ans = textVal;
      }
      else if (/which (u\.?s\.?\s*)?state|state or (canadian )?province|state\/province|province do you (reside|live)|what state.{0,30}(reside|live)|state do you (reside|live)|state of residence|which state/.test(lc)) {
        candidate = profile.state ? new RegExp('^' + escapeRe(profile.state) + '$', 'i') : null;
        typeFilter = profile.state; textVal = profile.state; ans = profile.state;
      }
      // "Are you located in <other country>?" location screen — answer No when
      // the named region isn't the applicant's. A generic located-in => Yes once
      // submitted a false "located in India: Yes".
      else if (/\b(are you (currently )?(located|based) in|located in|do you (live|reside) in)\b/.test(lc)
               && /\b(india|canada|united kingdom|\buk\b|australia|germany|france|poland|brazil|mexico|singapore|japan|china|ireland|netherlands|spain|italy|israel|ukraine|philippines|pakistan|nigeria|kenya|egypt|romania|portugal|argentina|colombia|europe|\bemea\b|\bapac\b|\bapj\b|\blatam\b)\b/.test(lc)
               && !new RegExp(escapeRe(profile.country), 'i').test(lc)) {
        candidate = /^No\b/i; typeFilter = 'No'; textVal = 'No'; ans = 'No';
      }
      else if (/based in|located in|are you based|do you (live|reside)|located near|within commuting/.test(lc)) {
        const yes = profile.willingToRelocate;
        candidate = yes ? /^Yes|within commuting|^N\/?A/i : /^No\b/i; typeFilter = yes ? 'Yes' : 'No'; textVal = yes ? 'Yes' : 'No'; ans = textVal;
      }
      else if (/proud of|describe a.*project|tell us about|why.*interested|why.*work|why.*join|excites you|excite.*about|interests you|what (interests|excites|motivat)|describe your experience|what is your experience|cover|motivat|relevant experience/.test(lc)) {
        textVal = positioning; ans = positioning;
      }
      else if (f.tag === 'TEXTAREA' && f.required) { textVal = positioning; ans = positioning; }
      else if (f.required) { textVal = positioning; ans = positioning; candidate = /^Yes/i; typeFilter = 'Yes'; }
      else continue;

      const selectField = await isSelect(page, f.id);
      if (selectField) {
        let picked = false;
        if (candidate) { const r = await robustPickSelect(page, f.id, candidate, typeFilter ? { type: typeFilter } : {}); if (r) { picked = true; ans = r; } }
        // If we WANTED "No" but the pick failed, retry "No" explicitly — never
        // fall through to a "Yes" that asserts a false claim.
        if (!picked && typeFilter === 'No') {
          const rno = await robustPickSelect(page, f.id, /^No\b|^None\b|I do not|no,? |not applicable|^n\/a/i, { type: 'No' });
          if (rno) { picked = true; ans = rno; }
        }
        if (!picked && typeFilter !== 'No') {
          const r2 = await robustPickSelect(page, f.id, /^yes\b/i, { type: 'Yes' });
          if (r2) ans = r2;
          else {
            // Generic fallback: any sensible option that does NOT assert a
            // dangerous claim (unrestricted auth, prior employment, etc.).
            const r3 = await robustPickSelect(page, f.id, /^(?!.*(prefer not|decline|don't wish|^no\b|^0\b|none|n\/a|any employer|citizen|permanent resident|green card|do not require|without sponsor|interviewed|worked (here|at|for) )).+/i);
            if (r3) ans = r3;
          }
        }
        if (ans) qa.push({ question: f.label, answer: ans });
        else result.warnings.push('select_pick_failed: ' + f.label.slice(0, 70));
      } else {
        let v = textVal || (candidate ? 'Yes' : '');
        if (v) {
          await ghFill(page, f.id, v);
          const committed = await page.evaluate((id) => { const e = document.getElementById(id); return e ? e.value : ''; }, f.id);
          if (!committed && /salary|compensation|expected (pay|comp)|desired (pay|comp)/.test(lc)) {
            // Numeric-only field rejected the prose — fall back to digits.
            const digits = (profile.desiredComp || '').replace(/\D/g, '');
            if (digits) { await ghFill(page, f.id, digits); v = digits; ans = digits; }
            else result.warnings.push('salary_numeric_needed: ' + f.label.slice(0, 70));
          }
          qa.push({ question: f.label, answer: ans || v });
        }
      }
    }

    // ── Education (school--N / degree--N / discipline--N react-selects) ────
    const eduIdx = await page.evaluate(() => {
      const idxs = new Set();
      document.querySelectorAll('[id^="school--"],[id^="degree--"],[id^="discipline--"],[id^="start-year--"],[id^="end-year--"]').forEach((el) => {
        const m = el.id.match(/--(\d+)$/); if (m) idxs.add(m[1]);
      });
      return [...idxs];
    });
    for (const i of eduIdx) {
      // School: STRICT ordered matcher from the profile's school name. Type
      // queries that actually return hits (full name, then leading tokens).
      // No blind fallback: a visible failure beats a fabricated credential.
      if (profile.school && await page.locator(`input[id="school--${i}"]`).count()) {
        const schoolRe = phraseRegex(profile.school);
        const tokens = profile.school.split(/[\s,.-]+/).filter(Boolean);
        const queries = [profile.school, tokens.slice(0, 3).join(' '), tokens.slice(-2).join(' ')].filter(Boolean);
        let r = null;
        for (const q of queries) {
          r = await robustPickSelect(page, `school--${i}`, schoolRe, { type: q, timeout: 10000 });
          if (r) break;
        }
        if (r) qa.push({ question: 'School', answer: r });
        else result.warnings.push('edu_school_failed');
      }
      // Degree: fixed-option select.
      if (profile.degree && await page.locator(`input[id="degree--${i}"]`).count()) {
        const degRe = phraseRegex(profile.degree.replace(/'s/i, "'?s"));
        let r = await robustPickSelect(page, `degree--${i}`, degRe || /degree/i, { type: profile.degree.split(/[\s']/)[0], timeout: 10000 });
        if (!r) r = await robustPickSelect(page, `degree--${i}`, new RegExp(escapeRe(profile.degree.split(/[\s']/)[0]), 'i'), { timeout: 8000 });
        if (r) qa.push({ question: 'Degree', answer: r });
        else result.warnings.push('edu_degree_failed');
      }
      // Discipline: async typeahead.
      if (profile.discipline && await page.locator(`input[id="discipline--${i}"]`).count()) {
        const discRe = phraseRegex(profile.discipline);
        let r = await robustPickSelect(page, `discipline--${i}`, discRe, { type: profile.discipline, timeout: 12000 });
        if (!r) r = await robustPickSelect(page, `discipline--${i}`, new RegExp(escapeRe(profile.discipline.split(/\s/)[0]), 'i'), { type: profile.discipline.split(/\s/)[0], timeout: 10000 });
        if (r) qa.push({ question: 'Discipline', answer: r });
        else result.warnings.push('edu_discipline_failed');
      }
      for (const [yid, val] of [[`start-year--${i}`, profile.eduStartYear], [`end-year--${i}`, profile.eduEndYear]]) {
        if (val && await page.locator(`input[id="${yid}"]`).count()) {
          await ghFill(page, yid, val);
          qa.push({ question: yid, answer: val });
        }
      }
      for (const [mid, mval] of [[`start-month--${i}`, /august|september|^aug|^sep/i], [`end-month--${i}`, /may|june|^may|^jun/i]]) {
        if (await page.locator(`input[id="${mid}"]`).count() && await isSelect(page, mid)) {
          const r = await robustPickSelect(page, mid, mval, { timeout: 8000 });
          if (r) qa.push({ question: mid, answer: r });
        }
      }
    }

    // Consent checkboxes
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const info = await cb.evaluate((el) => {
        const lab = document.querySelector('label[for="' + el.id + '"]');
        const labtxt = ((lab ? lab.innerText : '') || (el.closest('label') ? el.closest('label').innerText : '')).trim();
        return { checked: el.checked, label: labtxt };
      });
      if (!info.checked && /accept|agree|terms|consent|acknowledge|i confirm|privacy|i have read/i.test(info.label)) {
        await cb.click({ force: true }).catch(() => {});
        await sleep(150);
        qa.push({ question: (info.label || 'Consent checkbox').slice(0, 80), answer: 'Checked' });
      }
    }

    // Cover letter (only when required)
    const clReq = await page.evaluate(() => {
      const i = document.getElementById('cover_letter');
      if (!i) return false;
      const g = i.closest('[aria-required="true"]');
      const lbl = (document.querySelector('#upload-label-cover_letter') || {}).innerText || '';
      return !!g || /\*/.test(lbl);
    });
    if (clReq && await page.locator('#cover_letter').count()) {
      const clPath = path.join(SHOT_DIR, `cover_letter_${Date.now()}.txt`);
      fs.writeFileSync(clPath,
        `Dear Hiring Team,\n\n${positioning}\n\nI would welcome the chance to bring this background to your team.\n\nBest regards,\n${profile.name}\n${profile.email}`);
      await page.setInputFiles('#cover_letter', clPath);
      await sleep(3000);
      qa.push({ question: 'Cover Letter', answer: 'uploaded' });
    }

    // EEO → always the decline/prefer-not option (never a demographic claim)
    for (const [fid, re] of [
      ['gender', /decline|don't wish|prefer not/i],
      ['hispanic_ethnicity', /decline|don't wish|prefer not|^No/i],
      ['veteran_status', /don't wish|not a (protected )?veteran|decline|prefer not/i],
      ['disability_status', /do not want|don't wish|decline|prefer not|not to answer/i],
    ]) { if (await page.locator(idSel(fid)).count() && await isSelect(page, fid)) await robustPickSelect(page, fid, re, { timeout: 8000 }); }
    for (const re of [/identify your race|what is your race|race\/?ethnicity|^race$/i, /gender identity/i, /sexual orientation/i]) {
      const id = await idByLabel(page, re);
      if (id) await robustPickSelect(page, id, /decline|don't wish|prefer not|not to answer|do not wish/i, { timeout: 8000 });
    }
    const numericEeo = await page.evaluate(() => Array.from(document.querySelectorAll('input[id]')).filter((e) => /^\d+$/.test(e.id)).map((e) => e.id));
    for (const fid of numericEeo) { if (await isSelect(page, fid)) await robustPickSelect(page, fid, /don't wish|prefer not|decline|not listed|not to answer/i, { timeout: 6000 }); }

    // Verify required empties before submit
    await sleep(500);
    const stillEmpty = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('input[id^="question_"], textarea[id^="question_"]').forEach((el) => {
        if (el.id.includes('[]')) return;
        const lab = ((document.querySelector('label[for="' + el.id + '"]') || {}).innerText || '').trim();
        if (/\*\s*$/.test(lab) && !el.value && !(el.closest('[class*="select__control"]') && el.closest('[class*="select__control"]').querySelector('[class*="single-value"]'))) out.push(lab);
      });
      return out;
    });
    if (stillEmpty.length) result.warnings.push('still_empty_required: ' + JSON.stringify(stillEmpty).slice(0, 200));

    if (result.warnings.length) console.log('FIELD WARNINGS:', JSON.stringify(result.warnings));

    if (opts.dryRun) {
      const shotPath = path.join(SHOT_DIR, `dryrun_gh_${(role.company || 'x').replace(/\W/g, '')}.png`);
      try { await page.screenshot({ path: shotPath, fullPage: true }); } catch { /* best-effort */ }
      result.shot = shotPath;
      result.status = 'dry_run';
      result.note = 'dry_run_no_submit';
      console.log('DRY_RUN — form filled, NOT submitting. QA:', JSON.stringify(qa).slice(0, 2000));
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

    // Anti-double-submit guard. Window flags (not closures) so the legitimate
    // post-security-code resubmit can reset them.
    await page.evaluate(() => {
      window.__ghClicked = false; window.__ghSubmitted = false;
      document.querySelectorAll('button[type="submit"], button:not([type])').forEach((b) => {
        b.addEventListener('click', (e) => { if (window.__ghClicked) { e.preventDefault(); e.stopImmediatePropagation(); return false; } window.__ghClicked = true; }, true);
      });
      document.querySelectorAll('form').forEach((f) => {
        f.addEventListener('submit', (e) => { if (window.__ghSubmitted) { e.preventDefault(); e.stopImmediatePropagation(); return false; } window.__ghSubmitted = true; }, true);
      });
    });

    // Robust submit click: long forms re-render as fields commit, which can
    // detach the button mid-click. Re-locate + retry, then raw DOM click.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(400);
    for (let attempt = 0; attempt < 4 && !result.submitClicked; attempt++) {
      const submit = page.locator('button[type="submit"]').first();
      try { await submit.scrollIntoViewIfNeeded({ timeout: 5000 }); } catch { /* retried */ }
      await sleep(400);
      try {
        await submit.click({ force: true, timeout: 8000 });
        result.submitClicked = true;
      } catch {
        const jsOk = await page.evaluate(() => {
          const b = document.querySelector('button[type="submit"]');
          if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
          return false;
        }).catch(() => false);
        if (jsOk) result.submitClicked = true;
        else await sleep(600);
      }
    }

    // Success / security-code poll
    let success = false, secCode = false;
    for (let i = 0; i < 18; i++) {
      await sleep(1000);
      let url = ''; try { url = page.url(); } catch { /* mid-navigation */ }
      if (/\/confirmation/i.test(url)) { success = true; break; }
      let final = '';
      try { final = await page.evaluate(() => document.body.innerText); }
      catch { if (/\/confirmation/i.test(page.url())) { success = true; break; } continue; }
      if (/thank you for applying|application (received|submitted|complete)|we (have )?received your application|thanks for applying|successfully submitted|we'?ll be in touch/i.test(final)) { success = true; break; }
      const sc = await page.evaluate(() => {
        const inp = document.querySelectorAll('input[maxlength="1"]');
        return inp.length >= 6 && /security code|verify|verification code|enter.*code/i.test(document.body.innerText);
      }).catch(() => false);
      if (sc) { secCode = true; break; }
    }

    if (secCode) {
      // Email-verification gate: Greenhouse emailed a code to the applicant.
      // Poll the drop file — the user (or an outer tool) writes the code there.
      const CODE_FILE = opts.codeFile || process.env.GH_CODE_FILE || '/tmp/gh_seccode.txt';
      try { fs.unlinkSync(CODE_FILE); } catch { /* absent is fine */ }
      console.log(`SECURITY_CODE_REQUIRED — check ${profile.email} for the code and write it to ${CODE_FILE} (polling up to 360s)`);
      let code = null;
      for (let w = 0; w < 180; w++) {
        await sleep(2000);
        // Codes are ~8-char alphanumeric, case-sensitive.
        try { const c = fs.readFileSync(CODE_FILE, 'utf8').trim(); if (/^[A-Za-z0-9]{4,12}$/.test(c)) { code = c; break; } } catch { /* not written yet */ }
      }
      if (!code) {
        // The form POST already happened — record failed WITH submission
        // evidence so the row keeps blocking re-applies.
        result.status = 'failed';
        result.note = 'security_code_timeout';
        return result;
      }
      const boxes = await page.locator('input[id^="security-input"], input[maxlength="1"]').all();
      if (boxes.length >= 4) {
        // OTP-style auto-advancing boxes: focus the FIRST box and type the
        // whole code — per-box click+type races the auto-advance.
        await boxes[0].click();
        await page.keyboard.type(code, { delay: 130 });
        await sleep(500);
      } else {
        const fld = page.locator('input[name*="security" i], input[id*="security" i], input[placeholder*="code" i], input[aria-label*="code" i], input[type="text"]').first();
        try { await fld.click(); await fld.fill(code); } catch (e) { console.log('seccode fill err', e.message); }
      }
      await sleep(900);
      await page.evaluate(() => { window.__ghClicked = false; window.__ghSubmitted = false; }).catch(() => {});
      try {
        const vb = page.locator('button:has-text("Submit application"), button:has-text("Verify"), button:has-text("Confirm"), button[type="submit"]').first();
        if (await vb.count()) await vb.click({ force: true });
      } catch { /* success poll below decides */ }
      try { fs.unlinkSync(CODE_FILE); } catch { /* already consumed */ }
      for (let i = 0; i < 18; i++) {
        await sleep(1000);
        let url = ''; try { url = page.url(); } catch { /* mid-navigation */ }
        if (/\/confirmation/i.test(url)) { success = true; break; }
        let final2 = ''; try { final2 = await page.evaluate(() => document.body.innerText); } catch { continue; }
        if (/thank you for applying|application (received|submitted|complete)|we (have )?received your application|thanks for applying|successfully submitted/i.test(final2)) { success = true; break; }
      }
    }

    const shotPath = path.join(SHOT_DIR, `gh_${(role.company || 'x').replace(/\W/g, '')}.png`);
    try { await page.screenshot({ path: shotPath, fullPage: true }); } catch { /* best-effort */ }
    result.shot = shotPath;

    if (success) {
      result.status = 'done';
    } else {
      const errs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[class*="error"],[role="alert"],[aria-invalid="true"]'))
          .map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 300)
      ).catch(() => []);
      let url = ''; try { url = page.url(); } catch { /* page may be gone */ }
      result.status = 'failed';
      result.note = ('submit_no_success url=' + url + ' errors=' + JSON.stringify(errs)).slice(0, 400);
    }
  } catch (e) {
    console.log('FATAL', e.message);
    result.status = 'failed';
    result.note = 'fatal:' + e.message.slice(0, 150);
  }
  return result;
}

module.exports = { applyGreenhouseRole, robustPickSelect, SHOT_DIR };
