const { verifyToken } = require('../lib/jwt');

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Не авторизован' });
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);

    req.user = {
      id: payload.userId,
      username: payload.username,
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Недействительный токен' });
  }
}

module.exports = authMiddleware;