import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const socket = io('https://172.20.10.10:3001', {
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  console.log('Socket connected in browser:', socket.id);
});

socket.on('connect_error', (error) => {
  console.error('Socket connect error:', error);
});

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export default function App() {
  const [roomId, setRoomId] = useState('room-101');
  const [userName, setUserName] = useState('Иван');
  const [remoteUserName, setRemoteUserName] = useState('Собеседник');

  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState('Готов к подключению');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [callSeconds, setCallSeconds] = useState(0);
  const [callStartedAt, setCallStartedAt] = useState(null);

  const roomIdRef = useRef(roomId);
  const chatBodyRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const peerRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    socket.on('room-created', () => {
      setStatus('Комната создана. Ожидаем второго участника');
      setRemoteUserName('Собеседник');
    });

    socket.on('room-joined', ({ remoteUserName }) => {
      setStatus('Вы вошли в комнату');
      setRemoteUserName(remoteUserName || 'Собеседник');
    });

    socket.on('participant-joined', ({ remoteUserName }) => {
      setRemoteUserName(remoteUserName || 'Собеседник');
      setStatus(`${remoteUserName || 'Собеседник'} подключился`);
    });

    socket.on('ready', async () => {
      setStatus('Второй участник подключился. Создаём соединение...');
      await createOffer();
    });

    socket.on('offer', async (offer) => {
      setStatus('Получен запрос на соединение');
      await handleOffer(offer);
    });

    socket.on('answer', async (answer) => {
      setStatus('Соединение подтверждено');
      if (peerRef.current) {
        await peerRef.current.setRemoteDescription(answer);
      }
    });

    socket.on('ice-candidate', async (candidate) => {
      try {
        if (peerRef.current && candidate) {
          await peerRef.current.addIceCandidate(candidate);
        }
      } catch (error) {
        console.error('Ошибка ICE candidate:', error);
      }
    });

    socket.on('chat-message', (message) => {
      setMessages((prev) => [...prev, message]);
    });

    socket.on('room-full', () => {
      setJoined(false);
      setStatus('Комната уже занята');
    });

    socket.on('user-disconnected', () => {
      setStatus('Собеседник отключился');
      setRemoteUserName('Собеседник');
      setCallStartedAt(null);
      setCallSeconds(0);

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }

      closePeerConnection();
    });

    return () => {
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('participant-joined');
      socket.off('ready');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('chat-message');
      socket.off('room-full');
      socket.off('user-disconnected');

      stopAllMedia();
      closePeerConnection();
    };
  }, []);

  useEffect(() => {
    if (!callStartedAt) return;

    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - callStartedAt) / 1000);
      setCallSeconds(diff);
    }, 1000);

    return () => clearInterval(timer);
  }, [callStartedAt]);

  useEffect(() => {
    if (!chatBodyRef.current) return;
    chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
  }, [messages]);

  const formattedCallTime = useMemo(() => {
    const hours = Math.floor(callSeconds / 3600);
    const minutes = Math.floor((callSeconds % 3600) / 60);
    const seconds = callSeconds % 60;

    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    return `${hh}:${mm}:${ss}`;
  }, [callSeconds]);

  const getCurrentVideoTrack = () => {
    if (screenStreamRef.current) {
      return screenStreamRef.current.getVideoTracks()[0] || null;
    }

    if (cameraStreamRef.current) {
      return cameraStreamRef.current.getVideoTracks()[0] || null;
    }

    return null;
  };

  const updateLocalPreview = () => {
    if (!localVideoRef.current) return;

    if (screenStreamRef.current) {
      localVideoRef.current.srcObject = screenStreamRef.current;
    } else if (cameraStreamRef.current) {
      localVideoRef.current.srcObject = cameraStreamRef.current;
    } else {
      localVideoRef.current.srcObject = null;
    }
  };

  const startCameraMedia = async () => {
    if (cameraStreamRef.current) return cameraStreamRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      cameraStreamRef.current = stream;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });

      stream.getVideoTracks().forEach((track) => {
        track.enabled = !isCameraOff;
      });

      updateLocalPreview();
      return stream;
    } catch (error) {
      console.error(error);
      setStatus('Не удалось получить доступ к камере или микрофону');
      throw error;
    }
  };

  const createPeerConnection = async () => {
    if (peerRef.current) return peerRef.current;

    await startCameraMedia();

    const peer = new RTCPeerConnection(rtcConfig);

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          roomId: roomIdRef.current,
          candidate: event.candidate,
        });
      }
    };

    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }

      setStatus('Звонок активен');
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;

      if (state === 'connected') {
        setStatus('Соединение установлено');
        if (!callStartedAt) {
          setCallStartedAt(Date.now());
        }
      } else if (state === 'connecting') {
        setStatus('Подключение...');
      } else if (state === 'disconnected') {
        setStatus('Соединение потеряно');
      } else if (state === 'failed') {
        setStatus('Ошибка соединения');
      } else if (state === 'closed') {
        setStatus('Соединение закрыто');
      }
    };

    const audioTracks = cameraStreamRef.current.getAudioTracks();
    const videoTrack = getCurrentVideoTrack();

    audioTracks.forEach((track) => {
      peer.addTrack(track, cameraStreamRef.current);
    });

    if (videoTrack) {
      const videoSourceStream = screenStreamRef.current || cameraStreamRef.current;
      peer.addTrack(videoTrack, videoSourceStream);
    }

    peerRef.current = peer;
    return peer;
  };

  const createOffer = async () => {
    const peer = await createPeerConnection();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    socket.emit('offer', {
      roomId: roomIdRef.current,
      offer,
    });
  };

  const handleOffer = async (offer) => {
    const peer = await createPeerConnection();
    await peer.setRemoteDescription(offer);

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    socket.emit('answer', {
      roomId: roomIdRef.current,
      answer,
    });
  };

  const joinRoom = async () => {
    if (!roomId.trim()) {
      setStatus('Введите ID комнаты');
      return;
    }

    if (!userName.trim()) {
      setStatus('Введите имя');
      return;
    }

    if (joined) return;

    await startCameraMedia();

    socket.emit('join-room', {
      roomId: roomId.trim(),
      userName: userName.trim(),
    });

    setJoined(true);
    setStatus('Подключаемся к комнате...');
  };

  const replaceOutgoingVideoTrack = async (newTrack) => {
    if (!peerRef.current) return;

    const sender = peerRef.current
      .getSenders()
      .find((s) => s.track && s.track.kind === 'video');

    if (sender) {
      await sender.replaceTrack(newTrack);
    }
  };

  const toggleMute = () => {
    if (!cameraStreamRef.current) return;

    const nextMuted = !isMuted;

    cameraStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });

    setIsMuted(nextMuted);
    setStatus(nextMuted ? 'Микрофон выключен' : 'Микрофон включён');
  };

  const toggleCamera = () => {
    const currentVideoTrack = getCurrentVideoTrack();
    if (!currentVideoTrack) return;

    const nextCameraOff = !isCameraOff;
    currentVideoTrack.enabled = !nextCameraOff;

    setIsCameraOff(nextCameraOff);
    setStatus(nextCameraOff ? 'Видео выключено' : 'Видео включено');
  };

  const startScreenShare = async () => {
    if (isSharingScreen) {
      await stopScreenShare();
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;

      screenTrack.enabled = !isCameraOff;

      screenTrack.onended = async () => {
        await stopScreenShare();
      };

      screenStreamRef.current = displayStream;
      updateLocalPreview();
      await replaceOutgoingVideoTrack(screenTrack);

      setIsSharingScreen(true);
      setStatus('Демонстрация экрана включена');
    } catch (error) {
      console.error(error);
      setStatus('Не удалось начать демонстрацию экрана');
    }
  };

  const stopScreenShare = async () => {
    if (!screenStreamRef.current) return;

    screenStreamRef.current.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;

    const cameraTrack = cameraStreamRef.current?.getVideoTracks()[0];

    if (cameraTrack) {
      cameraTrack.enabled = !isCameraOff;
      await replaceOutgoingVideoTrack(cameraTrack);
    }

    updateLocalPreview();
    setIsSharingScreen(false);
    setStatus('Демонстрация экрана выключена');
  };

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setStatus('ID комнаты скопирован');

      setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch (error) {
      console.error(error);
      setStatus('Не удалось скопировать ID комнаты');
    }
  };

  const sendMessage = () => {
    const text = messageText.trim();
    if (!text || !joined) return;

    socket.emit('chat-message', {
      roomId: roomIdRef.current,
      userName: userName.trim() || 'Участник',
      text,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    });

    setMessageText('');
  };

  const handleMessageKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendMessage();
    }
  };

  const closePeerConnection = () => {
    if (peerRef.current) {
      peerRef.current.ontrack = null;
      peerRef.current.onicecandidate = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }
  };

  const stopAllMedia = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const leaveCall = async () => {
    if (isSharingScreen) {
      await stopScreenShare();
    }

    socket.emit('leave-room', roomIdRef.current);

    closePeerConnection();
    stopAllMedia();

    setJoined(false);
    setIsMuted(false);
    setIsCameraOff(false);
    setIsSharingScreen(false);
    setRemoteUserName('Собеседник');
    setStatus('Вы вышли из комнаты');
    setCallStartedAt(null);
    setCallSeconds(0);
    setMessages([]);
  };

  return (
    <div className="app-shell">
      <div className="topbar">
        <div>
          <div className="brand">VoyageCommunications</div>
          <div className="subtitle">blockchainconcept corporations</div>
        </div>

        <div className="topbar-right">
          <div className="timer-badge">Время звонка: {formattedCallTime}</div>
          <div className="status-badge">{status}</div>
        </div>
      </div>

      <div className="setup-card">
        <div className="field-group">
          <label>Ваше имя</label>
          <input
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="Введите имя"
          />
        </div>

        <div className="field-group">
          <label>ID комнаты</label>
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Введите ID комнаты"
          />
        </div>

        <div className="setup-actions">
          <button className="primary-btn" onClick={joinRoom} disabled={joined}>
            {joined ? 'Вы в комнате' : 'Войти в комнату'}
          </button>

          <button className="ghost-btn" onClick={copyRoomId}>
            {copied ? 'Скопировано' : 'Копировать ID'}
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div className="call-section">
          <div className="video-layout">
            <div className="video-panel remote-panel">
              <div className="video-header">
                <span>{remoteUserName}</span>
                <span className="dot" />
              </div>
              <video ref={remoteVideoRef} autoPlay playsInline />
            </div>

            <div className="video-panel local-panel">
              <div className="video-header">
                <span>{userName || 'Вы'}</span>
                <span className="self-tag">Вы</span>
              </div>
              <video ref={localVideoRef} autoPlay playsInline muted />
            </div>
          </div>

          <div className="controls-bar">
            <button
              className={`control-btn ${isMuted ? 'danger' : ''}`}
              onClick={toggleMute}
              disabled={!joined}
            >
              {isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
            </button>

            <button
              className={`control-btn ${isCameraOff ? 'danger' : ''}`}
              onClick={toggleCamera}
              disabled={!joined}
            >
              {isCameraOff ? 'Включить камеру' : 'Выключить камеру'}
            </button>

            <button
              className={`control-btn ${isSharingScreen ? 'active' : ''}`}
              onClick={startScreenShare}
              disabled={!joined}
            >
              {isSharingScreen ? 'Остановить экран' : 'Демонстрация экрана'}
            </button>

            <button className="control-btn danger" onClick={leaveCall} disabled={!joined}>
              Завершить звонок
            </button>
          </div>
        </div>

        <aside className="chat-panel">
          <div className="chat-header">
            <div className="chat-title">Чат комнаты</div>
            <div className="chat-room">{roomId}</div>
          </div>

          <div className="chat-body" ref={chatBodyRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                Сообщений пока нет. Напишите первое сообщение.
              </div>
            ) : (
              messages.map((message, index) => {
                const isOwn = message.userName === userName;

                return (
                  <div
                    key={`${message.timestamp}-${index}`}
                    className={`message-item ${isOwn ? 'own' : ''}`}
                  >
                    <div className="message-meta">
                      <span>{message.userName}</span>
                      <span>{message.timestamp}</span>
                    </div>
                    <div className="message-bubble">{message.text}</div>
                  </div>
                );
              })
            )}
          </div>

          <div className="chat-input-row">
            <input
              className="chat-input"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              onKeyDown={handleMessageKeyDown}
              placeholder="Введите сообщение"
              disabled={!joined}
            />
            <button className="send-btn" onClick={sendMessage} disabled={!joined}>
              Отправить
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}