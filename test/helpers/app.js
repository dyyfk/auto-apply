// Boots the Express app against a throwaway SQLite file for tests.
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
delete process.env.APP_PASSWORD;

const express = require('express');

function buildApp() {
  const app = express();
  app.use(express.json());
  const auth = require('../../server/middleware/auth');
  app.use('/api/auth', require('../../server/routes/auth'));
  app.use('/api/profiles', auth, require('../../server/routes/profiles').router);
  app.use('/api/jobs', auth, require('../../server/routes/jobs'));
  app.use('/api/applications', auth, require('../../server/routes/applications'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

let server;
let baseUrl;

async function start() {
  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stop() {
  if (server) await new Promise((r) => server.close(r));
}

async function req(method, pathname, body, extra = {}) {
  const res = await fetch(baseUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...extra,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 204 */ }
  return { status: res.status, data };
}

function getBaseUrl() { return baseUrl; }

module.exports = { start, stop, req, getBaseUrl, tmpDir };
