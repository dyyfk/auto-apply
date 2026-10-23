'use strict';

const {
  buildRole, extractFromJson, titleFromDocumentTitle, atsLinksOnPage, clickApplyForExternalUrl,
  dedupeRoles, jitter,
} = require('./common');

const SOURCE = 'jobright';
const DEFAULT_URL = 'https://jobright.ai/jobs/recommend';

function assertNotBlocked(page) {
  if (/jobright\.ai\/(login|signin|sign-in|signup)/i.test(page.url())) {
    throw new Error('Jobright is asking you to sign in. Log in once in the Chrome window this script is attached to, then re-run.');
  }
}

function captureJson(ctx, sink) {
  const handler = async (response) => {
    try {
      const type = response.headers()['content-type'] || '';
      if (!/json/i.test(type)) return;
      if (!/jobright\.ai/i.test(response.url())) return;
      sink.push(await response.json());
    } catch { /* body unavailable */ }
  };
  ctx.on('response', handler);
  return () => ctx.off('response', handler);
}

async function scrollFeed(page, rounds) {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 2200).catch(() => {});
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollBy(0, 2200);
      }
    }).catch(() => {});
    await jitter(900, 1600);
  }
}

async function collectDetailLinks(page) {
  return page.$$eval('a[href*="/jobs/info/"]', (as) => [...new Set(as.map((a) => a.href.split('?')[0]))]).catch(() => []);
}

async function readDetail(ctx, page, url) {
  const sink = [];
  const stop = captureJson(ctx, sink);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assertNotBlocked(page);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await jitter(600, 1200);
  } finally {
    stop();
  }
  const fromJson = dedupeRoles(sink.flatMap((j) => extractFromJson(j, SOURCE)));
  if (fromJson.length) return fromJson[0];

  const docTitle = await page.title().catch(() => '');
  const h1 = await page.locator('h1').first().textContent({ timeout: 2000 }).catch(() => null);
  const fallback = titleFromDocumentTitle(docTitle);
  const company = await page.locator('[class*="company-name"], [class*="companyName"]').first().textContent({ timeout: 1500 }).catch(() => null)
    || fallback.company;
  let target = await atsLinksOnPage(page);
  if (!target) target = await clickApplyForExternalUrl(page, /apply( now)?|original (job )?post/i);
  return buildRole({ company: company && company.trim(), title: (h1 && h1.trim()) || fallback.title, url: target, source: SOURCE });
}

async function scrape(ctx, opts, log) {
  const page = await ctx.newPage();
  const stats = { seen: 0, fromFeed: 0, fromDetail: 0, noExternal: 0, filtered: 0 };
  const found = [];
  try {
    const sink = [];
    const stop = captureJson(ctx, sink);
    await page.goto(opts.url || DEFAULT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assertNotBlocked(page);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await scrollFeed(page, opts.pages * 4);
    stop();

    const feed = dedupeRoles(sink.flatMap((j) => extractFromJson(j, SOURCE)));
    stats.fromFeed = feed.length;
    found.push(...feed);
    log(`jobright: feed responses yielded ${feed.length} supported-ATS role(s)`);

    if (found.length < opts.max) {
      const links = (await collectDetailLinks(page)).slice(0, opts.max);
      for (const link of links) {
        if (found.length >= opts.max) break;
        stats.seen++;
        try {
          const role = await readDetail(ctx, page, link);
          if (role) { found.push(role); stats.fromDetail++; } else stats.noExternal++;
        } catch (e) {
          if (/sign in/.test(e.message)) throw e;
          log(`jobright: ${link}: ${e.message.split('\n')[0]}`);
        }
        await jitter(1200, 2800);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  const roles = [];
  for (const r of dedupeRoles(found).slice(0, opts.max)) {
    if (opts.filters && !opts.filters.keep(r.role_title)) { stats.filtered++; continue; }
    roles.push(r);
    log(`jobright: + ${r.company} — ${r.role_title} [${r.ats}]`);
  }
  return { roles, stats };
}

module.exports = { scrape, DEFAULT_URL, SOURCE };
