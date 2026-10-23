'use strict';

const {
  buildRole, titleFromDocumentTitle, atsLinksOnPage, clickApplyForExternalUrl, jitter,
} = require('./common');

const SOURCE = 'linkedin';

function searchUrl({ query, location, start, recentHours }) {
  const u = new URL('https://www.linkedin.com/jobs/search/');
  u.searchParams.set('keywords', query);
  if (location) u.searchParams.set('location', location);
  if (recentHours) u.searchParams.set('f_TPR', `r${Math.round(recentHours * 3600)}`);
  u.searchParams.set('sortBy', 'DD');
  if (start) u.searchParams.set('start', String(start));
  return u.href;
}

function assertNotBlocked(page) {
  if (/linkedin\.com\/(login|authwall|checkpoint|uas\/login)/i.test(page.url())) {
    throw new Error('LinkedIn is asking you to sign in or verify. Log in once in the Chrome window this script is attached to, then re-run.');
  }
}

async function collectJobIds(page, pages) {
  const ids = new Set();
  for (let p = 0; p < pages; p++) {
    for (let s = 0; s < 6; s++) {
      await page.mouse.wheel(0, 1800).catch(() => {});
      await page.evaluate(() => {
        const list = document.querySelector('.jobs-search-results-list, .scaffold-layout__list, .jobs-search__results-list');
        if (list) list.scrollBy(0, 1800);
      }).catch(() => {});
      await jitter(500, 900);
    }
    const found = await page.$$eval('a[href], [data-occludable-job-id], [data-job-id], [data-entity-urn]', (els) => {
      const out = [];
      for (const el of els) {
        const href = el.getAttribute('href') || '';
        const m = href.match(/\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/) || href.match(/currentJobId=(\d{6,})/);
        if (m) out.push(m[1]);
        const d = el.getAttribute('data-occludable-job-id') || el.getAttribute('data-job-id');
        if (d && /^\d{6,}$/.test(d)) out.push(d);
        const urn = el.getAttribute('data-entity-urn') || '';
        const um = urn.match(/jobPosting:(\d+)/);
        if (um) out.push(um[1]);
      }
      return out;
    }).catch(() => []);
    for (const id of found) ids.add(id);
    const next = page.locator('button[aria-label^="Page"], li[data-test-pagination-page-btn] button').nth(p + 1);
    if (p < pages - 1) {
      const clicked = await next.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) break;
      await jitter(1500, 2500);
    }
  }
  return [...ids];
}

async function readJob(page, id) {
  await page.goto(`https://www.linkedin.com/jobs/view/${id}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  assertNotBlocked(page);
  await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
  await jitter(800, 1500);

  const info = await page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    return {
      title: text('h1'),
      company: text('.job-details-jobs-unified-top-card__company-name')
        || text('.topcard__org-name-link')
        || text('.job-details-jobs-unified-top-card__primary-description-container a')
        || text('[class*="company-name"]'),
      location: text('.job-details-jobs-unified-top-card__bullet') || text('.topcard__flavor--bullet'),
      docTitle: document.title,
    };
  });
  const fallback = titleFromDocumentTitle(info.docTitle);
  const title = info.title || fallback.title;
  const company = info.company || fallback.company;

  const easyApply = await page.locator('button, a').filter({ hasText: /^\s*easy apply\s*$/i }).count().catch(() => 0);
  const showMore = page.locator('button').filter({ hasText: /show more|see more/i }).first();
  await showMore.click({ timeout: 1500 }).catch(() => {});

  let url = await atsLinksOnPage(page);
  if (!url) url = await clickApplyForExternalUrl(page, /^\s*apply\s*$/i);

  return { id, title, company, location: info.location, url, easyApply: easyApply > 0 && !url };
}

async function scrape(ctx, opts, log) {
  const page = await ctx.newPage();
  const roles = [];
  const stats = { seen: 0, easyApply: 0, noExternal: 0, unsupported: 0, filtered: 0 };
  try {
    const ids = [];
    for (const query of opts.queries) {
      await page.goto(searchUrl({ query, location: opts.location, recentHours: opts.recentHours }), {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      assertNotBlocked(page);
      await jitter(1500, 2500);
      const found = await collectJobIds(page, opts.pages);
      log(`linkedin: "${query}" → ${found.length} job id(s)`);
      for (const id of found) if (!ids.includes(id)) ids.push(id);
    }

    for (const id of ids.slice(0, opts.max)) {
      stats.seen++;
      let job;
      try {
        job = await readJob(page, id);
      } catch (e) {
        if (/sign in or verify/.test(e.message)) throw e;
        log(`linkedin/${id}: ${e.message.split('\n')[0]}`);
        continue;
      }
      if (job.easyApply) { stats.easyApply++; continue; }
      if (!job.url) { stats.noExternal++; continue; }
      if (opts.filters && !opts.filters.keep(job.title)) { stats.filtered++; continue; }
      const role = buildRole({ company: job.company, title: job.title, url: job.url, source: SOURCE, location: job.location });
      if (!role) { stats.unsupported++; continue; }
      roles.push(role);
      log(`linkedin: + ${role.company} — ${role.role_title} [${role.ats}]`);
      await jitter(1500, 3500);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { roles, stats };
}

module.exports = { scrape, searchUrl, SOURCE };
