// Queue-drain auto-rescrape. A cron checks the claimable-pending count every
// 3 minutes; when a profile's queue drains, it runs scripts/scout.js to refill.
//
// Cooldown is adaptive: 15 min base, doubling to 24h while rescrapes add zero
// roles (sources exhausted), resetting as soon as anything lands. An all-scouts
// failure retries at base cadence — that's an outage, not exhaustion.

const { exec } = require('child_process');
const path = require('path');
const cron = require('node-cron');
const db = require('../db');

const SCOUT_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scout.js');
const CWD = path.join(__dirname, '..', '..');
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 8 * 60 * 1000;

let scoutRunning = false;
let lastScoutAt = 0;
let cooldownMs = COOLDOWN_MS;

function parseAddedCount(output) {
  // scout.js prints one parseable line per bulk POST: "bulk: added=X resurrected=Y skipped=Z"
  let total = 0;
  const re = /bulk: added=(\d+)(?:\s+resurrected=(\d+))?/g;
  let m;
  while ((m = re.exec(output))) {
    total += parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) : 0);
  }
  return total;
}

function tail(text, lines = 5, maxLineLen = 300) {
  return String(text).trim().split('\n').slice(-lines)
    .map((l) => (l.length > maxLineLen ? `${l.slice(0, maxLineLen)}…` : l))
    .join(' | ');
}

async function triggerScout(profileId, reason) {
  if (scoutRunning) return;
  const sinceLastMs = Date.now() - lastScoutAt;
  if (sinceLastMs < cooldownMs) return;

  scoutRunning = true;
  lastScoutAt = Date.now();
  console.log(`[scout] rescrape triggered (${reason}) profile=${profileId}`);

  try {
    const result = await new Promise((resolve) => {
      exec(
        `node ${SCOUT_SCRIPT} --profile-id ${profileId}`,
        { cwd: CWD, timeout: SCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
      );
    });

    const added = parseAddedCount(result.stdout) + parseAddedCount(result.stderr);
    if (result.err) {
      console.error(`[scout] scout failed (added=${added} before failure):`, tail(result.stderr || result.err.message));
      // Batches POSTed before a crash are real rows; only reset backoff if any landed.
      cooldownMs = added > 0 ? COOLDOWN_MS : cooldownMs;
    } else if (added > 0) {
      cooldownMs = COOLDOWN_MS;
      console.log(`[scout] rescrape complete, added=${added}`);
    } else {
      cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
      console.log(`[scout] rescrape added 0 — backing off to ${Math.round(cooldownMs / 60000)} min`);
    }
  } catch (e) {
    console.error('[scout] rescrape crashed:', e.message);
  } finally {
    scoutRunning = false;
  }
}

function startScoutWatcher() {
  cron.schedule('*/3 * * * *', () => {
    // Claimable-aware, mirroring the /claim eligibility predicate: pending rows
    // held by a company_policy block/cooldown don't count.
    const profiles = db.prepare('SELECT id FROM profiles WHERE intake_completed_at IS NOT NULL').all();
    for (const { id } of profiles) {
      const { n } = db.prepare(`
        SELECT COUNT(*) AS n FROM job_queue jq
        WHERE profile_id = ? AND status = 'pending' AND submitted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_policy p
            WHERE p.profile_id = jq.profile_id AND p.company_key = jq.company_key
              AND (p.policy = 'blocked' OR p.reopen_after IS NULL OR p.reopen_after > datetime('now'))
          )
      `).get(id);
      if (n === 0) triggerScout(id, 'queue-empty');
    }
  });
  console.log('[scout] queue-drain watcher started (3 min interval)');
}

module.exports = { startScoutWatcher, triggerScout };
