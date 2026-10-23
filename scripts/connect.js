#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { chromium } = require('playwright');
const {
  loadFilters, writeRolesFile, dedupeRoles,
} = require('./lib/connectors/common');

const CONNECTORS = {
  linkedin: () => require('./lib/connectors/linkedin'),
  jobright: () => require('./lib/connectors/jobright'),
};

const CDP_PORT = process.env.CDP_PORT || '9222';

function usage(msg) {
  if (msg) console.error('ERROR:', msg);
  console.error([
    'Usage: node scripts/connect.js <linkedin|jobright|all> [options]',
    '  --query "software engineer"   LinkedIn search keywords (repeatable)',
    '  --location "United States"    LinkedIn location',
    '  --recent-hours 24             LinkedIn: only jobs posted within N hours',
    '  --url <page>                  Jobright: feed/search page to read (default recommend feed)',
    '  --pages N                     result pages / scroll rounds (default 2)',
    '  --max N                       max jobs to inspect per connector (default 40)',
    '  --out roles.json              output file (default roles.json), merged with existing',
    '  --overwrite                   replace the output file instead of merging',
    '  --no-filter                   skip title filters from config/boards.json',
    '  --config path.json            alternate filter config',
    '  --push                        also POST results to the queue (/api/jobs/bulk)',
    '  --profile-id N                profile for --push',
    '  --dry-run                     print results, write nothing',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    target: null, queries: [], location: 'United States', recentHours: null, url: null,
    pages: 2, max: 40, out: 'roles.json', overwrite: false, filter: true, config: null,
    push: false, profileId: null, dryRun: false,
    apiBase: process.env.JOBS_API || `http://localhost:${process.env.PORT || 3001}`,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query') out.queries.push(argv[++i]);
    else if (a === '--location') out.location = argv[++i];
    else if (a === '--recent-hours') out.recentHours = Number(argv[++i]);
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--pages') out.pages = Number(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--overwrite') out.overwrite = true;
    else if (a === '--no-filter') out.filter = false;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--push') out.push = true;
    else if (a === '--profile-id') out.profileId = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--api-base') out.apiBase = argv[++i];
    else if (!a.startsWith('--') && !out.target) out.target = a;
    else usage('unknown argument ' + a);
  }
  if (!out.target) usage();
  if (out.target !== 'all' && !CONNECTORS[out.target]) usage('unknown connector ' + out.target);
  if (!out.queries.length) out.queries.push('software engineer');
  return out;
}

async function connectBrowser() {
  try {
    const browser = await chromium.connectOverCDP({ endpointURL: `http://127.0.0.1:${CDP_PORT}`, timeout: 30000 });
    console.error('CONNECT: attached to Chrome via CDP :' + CDP_PORT);
    return { browser, ctx: browser.contexts()[0], persistent: false };
  } catch (e) {
    console.error(`CONNECT: CDP :${CDP_PORT} failed (${e.message.split('\n')[0]}) — launching persistent browser`);
    const profileDir = process.env.BROWSER_PROFILE_DIR || path.join(__dirname, '..', '.apply-browser-profile');
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    });
    return { browser: ctx.browser(), ctx, persistent: true };
  }
}

async function pushToQueue(roles, args) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.APP_PASSWORD) headers.Authorization = `Bearer ${process.env.APP_PASSWORD}`;
  for (let i = 0; i < roles.length; i += 25) {
    const jobs = roles.slice(i, i + 25).map((r) => ({
      company: r.company,
      role_title: r.role_title,
      role_url: r.url,
      ats: r.ats,
      notes: `connector: ${r.source}`,
    }));
    const res = await fetch(`${args.apiBase}/api/jobs/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profile_id: args.profileId ?? undefined, jobs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`push failed ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    else console.error(`queue bulk: added=${data.added} resurrected=${data.resurrected} skipped=${data.skipped}`);
  }
}

(async () => {
  const args = parseArgs(process.argv);
  const filters = args.filter ? loadFilters(args.config) : null;
  const targets = args.target === 'all' ? Object.keys(CONNECTORS) : [args.target];
  const log = (m) => console.error(m);

  const { browser, ctx, persistent } = await connectBrowser();
  const all = [];
  let failed = false;
  try {
    for (const name of targets) {
      const connector = CONNECTORS[name]();
      try {
        const { roles, stats } = await connector.scrape(ctx, { ...args, filters }, log);
        console.error(`${name}: ${roles.length} role(s) on Ashby/Greenhouse/Lever — ${JSON.stringify(stats)}`);
        all.push(...roles);
      } catch (e) {
        failed = true;
        console.error(`${name}: ${e.message}`);
      }
    }
  } finally {
    if (persistent) await ctx.close().catch(() => {});
    else await browser.close().catch(() => {});
  }

  const roles = dedupeRoles(all);
  if (args.dryRun) {
    console.error(`[dry-run] ${roles.length} role(s), nothing written`);
    console.log(JSON.stringify(roles, null, 2));
  } else {
    if (roles.length || args.overwrite) {
      const r = writeRolesFile(args.out, roles, { merge: !args.overwrite });
      console.error(`wrote ${args.out}: ${r.total} total (${r.added} new)`);
    } else {
      console.error('nothing found; ' + args.out + ' left untouched');
    }
    if (args.push && roles.length) await pushToQueue(roles, args);
  }
  if (failed && !roles.length) process.exit(1);
})();
