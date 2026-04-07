require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const authRoutes = require('./src/routes/auth.routes');

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  })
);

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
});

const roomUsers = new Map();

function emitRoomUsers(roomId) {
  if (!roomId) return;

  const users = roomUsers.get(roomId) || [];

  io.to(roomId).emit('room-users', users.map((user) => ({
    socketId: user.socketId,
    userName: user.userName,
  })));
}

function removeUserFromRoom(roomId, socketId) {
  if (!roomId) return;

  const users = roomUsers.get(roomId) || [];
  const filteredUsers = users.filter((user) => user.socketId !== socketId);

  if (filteredUsers.length > 0) {
    roomUsers.set(roomId, filteredUsers);
  } else {
    roomUsers.delete(roomId);
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userName }) => {
    if (!roomId) return;

    // На всякий случай очищаем старое состояние этого сокета
    if (socket.data.roomId) {
      removeUserFromRoom(socket.data.roomId, socket.id);
      socket.leave(socket.data.roomId);
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const roomSize = room ? room.size : 0;

    if (roomSize >= 2) {
      socket.emit('room-full');
      return;
    }

    socket.data.roomId = roomId;
    socket.data.userName = userName || 'Участник';

    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, []);
    }

    // Удаляем возможный дубль этого же socket.id перед push
    removeUserFromRoom(roomId, socket.id);

    const users = roomUsers.get(roomId) || [];
    users.push({
      socketId: socket.id,
      userName: socket.data.userName,
    });
    roomUsers.set(roomId, users);

    socket.join(roomId);

    const updatedUsers = roomUsers.get(roomId) || [];
    emitRoomUsers(roomId);

    console.log('join-room:', {
      roomId,
      roomSizeAfterJoin: io.sockets.adapter.rooms.get(roomId)?.size || 0,
      roomUsersLength: updatedUsers.length,
      users: updatedUsers,
    });

    if (updatedUsers.length === 1) {
      socket.emit('room-created', {
        yourName: socket.data.userName,
      });
    } else if (updatedUsers.length === 2) {
      const [firstUser, secondUser] = updatedUsers;

      io.to(secondUser.socketId).emit('room-joined', {
        yourName: secondUser.userName,
        remoteUserName: firstUser.userName || 'Собеседник',
      });

      io.to(firstUser.socketId).emit('participant-joined', {
        remoteUserName: secondUser.userName,
      });

      io.to(firstUser.socketId).emit('init', {
        isInitiator: true,
      });

      io.to(secondUser.socketId).emit('init', {
        isInitiator: false,
      });
    } else {
      console.warn('Unexpected roomUsers length:', roomId, updatedUsers.length, updatedUsers);
    }
  });

  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', offer);
  });

  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', answer);
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', candidate);
  });

  socket.on('chat-message', ({ roomId, userName, text, timestamp }) => {
    io.to(roomId).emit('chat-message', {
      userName,
      text,
      timestamp,
    });
  });

  socket.on('media-state', ({ roomId, mediaState }) => {
    socket.to(roomId).emit('media-state', mediaState);
  });

  socket.on('leave-room', (roomId) => {
    const actualRoomId = roomId || socket.data.roomId;

    removeUserFromRoom(actualRoomId, socket.id);
    socket.leave(actualRoomId);

    socket.to(actualRoomId).emit('user-disconnected');
    emitRoomUsers(actualRoomId);

    socket.data.roomId = null;
    socket.data.userName = null;

    console.log('leave-room:', {
      socketId: socket.id,
      roomId: actualRoomId,
      roomUsers: roomUsers.get(actualRoomId) || [],
      roomSizeAfterLeave: io.sockets.adapter.rooms.get(actualRoomId)?.size || 0,
    });
  });

  socket.on('disconnecting', () => {
    const roomId = socket.data.roomId;

    if (roomId) {
      removeUserFromRoom(roomId, socket.id);
      socket.to(roomId).emit('user-disconnected');
      emitRoomUsers(roomId);

      console.log('disconnecting:', {
        socketId: socket.id,
        roomId,
        roomUsers: roomUsers.get(roomId) || [],
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    socket.data.roomId = null;
    socket.data.userName = null;
  });
});

app.use('/auth', authRoutes);

app.get('/', (_, res) => {
  res.send('Backend is running');
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});