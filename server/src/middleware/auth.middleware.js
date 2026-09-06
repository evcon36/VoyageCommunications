const { verifyToken } = require('../lib/jwt');
function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Не авторизован' });
    }
    const payload = verifyToken(authHeader.split(' ')[1]);
    req.user = { id: String(payload.sub || payload.userId), username: payload.username };
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Недействительный токен' });
  }
}
module.exports = authMiddleware;
