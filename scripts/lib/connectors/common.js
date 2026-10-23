'use strict';

const fs = require('fs');
const path = require('path');

const TRACKING_PARAMS = /^(utm_.*|src|gh_src|ref|refId|trackingId|trk|lever-source|lever-origin|source|campaign)$/i;

function unwrapRedirect(raw) {
  let url = String(raw || '').trim();
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(url); } catch { return url; }
    const isLinkedInRedirect = /(^|\.)linkedin\.com$/i.test(u.hostname) && /\/(safety\/go|redir\/redirect|externalApply)/i.test(u.pathname);
    const target = u.searchParams.get('url') || u.searchParams.get('u');
    if (isLinkedInRedirect && target) { url = target; continue; }
    if (/(^|\.)jobright\.ai$/i.test(u.hostname) && target && /^https?:/i.test(target)) { url = target; continue; }
    break;
  }
  return url;
}

function normalizeAtsUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try { u = new URL(unwrapRedirect(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'jobs.ashbyhq.com') {
    if (parts.length < 2) return null;
    return { ats: 'ashby', url: `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}` };
  }

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
    const idx = parts.indexOf('jobs');
    if (parts.length >= 3 && idx === 1 && /^\d+$/.test(parts[2])) {
      return { ats: 'greenhouse', url: `https://${host}/${parts[0]}/jobs/${parts[2]}` };
    }
    const embedToken = u.searchParams.get('for');
    const embedJob = u.searchParams.get('token');
    if (parts[0] === 'embed' && embedToken && /^\d+$/.test(embedJob || '')) {
      return { ats: 'greenhouse', url: `https://boards.greenhouse.io/${embedToken}/jobs/${embedJob}` };
    }
    return null;
  }

  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (parts.length < 2) return null;
    return { ats: 'lever', url: `https://${host}/${parts[0]}/${parts[1]}` };
  }

  return null;
}

function urlKey(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    return (u.hostname + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return String(url || '').toLowerCase();
  }
}

function loadFilters(configPath) {
  const file = configPath || path.join(__dirname, '..', '..', '..', 'config', 'boards.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const relevant = new RegExp(cfg.filters.relevant, 'i');
  const disqualify = new RegExp(cfg.filters.disqualify, 'i');
  return {
    keep: (title) => !!title && !disqualify.test(title) && relevant.test(title),
  };
}

function buildRole({ company, title, url, source, location }) {
  const norm = normalizeAtsUrl(url);
  if (!norm || !company || !title) return null;
  const role = {
    company: String(company).trim(),
    role_title: String(title).trim(),
    url: norm.url,
    ats: norm.ats,
    source,
  };
  if (location) role.location = String(location).trim();
  return role;
}

function dedupeRoles(roles) {
  const seen = new Map();
  for (const r of roles) {
    const key = urlKey(r.url);
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

function readRolesFile(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeRolesFile(file, roles, { merge = true } = {}) {
  const existing = merge ? readRolesFile(file) : [];
  const merged = dedupeRoles([...existing, ...roles]);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return { total: merged.length, added: merged.length - dedupeRoles(existing).length };
}

const TITLE_KEYS = ['jobTitle', 'job_title', 'role_title', 'title', 'positionTitle', 'name'];
const COMPANY_KEYS = ['companyName', 'company_name', 'company', 'employerName', 'organizationName'];
const LOCATION_KEYS = ['jobLocation', 'location', 'locationName'];

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const nk of ['name', 'companyName', 'displayName']) {
        if (typeof v[nk] === 'string' && v[nk].trim()) return v[nk].trim();
      }
    }
  }
  return null;
}

function childCompany(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const c = firstString(v, ['companyName', 'company_name', 'organizationName']);
      if (c) return c;
    }
  }
  return null;
}

function extractFromJson(json, source) {
  const out = [];
  const walk = (node, inherited, depth) => {
    if (depth > 12 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inherited, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const here = {
      title: firstString(node, TITLE_KEYS) || inherited.title,
      company: firstString(node, COMPANY_KEYS) || childCompany(node) || inherited.company,
      location: firstString(node, LOCATION_KEYS) || inherited.location,
    };
    for (const v of Object.values(node)) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v) && normalizeAtsUrl(v)) {
        const role = buildRole({ company: here.company, title: here.title, url: v, source, location: here.location });
        if (role) out.push(role);
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v, here, depth + 1);
    }
  };
  walk(json, { title: null, company: null, location: null }, 0);
  return dedupeRoles(out);
}

function titleFromDocumentTitle(docTitle) {
  const cleaned = String(docTitle || '').replace(/\s*\|\s*(LinkedIn|Jobright(\.ai)?)\s*$/i, '');
  const parts = cleaned.split(/\s+\|\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0], company: parts[1] };
  return { title: parts[0] || null, company: null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(min, max) {
  return sleep(min + Math.random() * (max - min));
}

async function atsLinksOnPage(page) {
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
  for (const h of hrefs) {
    const n = normalizeAtsUrl(h);
    if (n) return n.url;
  }
  return null;
}

async function clickApplyForExternalUrl(page, labelPattern) {
  const ctx = page.context();
  const candidates = page.locator('a, button').filter({ hasText: labelPattern });
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 4); i++) {
    const el = candidates.nth(i);
    const text = ((await el.innerText().catch(() => '')) || '').trim();
    if (/easy apply/i.test(text)) continue;
    const href = await el.getAttribute('href').catch(() => null);
    if (href) {
      const n = normalizeAtsUrl(new URL(href, page.url()).href);
      if (n) return n.url;
    }
    const popupPromise = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    await el.click({ timeout: 4000 }).catch(() => {});
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      const target = popup.url();
      await popup.close().catch(() => {});
      const n = normalizeAtsUrl(target);
      if (n) return n.url;
      return null;
    }
  }
  return null;
}

module.exports = {
  normalizeAtsUrl,
  unwrapRedirect,
  urlKey,
  loadFilters,
  buildRole,
  dedupeRoles,
  readRolesFile,
  writeRolesFile,
  extractFromJson,
  titleFromDocumentTitle,
  atsLinksOnPage,
  clickApplyForExternalUrl,
  sleep,
  jitter,
};
