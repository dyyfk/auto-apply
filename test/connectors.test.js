const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../scripts/lib/connectors/common');

test('normalizeAtsUrl canonicalizes supported ATS urls', () => {
  assert.deepEqual(
    c.normalizeAtsUrl('https://boards.greenhouse.io/acme/jobs/12345?gh_src=abc&utm_source=linkedin'),
    { ats: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/12345' },
  );
  assert.deepEqual(
    c.normalizeAtsUrl('https://job-boards.greenhouse.io/acme/jobs/99'),
    { ats: 'greenhouse', url: 'https://job-boards.greenhouse.io/acme/jobs/99' },
  );
  assert.deepEqual(
    c.normalizeAtsUrl('https://jobs.ashbyhq.com/acme/0b1c2d3e-aaaa-bbbb-cccc-123456789012/application?utm_source=x'),
    { ats: 'ashby', url: 'https://jobs.ashbyhq.com/acme/0b1c2d3e-aaaa-bbbb-cccc-123456789012' },
  );
  assert.deepEqual(
    c.normalizeAtsUrl('https://jobs.lever.co/acme/abcd-1234/apply?lever-source=LinkedIn'),
    { ats: 'lever', url: 'https://jobs.lever.co/acme/abcd-1234' },
  );
});

test('normalizeAtsUrl rejects unsupported or malformed urls', () => {
  assert.equal(c.normalizeAtsUrl('https://www.workday.com/acme/job/1'), null);
  assert.equal(c.normalizeAtsUrl('https://boards.greenhouse.io/acme'), null);
  assert.equal(c.normalizeAtsUrl('https://jobs.lever.co/acme'), null);
  assert.equal(c.normalizeAtsUrl('not a url'), null);
  assert.equal(c.normalizeAtsUrl(null), null);
});

test('normalizeAtsUrl unwraps LinkedIn and Jobright redirects', () => {
  const target = encodeURIComponent('https://jobs.lever.co/acme/abcd-1234?lever-source=li');
  assert.equal(
    c.normalizeAtsUrl(`https://www.linkedin.com/safety/go/?url=${target}&trk=x`).url,
    'https://jobs.lever.co/acme/abcd-1234',
  );
  assert.equal(
    c.normalizeAtsUrl(`https://jobright.ai/redirect?url=${encodeURIComponent('https://jobs.ashbyhq.com/acme/uuid-1')}`).url,
    'https://jobs.ashbyhq.com/acme/uuid-1',
  );
});

test('extractFromJson finds ATS links with title and company from ancestors', () => {
  const json = {
    result: {
      jobList: [
        {
          jobResult: { jobTitle: 'Backend Engineer', applyLink: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x', jobLocation: 'Remote' },
          companyResult: { companyName: 'Acme' },
        },
        {
          jobResult: { jobTitle: 'Platform Engineer', applyLink: 'https://www.workday.com/x' },
          companyResult: { companyName: 'Nope' },
        },
        { title: 'SRE', company: { name: 'Globex' }, url: 'https://jobs.lever.co/globex/uuid-9/apply' },
      ],
    },
  };
  const roles = c.extractFromJson(json, 'jobright');
  assert.equal(roles.length, 2);
  assert.deepEqual(roles.map((r) => [r.company, r.role_title, r.ats]), [
    ['Acme', 'Backend Engineer', 'greenhouse'],
    ['Globex', 'SRE', 'lever'],
  ]);
  assert.equal(roles[0].location, 'Remote');
});

test('dedupeRoles and writeRolesFile merge by canonical url', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-'));
  const file = path.join(dir, 'roles.json');
  const a = c.buildRole({ company: 'Acme', title: 'Backend Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'linkedin' });
  const dup = c.buildRole({ company: 'Acme', title: 'Backend Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=z', source: 'jobright' });
  const b = c.buildRole({ company: 'Globex', title: 'SRE', url: 'https://jobs.lever.co/globex/u-1', source: 'jobright' });

  assert.equal(c.dedupeRoles([a, dup, b]).length, 2);
  assert.deepEqual(c.writeRolesFile(file, [a]), { total: 1, added: 1 });
  assert.deepEqual(c.writeRolesFile(file, [dup, b]), { total: 2, added: 1 });

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of written) {
    assert.ok(r.company && r.role_title && r.url, 'apply.js requires company, role_title, url');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadFilters applies the scout title filters', () => {
  const f = c.loadFilters();
  assert.equal(f.keep('Backend Engineer'), true);
  assert.equal(f.keep('Senior Backend Engineer'), false);
  assert.equal(f.keep('Marketing Manager'), false);
});

test('titleFromDocumentTitle splits job page titles', () => {
  assert.deepEqual(c.titleFromDocumentTitle('Backend Engineer | Acme | LinkedIn'), { title: 'Backend Engineer', company: 'Acme' });
});
