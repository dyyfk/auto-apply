#!/usr/bin/env node
// One-shot setup for a fresh machine. Safe to re-run (idempotent).
//
//   npm run setup
//
// Does, in order:
//   1. Verify Node >= 22.5 (node:sqlite is built in from 22.5).
//   2. Install server dependencies (npm install).
//   3. Install client dependencies (client/ npm install).
//   4. Download the Playwright Chromium bundle (used when no real Chrome with
//      a CDP port is available).
//   5. Create .env from .env.example if missing.
// Then prints exactly what to run next.

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function step(label, fn) {
  process.stdout.write(`\n▸ ${label}\n`);
  fn();
}

function run(cmd, cwd = ROOT) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 1. Node version — node:sqlite (DatabaseSync) ships from Node 22.5.0.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `\nERROR: Node ${process.versions.node} is too old — this app needs Node >= 22.5 ` +
    '(it uses the built-in node:sqlite module).\n' +
    'Install a current Node from https://nodejs.org or via nvm:\n' +
    '  nvm install 22 && nvm use 22\n'
  );
  process.exit(1);
}
console.log(`Node ${process.versions.node} OK`);

step('Installing server dependencies', () => run('npm install'));
step('Installing client dependencies', () => run('npm install', path.join(ROOT, 'client')));

step('Downloading Playwright Chromium (fallback browser for the appliers)', () => {
  try {
    run('npx playwright install chromium');
  } catch {
    console.error(
      'WARNING: Playwright browser download failed (offline?). The appliers can still\n' +
    'drive a real Chrome via CDP (see README "Browser" section); re-run\n' +
      '`npx playwright install chromium` later to enable the bundled fallback.'
    );
  }
});

step('Creating .env', () => {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    console.log('.env already exists — leaving it untouched');
  } else {
    fs.copyFileSync(path.join(ROOT, '.env.example'), envPath);
    console.log('created .env from .env.example (defaults are fine for local use)');
  }
});

console.log(`
✅ Setup complete. Next:

  npm run dev        # API on :3001 + web UI on http://localhost:5173
                     # → open the UI and finish the onboarding wizard

  npm run doctor     # verify the environment any time

Then, to actually apply (after onboarding):

  node scripts/scout.js                   # fill the queue with open roles
  node scripts/apply.js --queue --dry-run # review what would be submitted
  node scripts/apply.js --queue --max 5   # live applies
`);
