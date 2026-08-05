// Optional bearer-token gate. When APP_PASSWORD is unset (local single-user
// use) everything is open; when set, every protected route requires
// `Authorization: Bearer <APP_PASSWORD>`.
module.exports = function auth(req, res, next) {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token === password) return next();
  res.status(401).json({ error: 'unauthorized' });
};
