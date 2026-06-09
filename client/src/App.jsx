import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Room, RoomEvent, Track } from 'livekit-client';
import './App.css';
import AuthPage from './components/AuthPage';
import { getMe } from './services/auth';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

// --- Grid: cols by participant count ---
function getGridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

// --- Single participant tile ---
function ParticipantTile({ participant, isLocal, isFrontCamera }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [isMicOff, setIsMicOff] = useState(false);
  const [isCamOff, setIsCamOff] = useState(false);

  useEffect(() => {
    if (!participant) return;
    let attached = null;

    const updateState = () => {
      const cameraPub = participant.getTrackPublication(Track.Source.Camera);
      const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
      const micPub = participant.getTrackPublication(Track.Source.Microphone);

      // For local: track exists directly; for remote: need isSubscribed
      const camTrack = cameraPub?.track && (isLocal || cameraPub.isSubscribed) ? cameraPub.track : null;
      const screenTrack = screenPub?.track && (isLocal || screenPub.isSubscribed) ? screenPub.track : null;
      const activeTrack = screenTrack || camTrack;

      const camMuted = cameraPub ? cameraPub.isMuted : true;
      setIsCamOff(camMuted);
      setIsMicOff(micPub?.isMuted ?? false);

      if (activeTrack && !camMuted && videoRef.current) {
        if (attached !== activeTrack) {
          if (attached) attached.detach(videoRef.current);
          activeTrack.attach(videoRef.current);
          attached = activeTrack;
        }
        setHasVideo(true);
      } else {
        if (attached && videoRef.current) {
          attached.detach(videoRef.current);
          attached = null;
        }
        setHasVideo(false);
      }
    };

    // Attach remote audio (local audio muted to avoid echo)
    const attachAudio = () => {
      if (isLocal) return;
      const audioPub = participant.getTrackPublication(Track.Source.Microphone);
      if (audioPub?.track && audioPub.isSubscribed && audioRef.current) {
        audioPub.track.attach(audioRef.current);
      }
    };

    updateState();
    attachAudio();

    const handleAll = () => { updateState(); attachAudio(); };

    participant.on('trackPublished', handleAll);
    participant.on('trackUnpublished', handleAll);
    participant.on('localTrackPublished', handleAll);
    participant.on('localTrackUnpublished', handleAll);
    participant.on('trackSubscribed', handleAll);
    participant.on('trackUnsubscribed', handleAll);
    participant.on('trackMuted', updateState);
    participant.on('trackUnmuted', updateState);

    return () => {
      participant.off('trackPublished', handleAll);
      participant.off('trackUnpublished', handleAll);
      participant.off('localTrackPublished', handleAll);
      participant.off('localTrackUnpublished', handleAll);
      participant.off('trackSubscribed', handleAll);
      participant.off('trackUnsubscribed', handleAll);
      participant.off('trackMuted', updateState);
      participant.off('trackUnmuted', updateState);
      if (attached && videoRef.current) {
        try { attached.detach(videoRef.current); } catch {}
        attached = null;
      }
    };
  }, [participant, isLocal]);

  const mirrorStyle =
    isLocal && isFrontCamera && !isCamOff
      ? { transform: 'scaleX(-1)', WebkitTransform: 'scaleX(-1)' }
      : {};

  return (
    <div className="participant-tile">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        style={{ ...mirrorStyle, display: hasVideo && !isCamOff ? 'block' : 'none' }}
      />
      {/* audio элемент для удалённых участников */}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />}
      {(!hasVideo || isCamOff) && (
        <div className="tile-no-video">
          <div className="tile-avatar">
            {(participant.identity || '?')[0].toUpperCase()}
          </div>
        </div>
      )}
      <div className="tile-footer">
        <span className="tile-name">{participant.identity}</span>
        <span className="tile-icons">
          {isMicOff && <span title="Микрофон выкл">🔇</span>}
          {isCamOff && <span title="Камера выкл">📵</span>}
        </span>
      </div>
    </div>
  );
}

// --- Main App ---
export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState('');

  const [roomId, setRoomId] = useState('room-101');
  const [userName, setUserName] = useState('Иван');

  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState('Готов к подключению');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [copied, setCopied] = useState(false);

  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [callSeconds, setCallSeconds] = useState(0);
  const [callStartedAt, setCallStartedAt] = useState(null);

  const [isAccountPanelOpen, setIsAccountPanelOpen] = useState(false);
  const [accountTab, setAccountTab] = useState('profile');

  const [callHistory] = useState([
    { id: '1', title: 'Тестовый звонок', roomId: 'room-101', duration: '12 мин 34 сек', date: '08.04.2026' },
    { id: '2', title: 'Созвон по проекту', roomId: 'room-205', duration: '5 мин 10 сек', date: '07.04.2026' },
  ]);

  const livekitRoomRef = useRef(null);
  const joiningRef = useRef(false);
  const [renderTick, setRenderTick] = useState(0);
  const forceUpdate = useCallback(() => setRenderTick(t => t + 1), []);

  const roomIdRef = useRef(roomId);
  const chatBodyRef = useRef(null);

  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

  const daysSinceRegistration = useMemo(() => {
    if (!authUser?.createdAt) return null;
    const diffMs = new Date() - new Date(authUser.createdAt);
    return Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  }, [authUser]);

  // Auth
  useEffect(() => {
    async function checkAuth() {
      const token = localStorage.getItem('token');
      if (!token) { setAuthChecked(true); return; }
      try {
        const result = await getMe(token);
        setAuthUser(result.user);
        setUserName(result.user.username || 'Иван');
      } catch {
        localStorage.removeItem('token');
        setAuthUser(null);
        setAuthError('Сессия истекла. Войдите снова.');
      } finally {
        setAuthChecked(true);
      }
    }
    checkAuth();
  }, []);

  // Chat via Socket.IO
  useEffect(() => {
    socket.on('chat-message', (message) => {
      setMessages(prev => [...prev, message]);
    });
    return () => { socket.off('chat-message'); };
  }, []);

  // Chat scroll
  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
    }
  }, [messages]);

  // Timer
  useEffect(() => {
    if (!callStartedAt) return;
    const timer = setInterval(() => {
      setCallSeconds(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [callStartedAt]);

  const formattedCallTime = useMemo(() => {
    const h = Math.floor(callSeconds / 3600);
    const m = Math.floor((callSeconds % 3600) / 60);
    const s = callSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [callSeconds]);

  // Participants derived from LiveKit room
  const allParticipants = useMemo(() => {
    const room = livekitRoomRef.current;
    if (!room || !joined) return [];
    return [room.localParticipant, ...Array.from(room.remoteParticipants.values())];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, renderTick]);

  const joinRoom = async () => {
    if (!roomId.trim() || !userName.trim() || joined || joiningRef.current) return;
    joiningRef.current = true;
    setStatus('Получаем токен...');

    try {
      const authToken = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/rooms/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ roomId: roomId.trim() }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        setStatus(`Ошибка: ${err.message}`);
        return;
      }

      const { token: lkToken, wsUrl } = await resp.json();

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 640, height: 360, frameRate: 15 },
        },
        publishDefaults: {
          simulcast: false,
          videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
          videoSimulcastLayers: [],
        },
      });
      livekitRoomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        joiningRef.current = false;
        setJoined(true);
        setCallStartedAt(Date.now());
        setStatus('Подключено');
        // Разблокировать аудио (браузеры блокируют autoplay)
        room.startAudio().catch(() => {});
        forceUpdate();
      });

      room.on(RoomEvent.Disconnected, () => {
        joiningRef.current = false;
        setJoined(false);
        setCallStartedAt(null);
        setCallSeconds(0);
        livekitRoomRef.current = null;
        setStatus('Отключено');
        forceUpdate();
      });

      room.on(RoomEvent.ParticipantConnected, (p) => {
        setStatus(`${p.identity} подключился`);
        forceUpdate();
      });

      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        setStatus(`${p.identity} отключился`);
        forceUpdate();
      });

      room.on(RoomEvent.TrackSubscribed, forceUpdate);
      room.on(RoomEvent.TrackUnsubscribed, forceUpdate);
      room.on(RoomEvent.LocalTrackPublished, forceUpdate);
      room.on(RoomEvent.LocalTrackUnpublished, forceUpdate);
      room.on(RoomEvent.TrackMuted, forceUpdate);
      room.on(RoomEvent.TrackUnmuted, forceUpdate);

      setStatus('Подключаемся...');
      await room.connect(wsUrl, lkToken);

      setStatus('Включаем камеру...');
      try {
        await room.localParticipant.enableCameraAndMicrophone();
      } catch (camErr) {
        console.warn('Camera/mic error:', camErr);
        // Попробуем хотя бы микрофон
        try { await room.localParticipant.setMicrophoneEnabled(true); } catch {}
        setStatus('Камера недоступна — только микрофон');
      }
      forceUpdate();

      socket.emit('join-room', { roomId: roomId.trim(), userName: userName.trim() });

    } catch (error) {
      console.error('joinRoom error:', error);
      setStatus(`Ошибка: ${error.message}`);
      livekitRoomRef.current = null;
      joiningRef.current = false;
    }
  };

  const leaveCall = async () => {
    joiningRef.current = false;
    const room = livekitRoomRef.current;
    livekitRoomRef.current = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect();
    }
    socket.emit('leave-room', roomIdRef.current);
    setJoined(false);
    setIsMuted(false);
    setIsCameraOff(false);
    setIsSharingScreen(false);
    setStatus('Вы вышли из комнаты');
    setCallStartedAt(null);
    setCallSeconds(0);
    setMessages([]);
    setIsFrontCamera(true);
    forceUpdate();
  };

  const toggleMute = async () => {
    const room = livekitRoomRef.current;
    if (!room || !joined) return;
    const next = !isMuted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setIsMuted(next);
    setStatus(next ? 'Микрофон выключен' : 'Микрофон включён');
    forceUpdate();
  };

  const toggleCamera = async () => {
    const room = livekitRoomRef.current;
    if (!room || !joined) return;
    const next = !isCameraOff;
    await room.localParticipant.setCameraEnabled(!next);
    setIsCameraOff(next);
    setStatus(next ? 'Камера выключена' : 'Камера включена');
    forceUpdate();
  };

  const switchCamera = async () => {
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (!isMobile) { setStatus('Переключение камеры доступно только на мобильных'); return; }
    if (isSharingScreen) { setStatus('Сначала остановите демонстрацию экрана'); return; }

    try {
      const room = livekitRoomRef.current;
      if (!room) return;
      const nextFront = !isFrontCamera;
      setIsFrontCamera(nextFront);
      await room.localParticipant.setCameraEnabled(false);
      await room.localParticipant.setCameraEnabled(true, {
        facingMode: nextFront ? 'user' : 'environment',
      });
      setStatus(nextFront ? 'Фронтальная камера' : 'Основная камера');
      forceUpdate();
    } catch (error) {
      console.error('switchCamera error:', error);
      setStatus('Не удалось переключить камеру');
    }
  };

  const startScreenShare = async () => {
    const room = livekitRoomRef.current;
    if (!room || !joined) return;

    if (isSharingScreen) {
      await room.localParticipant.setScreenShareEnabled(false);
      setIsSharingScreen(false);
      setStatus('Демонстрация экрана выключена');
    } else {
      try {
        await room.localParticipant.setScreenShareEnabled(true);
        setIsSharingScreen(true);
        setStatus('Демонстрация экрана включена');
      } catch {
        setStatus('Не удалось начать демонстрацию экрана');
      }
    }
    forceUpdate();
  };

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
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
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    setMessageText('');
  };

  const handleMessageKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  };

  const gridCols = getGridCols(Math.max(allParticipants.length, 1));

  if (!authChecked) return <div className="auth-page">Проверяем авторизацию...</div>;

  if (!authUser) {
    return (
      <AuthPage
        onLoginSuccess={(user) => {
          setAuthUser(user);
          setUserName(user.username || 'Иван');
          setAuthError('');
        }}
        authError={authError}
      />
    );
  }

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
          <button className="ghost-btn account-toggle-btn" onClick={() => setIsAccountPanelOpen(p => !p)}>
            ☰ Аккаунт
          </button>
          <button className="ghost-btn" onClick={() => {
            localStorage.removeItem('token');
            setAuthUser(null);
            if (joined) leaveCall();
            setStatus('Вы вышли из аккаунта');
          }}>
            Выйти
          </button>
        </div>
      </div>

      {isAccountPanelOpen && (
        <aside className="account-panel">
          <div className="account-panel-header">
            <div>
              <div className="brand">voyage account</div>
              <div className="subtitle">Профиль и история активности</div>
            </div>
            <button className="ghost-btn" onClick={() => setIsAccountPanelOpen(false)}>Закрыть</button>
          </div>
          <div className="account-tabs">
            <button className={accountTab === 'profile' ? 'primary-btn' : 'ghost-btn'} onClick={() => setAccountTab('profile')}>Профиль</button>
            <button className={accountTab === 'calls' ? 'primary-btn' : 'ghost-btn'} onClick={() => setAccountTab('calls')}>История звонков</button>
            <button className={accountTab === 'details' ? 'primary-btn' : 'ghost-btn'} onClick={() => setAccountTab('details')}>Ещё</button>
          </div>

          {accountTab === 'profile' && (
            <div className="account-section">
              <div className="account-info-card">
                <div className="account-info-row"><span>Никнейм</span><strong>{authUser?.username || '—'}</strong></div>
                <div className="account-info-row"><span>ID аккаунта</span><strong>{authUser?.id || '—'}</strong></div>
                <div className="account-info-row"><span>Дата регистрации</span><strong>{authUser?.createdAt ? new Date(authUser.createdAt).toLocaleDateString('ru-RU') : 'Пока недоступно'}</strong></div>
                <div className="account-info-row"><span>С Voyage</span><strong>{daysSinceRegistration ? `${daysSinceRegistration} дн.` : 'Пока недоступно'}</strong></div>
              </div>
            </div>
          )}
          {accountTab === 'calls' && (
            <div className="account-section">
              <div className="calls-history-list">
                {callHistory.length === 0 ? (
                  <div className="participants-empty">История звонков пока пуста</div>
                ) : callHistory.map(call => (
                  <div className="call-history-card" key={call.id}>
                    <div className="call-history-title">{call.title}</div>
                    <div className="call-history-meta">Комната: {call.roomId}</div>
                    <div className="call-history-meta">Длительность: {call.duration}</div>
                    <div className="call-history-meta">Дата: {call.date}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {accountTab === 'details' && (
            <div className="account-section">
              <div className="account-info-card">
                <div className="account-info-row"><span>Статус</span><strong>Активный пользователь</strong></div>
                <div className="account-info-row"><span>Продукт</span><strong>VoyageCommunications</strong></div>
                <div className="account-info-row"><span>Текущий этап</span><strong>MVP / LiveKit SFU</strong></div>
              </div>
            </div>
          )}
        </aside>
      )}

      <div className="setup-card">
        <div className="field-group">
          <label>Ваше имя</label>
          <input
            value={userName}
            onChange={e => setUserName(e.target.value)}
            placeholder="Введите имя"
            disabled={joined}
          />
        </div>

        <div className="participants-card">
          <div className="participants-header">
            <span>Участники комнаты</span>
            <span>{allParticipants.length}</span>
          </div>
          <div className="participants-list">
            {allParticipants.length === 0 ? (
              <div className="participants-empty">Пока никого нет</div>
            ) : allParticipants.map(p => (
              <div className="participant-item" key={p.identity}>
                <span className="participant-name">{p.identity}</span>
                <span className="participant-badge">
                  {p === livekitRoomRef.current?.localParticipant ? 'Вы' : 'В комнате'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="field-group">
          <label>ID комнаты</label>
          <input
            value={roomId}
            onChange={e => setRoomId(e.target.value)}
            placeholder="Введите ID комнаты"
            disabled={joined}
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
          <div className="video-stage">
            {allParticipants.length === 0 ? (
              <div className="video-empty">
                <div className="video-empty-text">
                  {joined ? 'Ожидаем участников...' : 'Войдите в комнату для начала звонка'}
                </div>
              </div>
            ) : (
              <div
                className="video-grid"
                style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
              >
                {allParticipants.map(p => (
                  <ParticipantTile
                    key={p.identity}
                    participant={p}
                    isLocal={p === livekitRoomRef.current?.localParticipant}
                    isFrontCamera={isFrontCamera}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="controls-bar">
            <button className={`control-btn ${isMuted ? 'danger' : ''}`} onClick={toggleMute} disabled={!joined}>
              {isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
            </button>
            <button className={`control-btn ${isCameraOff ? 'danger' : ''}`} onClick={toggleCamera} disabled={!joined}>
              {isCameraOff ? 'Включить камеру' : 'Выключить камеру'}
            </button>
            <button className="control-btn" onClick={switchCamera} disabled={!joined || isSharingScreen}>
              {isFrontCamera ? 'Задняя камера' : 'Фронтальная камера'}
            </button>
            <button className={`control-btn ${isSharingScreen ? 'active' : ''}`} onClick={startScreenShare} disabled={!joined}>
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
              <div className="chat-empty">Сообщений пока нет. Напишите первое сообщение.</div>
            ) : messages.map((msg, i) => {
              const isOwn = msg.userName === userName;
              return (
                <div key={`${msg.timestamp}-${i}`} className={`message-item ${isOwn ? 'own' : ''}`}>
                  <div className="message-meta"><span>{msg.userName}</span><span>{msg.timestamp}</span></div>
                  <div className="message-bubble">{msg.text}</div>
                </div>
              );
            })}
          </div>
          <div className="chat-input-row">
            <input
              className="chat-input"
              value={messageText}
              onChange={e => setMessageText(e.target.value)}
              onKeyDown={handleMessageKeyDown}
              placeholder="Введите сообщение"
              disabled={!joined}
            />
            <button className="send-btn" onClick={sendMessage} disabled={!joined}>Отправить</button>
          </div>
        </aside>
      </div>
    </div>
  );
}
