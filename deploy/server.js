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

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] } });

const roomUsers = new Map();
const admittedWaiters = new Map(); // roomId -> Set(userId|socketId)
global.admittedWaiters = admittedWaiters;

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

function emitRoomUsers(roomId) {
  if (!roomId) return;
  const users = roomUsers.get(roomId) || [];
  io.to(roomId).emit('room-users', users.map(u => ({ socketId: u.socketId, userName: u.userName })));
}

function removeUserFromRoom(roomId, socketId) {
  if (!roomId) return;
  const users = (roomUsers.get(roomId) || []).filter(u => u.socketId !== socketId);
  if (users.length > 0) roomUsers.set(roomId, users);
  else roomUsers.delete(roomId);
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

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', async ({ roomId, userName, userId }) => {
    if (!roomId) return;
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

  // Пользователь сообщает, кто он (после авторизации на клиенте)
  socket.on('presence', ({ username }) => {
    if (!username) return;
    if (socket.data.presenceUsername) removePresence(socket.data.presenceUsername, socket.id);
    socket.data.presenceUsername = String(username);
    addPresence(socket.data.presenceUsername, socket.id);
  });

  // Звонок контакту: пересылаем приглашение всем его вкладкам
  socket.on('call-invite', ({ toUsername, roomSlug, inviteKey, fromName, fromUsername }) => {
    const targets = onlineUsers.get(String(toUsername || ''));
    if (!targets || targets.size === 0) {
      socket.emit('call-unavailable', { toUsername });
      return;
    }
    for (const sid of targets) {
      io.to(sid).emit('incoming-call', { roomSlug, inviteKey, fromName, fromUsername });
    }
  });

  // Отказ от звонка — сообщаем звонившему
  socket.on('call-declined', ({ toUsername, byName }) => {
    const targets = onlineUsers.get(String(toUsername || ''));
    if (!targets) return;
    for (const sid of targets) io.to(sid).emit('call-declined', { byName });
  });

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
    if (!roomId || !socketId) return;
    if (!admittedWaiters.has(roomId)) admittedWaiters.set(roomId, new Set());
    // для гостей вместо id аккаунта приходит их временный guestId
    admittedWaiters.get(roomId).add(String(userId || socketId));
    io.to(socketId).emit('wait-admitted', { roomId });
  });

  socket.on('wait-deny', ({ roomId, socketId }) => {
    if (!socketId) return;
    io.to(socketId).emit('wait-denied', { roomId });
  });

  socket.on('offer', ({ roomId, offer }) => socket.to(roomId).emit('offer', offer));
  socket.on('answer', ({ roomId, answer }) => socket.to(roomId).emit('answer', answer));
  socket.on('ice-candidate', ({ roomId, candidate }) => socket.to(roomId).emit('ice-candidate', candidate));

  socket.on('chat-message', ({ roomId, userName, text, timestamp }) => {
    io.to(roomId).emit('chat-message', { userName, text, timestamp });
  });

  socket.on('sound', ({ roomId, soundId, fromUser, toUser }) => {
    io.to(roomId).emit('sound', { soundId, fromUser, toUser });
  });

  // Индикатор записи — всем в комнате
  socket.on('recording-state', ({ roomId, active, by }) => {
    io.to(roomId).emit('recording-state', { active, by });
  });

  // Эмодзи-реакции — всем в комнате
  socket.on('reaction', ({ roomId, emoji, fromName }) => {
    io.to(roomId).emit('reaction', { emoji, fromName });
  });

  // таймлайн активных говорящих во время записи (для разметки транскрипта по никам)
  socket.on('rec-speaker', ({ roomId, speaker }) => {
    recTimeline.addSpeaker(roomId, speaker, Date.now());
  });

  socket.on('media-state', ({ roomId, mediaState }) => socket.to(roomId).emit('media-state', mediaState));

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
    if (socket.data.presenceUsername) removePresence(socket.data.presenceUsername, socket.id);
    socket.data.roomId = null;
    socket.data.userName = null;
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
app.get('/', (_, res) => res.send('Backend is running'));

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log('Server started on port', PORT));
