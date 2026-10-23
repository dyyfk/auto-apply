# Auto Apply

Job-application automation. Scouts open roles from public ATS boards, keeps a
deduplicated queue, and auto-fills + submits applications on **Ashby**,
**Greenhouse**, and **Lever** using Playwright — driven entirely by a per-user
profile you set up once in the web UI.

Extracted and rewritten from a personal job-search tool: the cold-email /
LinkedIn-outreach half is gone, the battle-tested apply pipeline remains, and
everything personal is now a profile in the database instead of hardcoded.

## How it works

```
scripts/scout.js ──► POST /api/jobs/bulk ──► job_queue (dedup + policy)
                                                 │  POST /api/jobs/claim
                                                 ▼
                                        scripts/apply.js ──► Playwright fills the
                                                 │            ATS form (profile-driven)
                                                 ▼
                                        applications (permanent record + dedup)
```

- **Server** (`server/`): Express + SQLite (`node:sqlite`, Node 22+). Owns the
  queue, all dedup decisions, the claim protocol, profiles, and resume storage.
- **Scout** (`scripts/scout.js`): polls the Ashby posting API and Greenhouse
  boards API for the boards in `config/boards.json`, filters titles/locations,
  and bulk-inserts candidates. The server re-checks everything.
- **Apply** (`scripts/apply.js`): claims roles and drives a real Chrome (over
  CDP) through the application form. One engine per ATS in `scripts/lib/`.
- **Client** (`client/`): React UI — first-run onboarding wizard, queue
  dashboard, application tracker, profile editor.

## LinkedIn and Jobright connectors

`scripts/connect.js` reads LinkedIn and Jobright through your own signed-in
Chrome (the same CDP session `apply.js` uses), resolves each listing to its
external application link, keeps only Ashby / Greenhouse / Lever links, and
writes `roles.json` in the format `apply.js` already accepts.

```bash
google-chrome --remote-debugging-port=9222   # sign in to LinkedIn and Jobright once

npm run connect -- linkedin --query "software engineer" --query "backend engineer" --recent-hours 24
npm run connect -- jobright
npm run connect -- all --max 60

npm run apply -- roles.json --dry-run
npm run apply -- roles.json
```

- Output is merged into `roles.json` by canonical URL; `--overwrite` replaces it, `--out` changes the path.
- Title filters come from `config/boards.json`; `--no-filter` disables them.
- `--push` also sends results to the queue (`/api/jobs/bulk`) so the server's dedup applies.
- LinkedIn Easy Apply and unsupported ATS listings are skipped and counted in the summary.
- Both sites discourage automated access. Keep `--max` modest and expect the page selectors to need occasional updates.

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node.js ≥ 22.5** | the DB layer uses the built-in `node:sqlite` module | `node --version` |
| **npm** (ships with Node) | installs everything else | `npm --version` |
| **macOS or Linux** | shell-style npm scripts and default paths; on Windows use WSL | — |
| **~500 MB disk + internet** during setup | npm packages + the Playwright Chromium download | — |
| **A browser for the appliers** (either one works, see [Browser](#browser)) | Playwright drives it through the ATS forms | `npm run doctor` |

No API keys, no OAuth, no external accounts. The server, database (SQLite
file), resume storage, and UI are all local.

**Installing Node 22** if you don't have it:

```bash
# via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22
```

or download from https://nodejs.org (choose 22 LTS or newer).

## Setup on a fresh machine

```bash
git clone <this-repo> && cd auto_apply_job
npm run setup
```

`npm run setup` is idempotent and does everything: verifies the Node version,
installs server + client dependencies, downloads the Playwright Chromium
fallback browser, and creates `.env` from `.env.example`. When it finishes it
prints the exact next commands.

Then start the app and set up your profile:

```bash
npm run dev                 # API on :3001, web UI on http://localhost:5173
```

Open http://localhost:5173 and complete onboarding:

1. **Basics** — name, contact, links, location.
2. **Resume upload** — any PDF/DOC/DOCX; this exact file is attached to every
   application. Each user just uploads their own resume here.
3. **Work authorization (sanity questions)** — are you authorized to work, do
   you need sponsorship now or in the future, visa status, employment/student
   status, relocation willingness. These drive every screening answer on every
   form, and the pipeline **refuses to apply until they're answered**.
4. **Background** — education, "tell us about yourself" / "why us" paragraphs.

At any point, verify the environment:

```bash
npm run doctor              # checks Node, deps, browser, server, profile state
```

It prints ✅/⚠️/❌ per prerequisite with the exact fix for anything missing.

## Browser

The appliers need one of these (doctor tells you which you have):

- **Option A — your real Chrome over CDP** (recommended: you keep your
  sessions and can watch the forms being filled). Launch Chrome with remote
  debugging before applying:

  ```bash
  # macOS
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"
  ```

  ```bash
  # Linux
  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"
  ```

- **Option B — the bundled Playwright Chromium** (installed by `npm run
  setup`; nothing to launch). The appliers fall back to it automatically when
  no Chrome is listening on the CDP port. A persistent profile is kept in
  `.apply-browser-profile/` so Greenhouse's device trust survives between runs.

## Applying

Fill the queue and apply:

```bash
node scripts/scout.js                      # discover roles into the queue
node scripts/apply.js --queue --dry-run    # fill forms, DON'T submit — review first
node scripts/apply.js --queue --max 5      # live: claim + fill + submit 5 roles
```

Or apply to a hand-picked list:

```bash
node scripts/apply.js roles.json           # [{"company","role_title","url", "overrides"?...}]
node scripts/apply.js roles.json --prep    # Lever: fill + leave tab open for manual captcha
```

Per-role `overrides.answers` (`[{ "re": "label regex", "val": "answer" }]`)
handle company-specific questions; `"val": ""` means "leave that field blank".

**Always dry-run a new company first.** Many ATS tenants allow only 1–3
applications per person, ever — a badly-filled submit burns the slot
permanently. The dry run fills everything, screenshots the form
(`screenshots/`), and reports every field it left blank.

### Greenhouse email verification

Some Greenhouse boards email a security code after submit. The applier pauses
and polls `/tmp/gh_seccode.txt` (configurable via `GH_CODE_FILE`) — paste the
code from your inbox into that file and it continues.

## Safety properties (inherited from hard experience — don't weaken)

- **Fail-closed fences.** If the API is unreachable, nothing is submitted. A
  false block costs one role; a false allow burns an ATS cap.
- **submitted_at before the click.** The row is marked immediately *before*
  Submit, so a crash mid-submit still blocks re-applies. Claim tokens stop
  concurrent sessions from clobbering each other.
- **Dedup on two signals**: canonicalized posting URL and normalized
  (company, role-title) keys, enforced by UNIQUE indexes, per profile.
- **Demographic/EEO questions are never auto-answered** — the appliers pick
  "decline to answer" or leave them blank, always.
- **No guessing.** A question with no matching answer is skipped and surfaced
  as a warning (visible failure > false claim on a form).
- **No false positives**: "have you interviewed here / were you referred / do
  you use our product / are you currently a student" all default to No.
- Server-side rate limits: max 5 submissions per company per day, 10 lifetime;
  per-company blocks/cooldowns via the `company_policy` table.

## Configuration

- `config/boards.json` — which Ashby/Greenhouse boards to scout and the
  title/location filters. Edit freely.
- `.env` — port, optional `APP_PASSWORD` (required in production), paths.
- Multiple users on one server: every profile is isolated (own queue, own
  applications, own dedup). Scripts take `--profile-id N`; with one profile it
  is picked automatically.

## Troubleshooting

- **`npm install` fails with an engine error** — your Node is older than 22.5;
  `nvm install 22 && nvm use 22` and re-run `npm run setup`.
- **Server exits immediately with a Node version message** — same fix.
- **`EADDRINUSE: :3001`** — something else owns the port; set `PORT` in `.env`
  (and `JOBS_API=http://localhost:<port>` when running the scripts).
- **`apply.js` says `INTAKE_INCOMPLETE`** — finish the onboarding wizard in
  the web UI (resume + work-authorization questions); this gate is deliberate.
- **`connectOverCDP failed` and no bundled Chromium** — run
  `npx playwright install chromium`, or launch Chrome per [Browser](#browser).
- **Anything else** — `npm run doctor` first; it names the missing piece.

## Layout

```
server/
  index.js               # Express entry
  db.js                  # schema, normalized-key dedup, skip taxonomy
  routes/profiles.js     # profiles + resume upload + intake gating
  routes/jobs.js         # queue, dedup, claim protocol, fences
  routes/applications.js # submitted-application tracker
  services/scout_watcher.js  # auto-rescrape when the queue drains
scripts/
  setup.js               # one-shot fresh-machine setup (npm run setup)
  doctor.js              # environment self-check (npm run doctor)
  scout.js               # config-driven role discovery (Ashby + Greenhouse APIs)
  apply.js               # unified claim→fill→submit runner
  lib/api.js             # fence client (all DB access goes through the API)
  lib/answers.js         # profile-driven answer policy (shared by all ATSes)
  lib/ashby.js           # Ashby form engine
  lib/greenhouse.js      # Greenhouse form engine
  lib/lever.js           # Lever form engine
client/src/pages/        # Onboarding, Dashboard, Applications, Profile, Login
config/boards.json       # scout board list + filters
test/                    # API tests: intake gating, dedup, claim protocol
```

```bash
npm test                 # run the API test suite
```

## Production

```bash
npm run build
NODE_ENV=production APP_PASSWORD=... npm start   # serves API + built UI on :3001
```

Set `DB_PATH` and `UPLOADS_DIR` to a mounted volume when deploying.
