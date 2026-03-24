const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);

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
  res.send('Backend is running');
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});