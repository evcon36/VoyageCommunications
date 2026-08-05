const express = require('express');
const crypto = require('crypto');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const authMiddleware = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');

const router = express.Router();

function makeSlug() {
  const part = () => crypto.randomBytes(3).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 4).toLowerCase();
  return `voy-${part()}-${part()}`;
}
const makeKey = () => crypto.randomBytes(12).toString('base64url');

// ── Временные TURN-креды (TURN REST API) ──
// Постоянный пароль раньше лежал в публичном бандле, то есть был доступен всем.
// Теперь coturn работает в режиме use-auth-secret: логин — это срок годности,
// пароль — HMAC от него. Выдаём только вместе с токеном на вход в комнату.
const TURN_SECRET = process.env.TURN_STATIC_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || 'voyage-community.ru';
const TURN_TTL = 4 * 3600;

function iceServers(tag) {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!TURN_SECRET) return list;
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${tag || 'voyage'}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  list.push({
    urls: [`turn:${TURN_HOST}:3478`, `turns:${TURN_HOST}:5349`],
    username,
    credential,
  });
  return list;
}

// ── Гостевые комнаты ──
// Комната, созданная без аккаунта, живёт 40 минут и вмещает 5 человек.
// Признак ставится при создании и не снимается: если бы лимит зависел от
// того, кто сейчас в комнате, обойти его можно было бы, позвав знакомого с
// аккаунтом. Срок хранится в базе, а не в таймере процесса: таймер не
// переживает перезапуск, и комнаты становились бы вечными после деплоя.
const GUEST_ROOM_MINUTES = 40;
const GUEST_ROOM_PEERS = 5;

// Грубая защита от того, чтобы наш сервер использовали как бесплатный SFU.
// Обходится сменой адреса, но отсекает простые скрипты.
const guestCreateLog = new Map();
const GUEST_CREATE_WINDOW_MS = 60 * 60 * 1000;
const GUEST_CREATE_LIMIT = 10;

function guestCreateAllowed(ip) {
  const now = Date.now();
  const fresh = (guestCreateLog.get(ip) || []).filter(t => now - t < GUEST_CREATE_WINDOW_MS);
  if (fresh.length >= GUEST_CREATE_LIMIT) { guestCreateLog.set(ip, fresh); return false; }
  fresh.push(now);
  guestCreateLog.set(ip, fresh);
  return true;
}
// чтобы карта не росла бесконечно на живом сервере
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of guestCreateLog) {
    const fresh = times.filter(t => now - t < GUEST_CREATE_WINDOW_MS);
    if (fresh.length) guestCreateLog.set(ip, fresh); else guestCreateLog.delete(ip);
  }
}, GUEST_CREATE_WINDOW_MS).unref();

// Общая проверка на входе в комнату: истёк срок или нет места.
// Возвращает текст отказа либо null, если пускать можно.
async function guestLimitBlock(room, { rejoiningIdentity } = {}) {
  if (!room.isGuestRoom) return null;
  if (room.expiresAt && new Date(room.expiresAt) <= new Date()) {
    return { status: 410, body: { message: 'Время бесплатной комнаты вышло', reason: 'expired' } };
  }
  if (room.maxPeers) {
    const parts = await roomSvc.listParticipants(room.slug).catch(() => []);
    const list = Array.isArray(parts) ? parts : [];
    // Возврат после обрыва не должен упираться в лимит: человек уже был здесь,
    // просто его прежнее соединение ещё не убрали.
    const already = rejoiningIdentity && list.some(p => p.identity === rejoiningIdentity);
    if (!already && list.length >= room.maxPeers) {
      return { status: 409, body: { message: `В бесплатной комнате не больше ${room.maxPeers} человек`, reason: 'full' } };
    }
  }
  return null;
}

// Создать комнату без аккаунта
router.post('/guest-create', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!guestCreateAllowed(ip)) {
      return res.status(429).json({ message: 'Слишком много комнат подряд. Попробуйте позже' });
    }
    const { name, guestId } = req.body || {};
    const owner = String(guestId || '').slice(0, 64) || `guest#${crypto.randomBytes(4).toString('hex')}`;
    const room = await prisma.room.create({
      data: {
        slug: makeSlug(),
        name: String(name || 'Быстрый звонок').slice(0, 60),
        ownerId: owner,
        ownerName: String(name || 'Гость').slice(0, 32),
        isPrivate: true,
        inviteKey: makeKey(),
        isGuestRoom: true,
        expiresAt: new Date(Date.now() + GUEST_ROOM_MINUTES * 60 * 1000),
        maxPeers: GUEST_ROOM_PEERS,
      },
    });
    return res.status(201).json({
      room: {
        slug: room.slug,
        name: room.name,
        inviteKey: room.inviteKey,
        expiresAt: room.expiresAt,
        maxPeers: room.maxPeers,
        isGuestRoom: true,
      },
      limits: { minutes: GUEST_ROOM_MINUTES, peers: GUEST_ROOM_PEERS },
    });
  } catch (e) {
    console.error('GUEST ROOM CREATE ERROR:', e);
    return res.status(500).json({ message: 'Не удалось создать комнату' });
  }
});

// ── Создать комнату ──
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { name, isPrivate, waitingRoom, muteOnJoin, companyId } = req.body || {};
    const room = await prisma.room.create({
      data: {
        slug: makeSlug(),
        name: (name || 'Комната').slice(0, 60),
        ownerId: req.user.id,
        ownerName: req.user.username,
        isPrivate: Boolean(isPrivate),
        waitingRoom: Boolean(waitingRoom),
        muteOnJoin: Boolean(muteOnJoin),
        companyId: companyId || null,
        inviteKey: makeKey(),
      },
    });
    return res.status(201).json({ room });
  } catch (e) {
    console.error('ROOM CREATE ERROR:', e);
    return res.status(500).json({ message: 'Ошибка создания комнаты' });
  }
});

// ── Позвонить контакту: приватная комната, собеседник сразу в списке ──
router.post('/call', authMiddleware, async (req, res) => {
  try {
    const callee = String((req.body || {}).username || '').trim();
    if (!callee) return res.status(400).json({ message: 'username обязателен' });
    const room = await prisma.room.create({
      data: {
        slug: makeSlug(),
        name: `Звонок: ${req.user.username} и ${callee}`.slice(0, 60),
        ownerId: req.user.id,
        ownerName: req.user.username,
        isPrivate: true,
        members: [callee],
        inviteKey: makeKey(),
      },
    });
    return res.status(201).json({ room });
  } catch (e) {
    console.error('ROOM CALL ERROR:', e);
    return res.status(500).json({ message: 'Ошибка создания звонка' });
  }
});

// ── Мои комнаты ──
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      where: { OR: [{ ownerId: req.user.id }, { members: { has: req.user.username } }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ rooms });
  } catch (e) {
    console.error('ROOMS MY ERROR:', e);
    return res.status(500).json({ message: 'Ошибка получения комнат' });
  }
});

// ── Инфо о комнате ──
router.get('/info/:slug', authMiddleware, async (req, res) => {
  try {
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.json({ exists: false });
    const isOwner = room.ownerId === req.user.id;
    const isMember = room.members.includes(req.user.username);
    return res.json({
      exists: true,
      name: room.name,
      isPrivate: room.isPrivate,
      ownerName: room.ownerName,
      isOwner,
      hasAccess: !room.isPrivate || isOwner || isMember,
      waitingRoom: room.waitingRoom,
      muteOnJoin: room.muteOnJoin,
      members: isOwner ? room.members : undefined,
      inviteKey: isOwner ? room.inviteKey : undefined,
    });
  } catch (e) {
    console.error('ROOM INFO ERROR:', e);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── Пригласить участника (владелец; также используется чтобы "впустить постучавшегося") ──
router.post('/invite', authMiddleware, async (req, res) => {
  try {
    const { slug, username } = req.body || {};
    if (!slug || !username) return res.status(400).json({ message: 'slug и username обязательны' });
    const room = await prisma.room.findUnique({ where: { slug } });
    if (!room) return res.status(404).json({ message: 'Комната не найдена' });
    if (room.ownerId !== req.user.id) return res.status(403).json({ message: 'Приглашать может только владелец' });
    const uname = String(username).trim();
    if (room.members.includes(uname)) return res.json({ room, message: 'Уже приглашён' });
    const updated = await prisma.room.update({ where: { slug }, data: { members: { push: uname } } });
    return res.json({ room: updated, message: `${uname} приглашён` });
  } catch (e) {
    console.error('ROOM INVITE ERROR:', e);
    return res.status(500).json({ message: 'Ошибка приглашения' });
  }
});

// ── Токен LiveKit ──
router.post('/token', authMiddleware, async (req, res) => {
  try {
    const { roomId, key } = req.body || {};
    if (!roomId) return res.status(400).json({ message: 'roomId обязателен' });

    const room = await prisma.room.findUnique({ where: { slug: roomId } });
    if (room && room.isPrivate) {
      const isOwner = room.ownerId === req.user.id;
      const isMember = room.members.includes(req.user.username);
      const keyValid = key && room.inviteKey && key === room.inviteKey;
      if (!isOwner && !isMember && !keyValid) {
        return res.status(403).json({ message: 'Приватная комната: вход по ссылке-приглашению', needKnock: true });
      }
      // пришёл по ссылке — запоминаем, дальше сможет входить и без неё
      if (keyValid && !isOwner && !isMember) {
        await prisma.room.update({ where: { slug: roomId }, data: { members: { push: req.user.username } } });
      }
    }

    // Лимиты гостевой комнаты действуют и на владельцев аккаунтов: комната
    // осталась гостевой, кто бы в неё ни вошёл. Иначе ограничение снималось бы
    // приглашением любого знакомого с аккаунтом.
    if (room) {
      const blocked = await guestLimitBlock(room, { rejoiningIdentity: req.user.id });
      if (blocked) return res.status(blocked.status).json(blocked.body);
    }

    // Комната ожидания: гостей (не владелец) пускаем только после допуска ведущим
    if (room && room.waitingRoom && room.ownerId !== req.user.id) {
      const admitted = global.admittedWaiters?.get(roomId);
      if (!admitted || !admitted.has(String(req.user.id))) {
        return res.status(202).json({ waiting: true });
      }
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit не настроен' });

    const suffix = crypto.randomBytes(2).toString('hex');
    const at = new AccessToken(apiKey, apiSecret, {
      identity: `${req.user.username}#${suffix}`,
      name: req.user.username,
      ttl: '4h',
    });
    at.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true, canUpdateOwnMetadata: true });

    const token = await at.toJwt();
    return res.json({ token, wsUrl: process.env.LIVEKIT_WS_URL, ice: iceServers(req.user.username) });
  } catch (error) {
    console.error('TOKEN ERROR:', error);
    return res.status(500).json({ message: 'Ошибка генерации токена' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ГОСТЕВОЙ ВХОД ПО ССЫЛКЕ (без аккаунта)
// Пускаем ТОЛЬКО по полной ссылке-приглашению: без верного inviteKey — отказ,
// поэтому знание одного лишь номера комнаты доступа не даёт.
// ══════════════════════════════════════════════════════════════════════════

// Проверка ссылки до входа: клиент показывает название комнаты и решает,
// нужно ли предлагать гостевой экран.
router.get('/guest-info/:slug', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.json({ exists: false });
    const keyValid = Boolean(req.query.key && room.inviteKey && req.query.key === room.inviteKey);
    return res.json({
      exists: true,
      guestAllowed: keyValid,          // без ключа гостю входа нет
      name: room.name,
      ownerName: room.ownerName,
      waitingRoom: room.waitingRoom,
      muteOnJoin: room.muteOnJoin,
    });
  } catch (e) {
    console.error('GUEST INFO ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// Свободный номер для имени «Гость N»: смотрим, кто уже в комнате.
async function nextGuestName(roomId) {
  try {
    const parts = await roomSvc.listParticipants(roomId);
    let max = 0;
    for (const p of parts) {
      const m = /^Гость\s+(\d+)$/.exec(p.name || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `Гость ${max + 1}`;
  } catch {
    return 'Гость 1'; // комнаты ещё нет в LiveKit — значит гость первый
  }
}

router.post('/guest-token', async (req, res) => {
  try {
    const { roomId, key, name, guestId } = req.body || {};
    if (!roomId) return res.status(400).json({ message: 'roomId обязателен' });

    const room = await prisma.room.findUnique({ where: { slug: roomId } });
    if (!room) return res.status(404).json({ message: 'Комната не найдена' });

    // главное условие: гостя пускает только действительная ссылка-приглашение
    if (!room.inviteKey || key !== room.inviteKey) {
      return res.status(403).json({ message: 'Нужна полная ссылка-приглашение' });
    }

    const blocked = await guestLimitBlock(room, { rejoiningIdentity: guestId ? `guest#${guestId}` : null });
    if (blocked) return res.status(blocked.status).json(blocked.body);

    // Комната ожидания — уважаем настройку комнаты: гость всегда «не владелец»
    if (room.waitingRoom) {
      const admitted = global.admittedWaiters?.get(roomId);
      if (!admitted || !admitted.has(String(guestId || ''))) {
        return res.status(202).json({ waiting: true });
      }
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) return res.status(500).json({ message: 'LiveKit не настроен' });

    const clean = String(name || '').trim().slice(0, 32);
    const displayName = clean || await nextGuestName(roomId);

    const suffix = crypto.randomBytes(2).toString('hex');
    const at = new AccessToken(apiKey, apiSecret, {
      // префикс guest# — по нему сервер и клиент отличают гостя от аккаунта
      identity: `guest#${suffix}`,
      name: displayName,
      ttl: '4h',
    });
    // камера/микрофон/демонстрация экрана + чат (data). Запись гостю недоступна:
    // /recordings/* требует авторизации, гостевого токена там не примут.
    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    });

    const token = await at.toJwt();
    return res.json({ token, wsUrl: process.env.LIVEKIT_WS_URL, name: displayName, guest: true, ice: iceServers('guest') });
  } catch (error) {
    console.error('GUEST TOKEN ERROR:', error);
    return res.status(500).json({ message: 'Ошибка генерации токена' });
  }
});

// ── История ──
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const sessions = await prisma.callSession.findMany({
      where: { userId: req.user.id },
      orderBy: { joinedAt: 'desc' },
      take: 50,
    });
    return res.json({ sessions });
  } catch (error) {
    console.error('HISTORY ERROR:', error);
    return res.status(500).json({ message: 'Ошибка получения истории' });
  }
});

// ── Удалить комнату ──
router.delete('/:slug', authMiddleware, async (req, res) => {
  try {
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ message: 'Комната не найдена' });
    if (room.ownerId !== req.user.id) return res.status(403).json({ message: 'Удалять может только владелец' });
    await prisma.room.delete({ where: { slug: req.params.slug } });
    // Закрываем и сам звонок. Без этого удаление приватной комнаты
    // оборачивалось её открытием: запись из базы исчезала, проверки
    // приватности переставали срабатывать, а разговор в LiveKit продолжался,
    // и зайти в него мог любой, кто знает адрес комнаты.
    try { await roomSvc.deleteRoom(req.params.slug); } catch { /* комнаты в LiveKit могло и не быть */ }
    global.admittedWaiters?.delete(req.params.slug);
    return res.json({ message: 'Комната удалена' });
  } catch (e) {
    console.error('ROOM DELETE ERROR:', e);
    return res.status(500).json({ message: 'Ошибка удаления' });
  }
});

// ── Обновить настройки комнаты (владелец): комната ожидания, мьют при входе ──
router.patch('/:slug', authMiddleware, async (req, res) => {
  try {
    const room = await prisma.room.findUnique({ where: { slug: req.params.slug } });
    if (!room) return res.status(404).json({ message: 'Комната не найдена' });
    if (room.ownerId !== req.user.id) return res.status(403).json({ message: 'Только владелец' });
    const data = {};
    if (typeof req.body.waitingRoom === 'boolean') data.waitingRoom = req.body.waitingRoom;
    if (typeof req.body.muteOnJoin === 'boolean') data.muteOnJoin = req.body.muteOnJoin;
    if (typeof req.body.isPrivate === 'boolean') data.isPrivate = req.body.isPrivate;
    if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim().slice(0, 60);
    const updated = await prisma.room.update({ where: { slug: req.params.slug }, data });
    return res.json({ room: updated });
  } catch (e) {
    console.error('ROOM PATCH ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// клиент управления комнатами (кик/мьют участников)
const roomSvc = new RoomServiceClient('http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);

// ── Модерация: удалить участника из комнаты (ведущий/владелец) ──
router.post('/moderate', authMiddleware, async (req, res) => {
  try {
    const { roomId, targetIdentity, action } = req.body || {};
    if (!roomId || !targetIdentity) return res.status(400).json({ message: 'roomId и targetIdentity обязательны' });
    // право модерации: владелец зарегистрированной комнаты (или ad-hoc — любой участник-хост)
    const room = await prisma.room.findUnique({ where: { slug: roomId } });
    if (room && room.ownerId !== req.user.id) return res.status(403).json({ message: 'Только владелец комнаты' });
    if (action === 'remove') {
      await roomSvc.removeParticipant(roomId, targetIdentity);
    } else if (action === 'mute') {
      const p = await roomSvc.getParticipant(roomId, targetIdentity);
      const micPub = (p.tracks || []).find(t => t.source === 2 /* MICROPHONE */);
      if (micPub) await roomSvc.mutePublishedTrack(roomId, targetIdentity, micPub.sid, true);
    } else {
      return res.status(400).json({ message: 'Неизвестное действие' });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('MODERATE ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось выполнить действие' });
  }
});

module.exports = router;
