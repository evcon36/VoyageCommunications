require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const authRoutes = require('./src/routes/auth.routes');
const roomsRoutes = require('./src/routes/rooms.routes');
const companyRoutes = require('./src/routes/company.routes');
const recordingsRoutes = require('./src/routes/recordings.routes');
const contactsRoutes = require('./src/routes/contacts.routes');
const internalRoutes = require('./src/routes/internal.routes');
const prisma = require('./src/lib/prisma');
const recTimeline = require('./src/lib/recTimeline');
const { verifyToken } = require('./src/lib/jwt');
const jwt = require('jsonwebtoken');
const moderationRoutes = require('./src/routes/moderation.routes');

const app = express();

// оба домена сервиса (voyage-community.ru и voyage-coms.ru за Cloudflare)
const ALLOWED_ORIGINS = [
  process.env.CLIENT_URL || "http://localhost:5173",
  "https://voyage-coms.ru",
  "https://www.voyage-coms.ru",
  // запасной путь мимо Cloudflare (для провайдеров, которые режут CF)
  "https://communications.voyage-community.ru",
  // Мобильное приложение отдаёт свой бандл с внутренней схемы, а не с домена,
  // поэтому его origin выглядит так. Без этих строк WKWebView режет ответы
  // по CORS, и приложение показывает «нет соединения с сервером».
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
];

// Настоящий адрес человека приходит от nginx заголовком. Без этой строки
// Express считает адресом сам nginx, то есть 127.0.0.1 у всех подряд, и любое
// ограничение «столько-то с адреса» превращается в общее на весь сервис: один
// перебор закрывал доступ всем остальным. Доверяем только петле: заголовок от
// постороннего, пришедшего мимо nginx, не в счёт.
app.set('trust proxy', 'loopback');

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] } });

const roomUsers = new Map();
const admittedWaiters = new Map(); // roomId -> Set(userId|socketId)
const crypto = require('crypto');
const fsp = require('fs').promises;
const nodePath = require('path');

// Кто автор какого сообщения, по комнатам. Живёт в памяти, как и сам чат:
// переписка нигде не хранится и исчезает вместе со звонком.
const chatAuthors = new Map();

const CHAT_UPLOAD_ROOT = '/var/www/voyage/uploads/chat';

// Удаление вложения вместе с сообщением. Путь проверяем заново, хотя он и
// наш: одна ошибка выше по коду не должна давать удаление чужих файлов.
async function removeChatFile(url) {
  try {
    const rel = String(url || '').replace(/^\/uploads\/chat\//, '');
    if (!rel || rel.includes('..')) return;
    const full = nodePath.resolve(CHAT_UPLOAD_ROOT, rel);
    if (!full.startsWith(CHAT_UPLOAD_ROOT + nodePath.sep)) return;
    await fsp.unlink(full);
  } catch { /* файла уже нет */ }
}

global.admittedWaiters = admittedWaiters;
// Маршруты записи шлют предупреждение всем в комнате: сокет им нужен, а
// импортировать сервер оттуда нельзя, получится круг
global.io = io;

// Кто сейчас на сайте: username -> Set<socketId> (для входящих звонков)
const onlineUsers = new Map();
function addPresence(username, socketId) {
  if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
  onlineUsers.get(username).add(socketId);
}
function removePresence(username, socketId) {
  const set = onlineUsers.get(username);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(username);
}

// ── Состояние звонков ──
// callId -> { from, to, roomSlug, inviteKey, fromName, state, timer }
const activeCalls = new Map();
const CALL_TIMEOUT_MS = 45000;

function emitTo(username, event, payload) {
  for (const sid of onlineUsers.get(username) || []) io.to(sid).emit(event, payload);
}

// Занят, если уже в комнате или в процессе другого звонка.
// Без этой проверки второй входящий молча перезатирал первый, и человек
// принимал звонок от одного, а попадал в комнату к другому.
function isBusy(username) {
  for (const sid of onlineUsers.get(username) || []) {
    if (io.sockets.sockets.get(sid)?.data?.roomId) return true;
  }
  for (const c of activeCalls.values()) if (c.from === username || c.to === username) return true;
  return false;
}

function endCall(callId, reason) {
  const call = activeCalls.get(callId);
  if (!call) return;
  clearTimeout(call.timer);
  activeCalls.delete(callId);
  // сообщаем обеим сторонам: иначе одна из них остаётся ждать в пустоте
  emitTo(call.from, 'call-ended', { callId, reason, peer: call.to });
  emitTo(call.to, 'call-ended', { callId, reason, peer: call.from });
}

// отказ ещё до создания звонка (сам себе, недоступен, занят)
function endToCaller(socket, reason) {
  socket.emit('call-ended', { callId: null, reason });
}

// Звонки пользователя, оборвавшиеся вместе с его соединением
function endCallsOf(username) {
  if (!username) return;
  for (const [id, c] of activeCalls) {
    if (c.from === username) endCall(id, 'cancelled');
    else if (c.to === username) endCall(id, 'unavailable');
  }
}

function emitRoomUsers(roomId) {
  if (!roomId) return;
  const users = roomUsers.get(roomId) || [];
  io.to(roomId).emit('room-users', users.map(u => ({ socketId: u.socketId, userName: u.userName })));
}

function removeUserFromRoom(roomId, socketId) {
  if (!roomId) return;
  const users = (roomUsers.get(roomId) || []).filter(u => u.socketId !== socketId);
  if (users.length > 0) roomUsers.set(roomId, users);
  else {
    roomUsers.delete(roomId);
    // Комната опустела: авторство сообщений больше не нужно, иначе карта
    // растёт весь срок жизни процесса
    chatAuthors.delete(roomId);
    // Комната опустела — список впущенных больше не нужен. Без этой строки
    // он копился в памяти процесса до самого перезапуска сервера, и человек,
    // однажды впущенный в комнату, заходил в неё потом без спроса.
    admittedWaiters.delete(roomId);
  }
}

async function endSession(socket) {
  if (socket.data.sessionId) {
    try {
      const duration = socket.data.joinedAt ? Math.floor((Date.now() - socket.data.joinedAt) / 1000) : null;
      await prisma.callSession.update({
        where: { id: socket.data.sessionId },
        data: { leftAt: new Date(), duration },
      });
    } catch (e) { console.error('endSession error:', e.message); }
    socket.data.sessionId = null;
  }
}

// ── Право войти в комнату ──
// Раньше «join-room» пускал кого угодно в любую комнату по её названию.
// Видео при этом было защищено токеном, а вот переписка, список участников и
// события звонка нет: посторонний подключался к сокету, называл комнату и
// читал чужой разговор, не появляясь ни у кого на экране.
//
// Отдельный пропуск заводить не стали: у того, кому вход разрешён, уже есть
// токен медиасервера на эту самую комнату. Он подписан нашим ключом и внутри
// несёт название комнаты, поэтому годится как доказательство права.
function roomTokenOk(roomId, token) {
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!secret || !token) return false;
  try {
    const claims = jwt.verify(String(token), secret);   // подпись и срок годности
    return claims?.video?.roomJoin === true && claims?.video?.room === roomId;
  } catch {
    return false;
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', async ({ roomId, userName, userId, roomToken }) => {
    if (!roomId) return;
    if (!roomTokenOk(roomId, roomToken)) {
      socket.emit('room-denied', { message: 'Нет доступа к этой комнате' });
      return;
    }
    if (socket.data.roomId) {
      await endSession(socket);
      removeUserFromRoom(socket.data.roomId, socket.id);
      socket.leave(socket.data.roomId);
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size >= 10) { socket.emit('room-full'); return; }

    socket.data.roomId = roomId;
    socket.data.userName = userName || 'Участник';
    socket.data.joinedAt = Date.now();

    // Save call session
    if (userId) {
      try {
        const session = await prisma.callSession.create({ data: { userId, roomId, userName: socket.data.userName } });
        socket.data.sessionId = session.id;
      } catch (e) { console.error('callSession create error:', e.message); }
    }

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, []);
    removeUserFromRoom(roomId, socket.id);
    const users = roomUsers.get(roomId) || [];
    users.push({ socketId: socket.id, userName: socket.data.userName });
    roomUsers.set(roomId, users);
    socket.join(roomId);

    emitRoomUsers(roomId);
    const updatedUsers = roomUsers.get(roomId) || [];

    if (updatedUsers.length === 1) {
      socket.emit('room-created', { yourName: socket.data.userName });
    } else {
      const newUser = updatedUsers[updatedUsers.length - 1];
      io.to(newUser.socketId).emit('room-joined', { yourName: newUser.userName, remoteUserName: updatedUsers[0].userName });
      socket.to(roomId).emit('participant-joined', { remoteUserName: newUser.userName });
      if (updatedUsers.length === 2) {
        const [first, second] = updatedUsers;
        io.to(first.socketId).emit('init', { isInitiator: true });
        io.to(second.socketId).emit('init', { isInitiator: false });
      }
    }
  });

  // Пользователь сообщает, кто он (после авторизации на клиенте).
  // Ник берём ИЗ ТОКЕНА, а не из тела события. Раньше сервер верил клиенту
  // на слово: любой, кто открыл сокет, мог назваться чужим ником и получать
  // его входящие звонки вместе со ссылкой и ключом на приватную комнату.
  socket.on('presence', ({ token }) => {
    let name = '';
    try { name = String(verifyToken(token)?.username || ''); } catch { name = ''; }
    // Токен мог протухнуть, пока приложение было открыто. Молча игнорировать
    // нельзя: человек выглядит залогиненным, а звонки до него не доходят.
    if (!name) return socket.emit('presence-rejected');
    if (socket.data.presenceUsername === name) return;
    if (socket.data.presenceUsername) removePresence(socket.data.presenceUsername, socket.id);
    socket.data.presenceUsername = name;
    addPresence(name, socket.id);
  });

  // ── Звонок контакту ──
  // Звонящий НЕ входит в комнату, пока не ответили: до этого он в состоянии
  // «дозвон». Состояние живёт здесь, клиенты только отражают присланное —
  // иначе两 стороны расходятся и звонок зависает.

  socket.on('call-start', async ({ toUsername, roomSlug, inviteKey, fromName }) => {
    const from = socket.data.presenceUsername;
    const to = String(toUsername || '');
    if (!from || !to) return;
    if (from === to) return endToCaller(socket, 'self');

    // Чёрный список работает в обе стороны: иначе заблокированный просто
    // звонит сам и запрет ничего не значит. Причину не раскрываем: человеку
    // незачем знать, заблокировали его или просто нет в сети.
    if (await moderationRoutes.callBlocked(from, to)) return endToCaller(socket, 'unavailable');

    const targets = onlineUsers.get(to);
    if (!targets || targets.size === 0) return endToCaller(socket, 'unavailable');
    // Звонящий тоже может быть занят: сидеть в другой комнате или уже кому-то
    // дозваниваться. Раньше проверялась только сторона получателя, и человек
    // из активного разговора мог начать второй звонок и попасть в две комнаты.
    if (isBusy(from)) return endToCaller(socket, 'busy-self');
    if (isBusy(to)) return endToCaller(socket, 'busy');

    const callId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const call = {
      callId, from, to, roomSlug, inviteKey, fromName: fromName || from, state: 'ringing',
      // нужен, чтобы ответ ушёл именно тому устройству, с которого звонили
      fromSocketId: socket.id,
    };
    call.timer = setTimeout(() => endCall(callId, 'timeout'), CALL_TIMEOUT_MS);
    activeCalls.set(callId, call);

    for (const sid of targets) {
      io.to(sid).emit('call-incoming', { callId, from, fromName: call.fromName, roomSlug, inviteKey });
    }
    socket.emit('call-ringing', { callId, to, timeoutMs: CALL_TIMEOUT_MS });
  });

  socket.on('call-accept', ({ callId }) => {
    const call = activeCalls.get(callId);
    // переход из ringing разрешён ровно один раз: иначе звонок примут
    // и на телефоне, и на ноутбуке, и оба войдут в комнату
    if (!call || call.state !== 'ringing') return;
    if (socket.data.presenceUsername !== call.to) return;

    call.state = 'active';
    clearTimeout(call.timer);
    // Ответ уходит тому устройству, с которого звонили. Если оно успело
    // переподключиться и сменить socketId, падаем на рассылку по нику:
    // иначе звонящий останется висеть в «дозвоне» после успешного ответа.
    const payload = { callId, roomSlug: call.roomSlug, inviteKey: call.inviteKey, by: call.to };
    if (call.fromSocketId && io.sockets.sockets.get(call.fromSocketId)) {
      io.to(call.fromSocketId).emit('call-accepted', payload);
    } else {
      emitTo(call.from, 'call-accepted', payload);
    }
    // Разрешение войти получателю. Клиент не входит в комнату сам по нажатию
    // «Принять»: иначе при ответе сразу с двух устройств оба входили в
    // комнату, потому что серверный отказ приходил уже после входа.
    socket.emit('call-accept-ok', { callId, roomSlug: call.roomSlug, inviteKey: call.inviteKey });
    // остальным устройствам получателя: звонок уже приняли, плашку убрать
    for (const sid of onlineUsers.get(call.to) || []) {
      if (sid !== socket.id) io.to(sid).emit('call-ended', { callId, reason: 'taken' });
    }
    activeCalls.delete(callId);
  });

  socket.on('call-decline', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call || socket.data.presenceUsername !== call.to) return;
    endCall(callId, 'declined');
  });

  socket.on('call-cancel', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call || socket.data.presenceUsername !== call.from) return;
    endCall(callId, 'cancelled');
  });

  // Слать в комнату может только тот, кто в ней есть. Без этой проверки любой,
  // кто открыл сокет, мог писать в чужую комнату от чужого имени, включать
  // там ложный индикатор записи и, что хуже всего, впустить сам себя в чужую
  // комнату ожидания, ни разу в неё не заходя.
  const inRoom = (roomId) => Boolean(roomId) && socket.data.roomId === roomId;

  // Стук в приватную комнату — видят те, кто уже внутри (решает владелец)
  socket.on('knock', ({ roomId, username, name }) => {
    if (!roomId || !username) return;
    io.to(roomId).emit('knock', { roomId, username, name });
  });

  // ── Комната ожидания (приёмная) ──
  // Клиент показывает ожидающих и решает, кого впустить. Здесь связываем:
  // стук уходит тем, кто уже в звонке; допуск запоминается в admittedWaiters,
  // и по нему /rooms/token (и гостевой /rooms/guest-token) выдаёт доступ.
  socket.on('wait-knock', ({ roomId, name, userId }) => {
    if (!roomId) return;
    // socketId нужен, чтобы ответить именно этому ожидающему
    socket.to(roomId).emit('wait-knock', { roomId, name, userId, socketId: socket.id });
  });

  socket.on('wait-admit', ({ roomId, socketId, userId }) => {
    if (!socketId) return;
    // впускать может только тот, кто сам уже в этой комнате
    if (!inRoom(roomId)) return;
    if (!admittedWaiters.has(roomId)) admittedWaiters.set(roomId, new Set());
    // Для гостей вместо id аккаунта приходит их номер, а он теперь подписан.
    // Запоминаем открытую часть: её же проверит выдача токена.
    const waiterKey = String(userId || socketId).split('.')[0];
    admittedWaiters.get(roomId).add(waiterKey);
    io.to(socketId).emit('wait-admitted', { roomId });
  });

  socket.on('wait-deny', ({ roomId, socketId }) => {
    if (!socketId) return;
    // отказывать, как и впускать, может только тот, кто сам уже в комнате
    if (!inRoom(roomId)) return;
    io.to(socketId).emit('wait-denied', { roomId });
  });

  // Старый путь прямого соединения. Пересылка шла в любую названную комнату
  // без проверки, поэтому посторонний мог вклиниваться в чужие переговоры о
  // соединении. Теперь только из своей комнаты.
  socket.on('offer', ({ roomId, offer }) => { if (inRoom(roomId)) socket.to(roomId).emit('offer', offer); });
  socket.on('answer', ({ roomId, answer }) => { if (inRoom(roomId)) socket.to(roomId).emit('answer', answer); });
  socket.on('ice-candidate', ({ roomId, candidate }) => { if (inRoom(roomId)) socket.to(roomId).emit('ice-candidate', candidate); });

  // Кто отправил какое сообщение. Сообщения нигде не хранятся, живут только у
  // участников на экране, поэтому право на правку и удаление сервер помнит
  // сам: без этого «своё» определял бы клиент, а значит правь что хочешь.
  //
  // Ключ автора это ник, если человек вошёл в аккаунт, иначе номер соединения.
  // У гостя после обрыва номер сменится и он потеряет право на свои прежние
  // сообщения: неприятно, но безопаснее, чем верить присланному имени.
  const authorKey = () => socket.data.presenceUsername || `sock:${socket.id}`;

  socket.on('chat-message', ({ roomId, userName, text, timestamp, attachment }) => {
    if (!inRoom(roomId)) return;

    // Вложение пропускаем только если ссылка ведёт в нашу папку загрузок для
    // этой же комнаты. Иначе через чат можно было бы разослать всем ссылку
    // куда угодно, а выглядела бы она как файл, отправленный собеседником.
    let safe;
    if (attachment && typeof attachment.url === 'string') {
      const expected = `/uploads/chat/${String(roomId).replace(/[^a-zA-Z0-9_-]/g, '')}/`;
      if (attachment.url.startsWith(expected) && !attachment.url.includes('..')) {
        safe = {
          url: attachment.url,
          name: String(attachment.name || 'файл').slice(0, 120),
          size: Number(attachment.size) || 0,
          kind: attachment.kind === 'image' ? 'image' : 'file',
        };
      }
    }

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    if (!chatAuthors.has(roomId)) chatAuthors.set(roomId, new Map());
    chatAuthors.get(roomId).set(id, { author: authorKey(), file: safe?.url || null });

    // имя берём то, под которым человек реально вошёл в комнату
    io.to(roomId).emit('chat-message', {
      id,
      userName: socket.data.userName || userName,
      text,
      timestamp,
      attachment: safe,
    });
  });

  // ── Правка своего сообщения ──
  socket.on('chat-edit', ({ roomId, id, text }) => {
    if (!inRoom(roomId)) return;
    const rec = chatAuthors.get(roomId)?.get(id);
    if (!rec || rec.author !== authorKey()) return;   // чужое не трогаем
    const clean = String(text || '').slice(0, 4000).trim();
    if (!clean) return;   // пустая правка это удаление, для него своё событие
    io.to(roomId).emit('chat-edited', { id, text: clean });
  });

  // ── Удаление своего сообщения ──
  socket.on('chat-delete', ({ roomId, id }) => {
    if (!inRoom(roomId)) return;
    const rec = chatAuthors.get(roomId)?.get(id);
    if (!rec || rec.author !== authorKey()) return;
    chatAuthors.get(roomId).delete(id);
    // Вложение удаляем с диска вместе с сообщением: иначе файл остаётся
    // доступен по прямой ссылке, хотя человек его отозвал
    if (rec.file) removeChatFile(rec.file);
    io.to(roomId).emit('chat-deleted', { id });
  });

  socket.on('sound', ({ roomId, soundId, fromUser, toUser }) => {
    if (!inRoom(roomId)) return;
    io.to(roomId).emit('sound', { soundId, fromUser, toUser });
  });

  // Индикатор записи — всем в комнате
  socket.on('recording-state', ({ roomId, active, by }) => {
    if (!inRoom(roomId)) return;
    io.to(roomId).emit('recording-state', { active, by });
  });

  // Эмодзи-реакции — всем в комнате
  socket.on('reaction', ({ roomId, emoji, fromName }) => {
    if (!inRoom(roomId)) return;
    io.to(roomId).emit('reaction', { emoji, fromName });
  });

  // таймлайн активных говорящих во время записи (для разметки транскрипта по никам)
  socket.on('rec-speaker', ({ roomId, speaker }) => {
    if (!inRoom(roomId)) return;
    recTimeline.addSpeaker(roomId, speaker, Date.now());
  });

  socket.on('media-state', ({ roomId, mediaState }) => {
    if (!inRoom(roomId)) return;
    socket.to(roomId).emit('media-state', mediaState);
  });

  socket.on('leave-room', async (roomId) => {
    const actualRoomId = roomId || socket.data.roomId;
    await endSession(socket);
    removeUserFromRoom(actualRoomId, socket.id);
    socket.leave(actualRoomId);
    socket.to(actualRoomId).emit('user-disconnected');
    emitRoomUsers(actualRoomId);
    socket.data.roomId = null;
    socket.data.userName = null;
  });

  socket.on('disconnecting', async () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      await endSession(socket);
      removeUserFromRoom(roomId, socket.id);
      socket.to(roomId).emit('user-disconnected');
      emitRoomUsers(roomId);
    }
  });

  socket.on('disconnect', () => {
    const who = socket.data.presenceUsername;
    if (who) removePresence(who, socket.id);
    socket.data.roomId = null;
    socket.data.userName = null;
    // Звонящий закрыл вкладку — у получателя плашка звонила бы вечно.
    // Обрываем только когда ушло последнее соединение пользователя.
    if (who && !onlineUsers.has(who)) endCallsOf(who);
  });
});

app.use('/auth', authRoutes);
app.use('/rooms', roomsRoutes);
app.use('/companies', companyRoutes);
app.use('/recordings', recordingsRoutes);
app.use('/contacts', contactsRoutes);
// служебные вызовы с этой же машины (очистка данных удалённых аккаунтов);
// nginx этот путь наружу не проксирует
app.use('/internal', internalRoutes);
// Вложения в чат звонка: картинки и файлы до 15 МБ
app.use('/chat', require('./src/routes/chat.routes'));
app.use('/moderation', moderationRoutes);
app.get('/', (_, res) => res.send('Backend is running'));

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log('Server started on port', PORT));
