const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const httpsOptions = {
  key: fs.readFileSync(
    path.resolve(__dirname, '../client/cert/localhost+3-key.pem')
  ),
  cert: fs.readFileSync(
    path.resolve(__dirname, '../client/cert/localhost+3.pem')
  ),
};

const server = https.createServer(httpsOptions, app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
});

const roomUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userName }) => {
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

    const users = roomUsers.get(roomId);
    users.push({
      socketId: socket.id,
      userName: socket.data.userName,
    });

    socket.join(roomId);

    const updatedUsers = roomUsers.get(roomId) || [];

    if (updatedUsers.length === 1) {
      socket.emit('room-created', {
        yourName: socket.data.userName,
      });
    } else if (updatedUsers.length === 2) {
      const otherUser = updatedUsers.find((user) => user.socketId !== socket.id);

      socket.emit('room-joined', {
        yourName: socket.data.userName,
        remoteUserName: otherUser?.userName || 'Собеседник',
      });

      socket.to(roomId).emit('participant-joined', {
        remoteUserName: socket.data.userName,
      });

      socket.to(roomId).emit('ready');
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

  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);

    const users = roomUsers.get(roomId) || [];
    const filteredUsers = users.filter((user) => user.socketId !== socket.id);

    if (filteredUsers.length > 0) {
      roomUsers.set(roomId, filteredUsers);
    } else {
      roomUsers.delete(roomId);
    }

    socket.to(roomId).emit('user-disconnected');
  });

  socket.on('disconnecting', () => {
    const roomId = socket.data.roomId;

    if (roomId) {
      const users = roomUsers.get(roomId) || [];
      const filteredUsers = users.filter((user) => user.socketId !== socket.id);

      if (filteredUsers.length > 0) {
        roomUsers.set(roomId, filteredUsers);
      } else {
        roomUsers.delete(roomId);
      }

      socket.to(roomId).emit('user-disconnected');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

app.get('/', (_, res) => {
  res.send('Secure signaling server is running');
});

server.listen(3001, '0.0.0.0', () => {
  console.log('HTTPS signaling server started on https://0.0.0.0:3001');
});