// Fail fast with a clear message on old Node — the DB layer needs the built-in
// node:sqlite module (Node >= 22.5), which otherwise dies with a cryptic error.
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`Node ${process.versions.node} is too old — need >= 22.5 (built-in node:sqlite). Run: nvm install 22 && nvm use 22`);
    process.exit(1);
  }
}

// No `override` — real environment variables win over .env (so
// `PORT=3002 npm run server` behaves as expected).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');

const authMiddleware = require('./middleware/auth');
const { startScoutWatcher } = require('./services/scout_watcher');

if (process.env.NODE_ENV === 'production' && !process.env.APP_PASSWORD) {
  console.error('APP_PASSWORD must be set in production. Refusing to start with open access.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    passwordProtected: !!process.env.APP_PASSWORD,
  });
});

app.use('/api/profiles', authMiddleware, require('./routes/profiles').router);
app.use('/api/jobs', authMiddleware, require('./routes/jobs'));
app.use('/api/applications', authMiddleware, require('./routes/applications'));

app.use((err, req, res, next) => {
  console.error('unhandled request error', req.method, req.path, err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Serve the built React client in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`auto-apply server on :${PORT} (password protected: ${!!process.env.APP_PASSWORD})`);
  startScoutWatcher();
});
