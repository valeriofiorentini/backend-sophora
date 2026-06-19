const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return error(res, 'Token mancante', 401);
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return error(res, 'Token non valido o scaduto', 401);
  }
}

module.exports = { auth };
