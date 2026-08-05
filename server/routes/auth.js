const express = require('express');
const router = express.Router();

// GET /api/auth/required — does the client need to show a login screen?
router.get('/required', (req, res) => {
  res.json({ required: !!process.env.APP_PASSWORD });
});

// POST /api/auth/login — { password } → { token }
// The token IS the password; auth middleware compares bearer tokens against it.
router.post('/login', (req, res) => {
  const password = process.env.APP_PASSWORD;
  if (!password) return res.json({ token: '' });
  if (req.body?.password === password) return res.json({ token: password });
  res.status(401).json({ error: 'invalid_password' });
});

module.exports = router;
