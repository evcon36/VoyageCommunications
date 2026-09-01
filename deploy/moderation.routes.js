// Жалобы на участников и чёрный список.
//
// Зачем это есть. В приложении люди общаются между собой и обмениваются
// файлами, а такое App Store проверяет отдельно (Guideline 1.2): должна быть
// возможность пожаловаться на человека и перестать получать от него звонки.
// Без этого приложение с чатом и открытыми комнатами отклоняют.
//
// Жалобу должен уметь оставить и гость без аккаунта: чаще всего именно он и
// сталкивается с посторонним в открытой комнате. Поэтому право подтверждается
// не входом в аккаунт, а токеном комнаты: он подписан нашим ключом и внутри
// несёт название комнаты, значит жалующийся действительно был в этом звонке.

const express = require('express');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');

const router = express.Router();

const REASONS = new Set(['abuse', 'nudity', 'spam', 'threat', 'other']);
const REASON_TEXT = {
  abuse: 'Оскорбления',
  nudity: 'Непристойное поведение',
  spam: 'Спам или реклама',
  threat: 'Угрозы',
  other: 'Другое',
};

// Кто жалуется, берём из токена комнаты, а не из тела запроса: иначе можно
// подписать жалобу чужим именем
function roomTokenClaims(roomId, token) {
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!secret || !token) return null;
  try {
    const claims = jwt.verify(String(token), secret);
    if (claims?.video?.roomJoin !== true || claims?.video?.room !== roomId) return null;
    return claims;
  } catch {
    return null;
  }
}

// Не даём завалить таблицу: десять жалоб в час с адреса
const recent = new Map();
function allowed(ip) {
  const now = Date.now();
  const fresh = (recent.get(ip) || []).filter(t => now - t < 3600_000);
  if (fresh.length >= 10) { recent.set(ip, fresh); return false; }
  fresh.push(now);
  recent.set(ip, fresh);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of recent) {
    const fresh = times.filter(t => now - t < 3600_000);
    if (fresh.length) recent.set(ip, fresh); else recent.delete(ip);
  }
}, 3600_000).unref();

// ── Пожаловаться на участника ──
router.post('/report', async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (!allowed(ip)) {
      return res.status(429).json({ message: 'Слишком много жалоб подряд. Попробуйте позже' });
    }

    const { roomId, targetIdentity, targetName, reason, note } = req.body || {};
    if (!roomId || !targetIdentity) {
      return res.status(400).json({ message: 'Не указан участник' });
    }
    const claims = roomTokenClaims(roomId, req.get('X-Room-Token') || '');
    if (!claims) {
      return res.status(403).json({ message: 'Жалобу можно оставить только из своего звонка' });
    }
    const reporter = String(claims.sub || 'неизвестно');
    if (reporter === String(targetIdentity)) {
      return res.status(400).json({ message: 'Нельзя пожаловаться на себя' });
    }

    const safeReason = REASONS.has(reason) ? reason : 'other';
    await prisma.$executeRaw`
      INSERT INTO "Report" ("roomId", reporter, target, "targetName", reason, note)
      VALUES (${String(roomId).slice(0, 60)}, ${reporter.slice(0, 80)},
              ${String(targetIdentity).slice(0, 80)}, ${String(targetName || '').slice(0, 80)},
              ${safeReason}, ${String(note || '').slice(0, 500)})`;

    // В журнал сервиса, чтобы жалоба была видна и без похода в базу
    console.warn(`ЖАЛОБА: комната ${roomId}, на ${targetIdentity} (${targetName || '?'}), ` +
      `причина ${REASON_TEXT[safeReason]}, от ${reporter}`);

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('REPORT ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось отправить жалобу' });
  }
});

// ── Чёрный список ──
// Работает только между аккаунтами: у гостя нет постоянного имени, которое
// имело бы смысл запоминать. Гостя из звонка убирает владелец комнаты.

router.get('/blocks', authMiddleware, async (req, res) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT blocked, "createdAt" FROM "UserBlock"
      WHERE owner = ${req.user.username} ORDER BY "createdAt" DESC`;
    return res.json({ blocks: rows });
  } catch (e) {
    console.error('BLOCKS ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

router.post('/block', authMiddleware, async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').trim();
    if (!username) return res.status(400).json({ message: 'Не указан пользователь' });
    if (username === req.user.username) return res.status(400).json({ message: 'Нельзя заблокировать себя' });
    await prisma.$executeRaw`
      INSERT INTO "UserBlock" (owner, blocked) VALUES (${req.user.username}, ${username.slice(0, 80)})
      ON CONFLICT (owner, blocked) DO NOTHING`;
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('BLOCK ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось заблокировать' });
  }
});

router.post('/unblock', authMiddleware, async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').trim();
    if (!username) return res.status(400).json({ message: 'Не указан пользователь' });
    await prisma.$executeRaw`
      DELETE FROM "UserBlock" WHERE owner = ${req.user.username} AND blocked = ${username}`;
    return res.json({ ok: true });
  } catch (e) {
    console.error('UNBLOCK ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось разблокировать' });
  }
});

// Общая проверка для звонков: блокировка работает в обе стороны, иначе
// заблокированный просто звонит сам и обходит запрет
async function callBlocked(a, b) {
  if (!a || !b) return false;
  try {
    const rows = await prisma.$queryRaw`
      SELECT 1 FROM "UserBlock"
      WHERE (owner = ${a} AND blocked = ${b}) OR (owner = ${b} AND blocked = ${a}) LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;   // сбой базы не должен запрещать звонки всем подряд
  }
}

module.exports = router;
module.exports.callBlocked = callBlocked;
