import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';

import AuthPage from './components/AuthPage';
import { getMe } from './services/auth';

const socket = io(import.meta.env.VITE_SERVER_URL, {
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  console.log('Socket connected in browser:', socket.id);
});

socket.on('connect_error', (error) => {
  console.error('Socket connect error:', error);
});

const iceServers = [
  {
    urls: 'stun:stun.relay.metered.ca:80',
  },
];

if (
  import.meta.env.VITE_TURN_USERNAME &&
  import.meta.env.VITE_TURN_CREDENTIAL
) {
  iceServers.push(
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    }
  );
}

console.log('TURN USERNAME:', import.meta.env.VITE_TURN_USERNAME);
console.log(
  'TURN CREDENTIAL EXISTS:',
  Boolean(import.meta.env.VITE_TURN_CREDENTIAL)
);

const rtcConfig = {
  iceServers,
};

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState('');

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

  const [participants, setParticipants] = useState([]);

  const [localVideoShape, setLocalVideoShape] = useState('landscape');
  const [remoteVideoShape, setRemoteVideoShape] = useState('landscape');

  const [remoteMediaState, setRemoteMediaState] = useState({
    cameraOff: false,
    micOff: false,
  });

  const roomIdRef = useRef(roomId);
  const chatBodyRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const peerRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  const pendingIceCandidatesRef = useRef([]);
  const remoteDescriptionSetRef = useRef(false);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    async function checkAuth() {
      const token = localStorage.getItem('token');

      if (!token) {
        setAuthChecked(true);
        return;
      }

      try {
        const result = await getMe(token);
        setAuthUser(result.user);
        setUserName(result.user.username || 'Иван');
        setAuthError('');
      } catch (error) {
        localStorage.removeItem('token');
        setAuthUser(null);
        setAuthError('Сессия истекла. Войдите снова.');
      } finally {
        setAuthChecked(true);
      }
    }

    checkAuth();
  }, []);

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

    socket.on('room-users', (users) => {
      setParticipants(Array.isArray(users) ? users : []);
    });

    socket.on('init', async ({ isInitiator }) => {
      if (isInitiator) {
        setStatus('Вы инициатор, создаём offer...');
      await createOffer();
      } else {
            setStatus('Ожидаем offer...');
      }
    });

    socket.on('offer', async (offer) => {
      try {
        console.log('Получен offer');
        setStatus('Получен запрос на соединение');
        await handleOffer(offer);
      } catch (error) {
        console.error('Ошибка обработки offer:', error);
        setStatus('Ошибка при обработке offer');
      }
    });

    socket.on('answer', async (answer) => {
      try {
        console.log('Получен answer');
        setStatus('Соединение подтверждено');

        if (peerRef.current) {
          await peerRef.current.setRemoteDescription(answer);
          remoteDescriptionSetRef.current = true;
          await flushPendingIceCandidates();
        }
      } catch (error) {
        console.error('Ошибка обработки answer:', error);
        setStatus('Ошибка при обработке answer');
      }
    });

    socket.on('media-state', (mediaState) => {
      setRemoteMediaState({
        cameraOff: Boolean(mediaState?.cameraOff),
        micOff: Boolean(mediaState?.micOff),
      });
    });

    socket.on('ice-candidate', async (candidate) => {
      try {
        if (!candidate) return;

        console.log('Получен ICE candidate:', candidate.type);

        if (!peerRef.current) {
          console.log('Peer ещё не создан, кладём ICE candidate в очередь');
          pendingIceCandidatesRef.current.push(candidate);
          return;
        }

        if (!remoteDescriptionSetRef.current) {
          console.log('Remote description ещё не установлено, кладём ICE candidate в очередь');
          pendingIceCandidatesRef.current.push(candidate);
          return;
        }

        await peerRef.current.addIceCandidate(candidate);
        console.log('ICE candidate успешно добавлен');
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
      setParticipants([]);
    });

    socket.on('user-disconnected', () => {
      setStatus('Собеседник отключился');
      setRemoteUserName('Собеседник');
      setCallStartedAt(null);
      setCallSeconds(0);
      setParticipants((prev) => prev.slice(0, 1));

      setRemoteMediaState({
        cameraOff: false,
        micOff: false,
      });

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }

      closePeerConnection();
    });

    return () => {
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('participant-joined');
      socket.off('room-users');
      socket.off('init');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('chat-message');
      socket.off('room-full');
      socket.off('user-disconnected');
      socket.off('media-state');

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

  useEffect(() => {
    const localVideo = localVideoRef.current;
    const remoteVideo = remoteVideoRef.current;

    const updateLocalShape = () => {
      setLocalVideoShape(detectVideoShape(localVideo));
    };

    const updateRemoteShape = () => {
      setRemoteVideoShape(detectVideoShape(remoteVideo));
    };

    if (localVideo) {
      localVideo.addEventListener('loadedmetadata', updateLocalShape);
      localVideo.addEventListener('resize', updateLocalShape);
    }

    if (remoteVideo) {
      remoteVideo.addEventListener('loadedmetadata', updateRemoteShape);
      remoteVideo.addEventListener('resize', updateRemoteShape);
    }

    return () => {
      if (localVideo) {
        localVideo.removeEventListener('loadedmetadata', updateLocalShape);
        localVideo.removeEventListener('resize', updateLocalShape);
      }

      if (remoteVideo) {
        remoteVideo.removeEventListener('loadedmetadata', updateRemoteShape);
        remoteVideo.removeEventListener('resize', updateRemoteShape);
      }
    };
  }, []);

  useEffect(() => {
    if (!joined) return;
    emitMediaState();
  }, [joined, isMuted, isCameraOff]);

  const formattedCallTime = useMemo(() => {
    const hours = Math.floor(callSeconds / 3600);
    const minutes = Math.floor((callSeconds % 3600) / 60);
    const seconds = callSeconds % 60;

    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    return `${hh}:${mm}:${ss}`;
  }, [callSeconds]);

  const detectVideoShape = (videoElement) => {
    if (!videoElement) return 'landscape';

    const { videoWidth, videoHeight } = videoElement;

    if (!videoWidth || !videoHeight) {
      return 'landscape';
    }

    return videoHeight > videoWidth ? 'portrait' : 'landscape';
  };

  const getMediaStatusText = ({ cameraOff, micOff, cameraMissing = false }) => {
    if (cameraMissing && micOff) return 'Камера недоступна, микрофон выключен';
    if (cameraMissing) return 'Камера недоступна';

    if (cameraOff && micOff) return 'Пользователь отключил камеру и микрофон';
    if (cameraOff) return 'Пользователь отключил камеру';
    if (micOff) return 'Пользователь отключил микрофон';

    return '';
  };

  const emitMediaState = (overrides = {}) => {
    if (!joined || !roomIdRef.current) return;

    socket.emit('media-state', {
      roomId: roomIdRef.current,
      mediaState: {
        cameraOff: overrides.cameraOff ?? isCameraOff,
        micOff: overrides.micOff ?? isMuted,
      },
    });
  };

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

  const getMediaErrorMessage = (error) => {
    const name = error?.name || 'UnknownError';

    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Доступ к камере/микрофону запрещён в браузере';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Камера или микрофон не найдены на устройстве';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Камера или микрофон заняты другим приложением';
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return 'Текущие параметры камеры не поддерживаются устройством';
      case 'AbortError':
        return 'Браузер прервал доступ к камере/микрофону';
      case 'SecurityError':
        return 'Браузер заблокировал доступ по соображениям безопасности';
      default:
        return `Не удалось получить доступ к камере/микрофону (${name})`;
    }
  };

  const attachStreamToVideo = async (videoElement, stream, muted = false) => {
    if (!videoElement) return;

    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = muted;

    try {
      await videoElement.play();
    } catch (playError) {
      console.warn('video.play() не выполнился сразу:', playError);
    }
  };

  const startCameraMedia = async () => {
    if (cameraStreamRef.current) {
      return cameraStreamRef.current;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Этот браузер не поддерживает доступ к камере через MediaDevices API');
      return null;
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    const preferredConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        facingMode: isMobile ? { ideal: 'user' } : 'user',
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
    };

    const relaxedConstraints = {
      audio: true,
      video: true,
    };

    const audioOnlyConstraints = {
      audio: true,
      video: false,
    };

    try {
      let stream;

      try {
        stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
      } catch (firstError) {
        console.warn('preferredConstraints не сработали, пробуем relaxedConstraints', firstError);
        stream = await navigator.mediaDevices.getUserMedia(relaxedConstraints);
      }

      cameraStreamRef.current = stream;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });

      stream.getVideoTracks().forEach((track) => {
        track.enabled = !isCameraOff;
      });

      if (localVideoRef.current) {
        await attachStreamToVideo(localVideoRef.current, stream, true);
      } else {
        updateLocalPreview();
      }

      setStatus('Камера и микрофон подключены');
      return stream;
    } catch (error) {
      console.error('getUserMedia error:', error);

      // Последний фолбэк: хотя бы микрофон
      try {
        const audioOnlyStream = await navigator.mediaDevices.getUserMedia(audioOnlyConstraints);

        cameraStreamRef.current = audioOnlyStream;

        audioOnlyStream.getAudioTracks().forEach((track) => {
          track.enabled = !isMuted;
        });

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = null;
        }

        setStatus('Камера недоступна, но микрофон подключён');
        return audioOnlyStream;
      } catch (audioOnlyError) {
        console.error('audioOnly fallback error:', audioOnlyError);
        setStatus(getMediaErrorMessage(error));
        return null;
      }
    }
  };

  const createPeerConnection = async () => {
    if (peerRef.current) return peerRef.current;

    const peer = new RTCPeerConnection(rtcConfig);

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('Отправляем ICE candidate:', event.candidate.type);

        socket.emit('ice-candidate', {
          roomId: roomIdRef.current,
          candidate: event.candidate,
        });
      } else {
        console.log('ICE gathering completed');
      }
    };

    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      console.log('Получен remote track');

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }

      setStatus('Звонок активен');
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      console.log('connectionState:', state);

      if (state === 'connected') {
        setStatus('Соединение установлено');
        setCallStartedAt((prev) => prev || Date.now());
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

    peer.oniceconnectionstatechange = () => {
      console.log('iceConnectionState:', peer.iceConnectionState);
    };

    peer.onicegatheringstatechange = () => {
      console.log('iceGatheringState:', peer.iceGatheringState);
    };

    peer.onsignalingstatechange = () => {
      console.log('signalingState:', peer.signalingState);
    };

    const stream = await startCameraMedia();

    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        peer.addTrack(track, stream);
      });

      const videoTrack =
        screenStreamRef.current?.getVideoTracks()[0] ||
        stream.getVideoTracks()[0];

      if (videoTrack) {
        const videoSourceStream = screenStreamRef.current || stream;
        peer.addTrack(videoTrack, videoSourceStream);
      }
    } else {
      console.warn('Peer создан без локального media stream');
    }

    peerRef.current = peer;
    return peer;
  };

  const flushPendingIceCandidates = async () => {
    if (!peerRef.current || !remoteDescriptionSetRef.current) return;

    while (pendingIceCandidatesRef.current.length > 0) {
      const candidate = pendingIceCandidatesRef.current.shift();

      try {
        await peerRef.current.addIceCandidate(candidate);
        console.log('Отложенный ICE candidate успешно добавлен');
      } catch (error) {
        console.error('Ошибка при добавлении отложенного ICE candidate:', error);
      }
    }
  };

  const createOffer = async () => {
    const peer = await createPeerConnection();

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    console.log('Создан и отправлен offer');

    socket.emit('offer', {
      roomId: roomIdRef.current,
      offer,
    });
  };

  const handleOffer = async (offer) => {
    const peer = await createPeerConnection();

    await peer.setRemoteDescription(offer);
    remoteDescriptionSetRef.current = true;
    await flushPendingIceCandidates();

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

    setStatus('Проверяем доступ к камере и микрофону...');

    await logPermissionState();
    const mediaStream = await startCameraMedia();

    if (!mediaStream) {
      setStatus('Сначала разрешите доступ к камере/микрофону, затем войдите в комнату');
      return;
    }

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

  const logPermissionState = async () => {
    if (!navigator.permissions?.query) return;

    try {
      const cameraPermission = await navigator.permissions.query({ name: 'camera' });
      console.log('camera permission:', cameraPermission.state);
    } catch (e) {
      console.warn('Не удалось проверить camera permission', e);
    }

    try {
      const micPermission = await navigator.permissions.query({ name: 'microphone' });
      console.log('microphone permission:', micPermission.state);
    } catch (e) {
      console.warn('Не удалось проверить microphone permission', e);
    }
  };

  const toggleMute = () => {
    if (!cameraStreamRef.current) return;

    const nextMuted = !isMuted;

    cameraStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });

    setIsMuted(nextMuted);
    emitMediaState({ micOff: nextMuted });
    setStatus(nextMuted ? 'Микрофон выключен' : 'Микрофон включён');
  };

  const toggleCamera = () => {
    const currentVideoTrack = getCurrentVideoTrack();
    const nextCameraOff = !isCameraOff;

    if (currentVideoTrack) {
      currentVideoTrack.enabled = !nextCameraOff;
    }

    setIsCameraOff(nextCameraOff);
    emitMediaState({ cameraOff: nextCameraOff });
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
      peerRef.current.oniceconnectionstatechange = null;
      peerRef.current.onicegatheringstatechange = null;
      peerRef.current.onsignalingstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }

    pendingIceCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;
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
    setParticipants([]);
    setRemoteMediaState({
      cameraOff: false,
      micOff: false,
    });
  };

  const localVideoTrack = getCurrentVideoTrack();
  const hasLocalVideoTrack = Boolean(localVideoTrack);

  const localStatusText = getMediaStatusText({
    cameraOff: isCameraOff,
    micOff: isMuted,
    cameraMissing: false,
  });

  const remoteStatusText = getMediaStatusText({
    cameraOff: remoteMediaState.cameraOff,
    micOff: remoteMediaState.micOff,
  });

  const videoLayoutClass = `video-layout layout-${remoteVideoShape}-${localVideoShape}`;
  const remotePanelClass = `video-panel video-card remote-panel ${remoteVideoShape} ${remoteStatusText ? 'camera-off' : ''}`;
  const localPanelClass = `video-panel video-card local-panel ${localVideoShape} ${localStatusText ? 'camera-off' : ''}`;

  if (!authChecked) {
    return <div className="auth-page">Проверяем авторизацию...</div>;
  }

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
          <button
            className="ghost-btn"
            onClick={() => {
              localStorage.removeItem('token');
              setAuthUser(null);
              setJoined(false);
              setMessages([]);
              setParticipants([]);
              setStatus('Вы вышли из аккаунта');
              stopAllMedia();
              closePeerConnection();
            }}
          >
            Выйти
          </button>
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

        <div className="participants-card">
          <div className="participants-header">
            <span>Участники комнаты</span>
            <span>{participants.length}/2</span>
          </div>

          <div className="participants-list">
            {participants.length === 0 ? (
              <div className="participants-empty">Пока никого нет</div>
            ) : (
              participants.map((participant) => (
                <div className="participant-item" key={participant.socketId}>
                  <span className="participant-name">
                    {participant.userName || 'Участник'}
                  </span>
                  <span className="participant-badge">
                    {(participant.userName || '').trim() === userName.trim() ? 'Вы' : 'В комнате'}
                  </span>
                </div>
              ))
            )}
          </div>
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
          <div className={videoLayoutClass}>
            <div className={remotePanelClass}>
              <div className="video-header">
                <span>{remoteUserName}</span>
                <span className="dot" />
              </div>

              {!remoteMediaState.cameraOff && (
                <video ref={remoteVideoRef} autoPlay playsInline />
              )}

              {remoteStatusText && (
                <div className="video-overlay">
                  <div className="video-overlay-title">{remoteUserName}</div>
                  <div className="video-overlay-text">{remoteStatusText}</div>
                </div>
              )}
            </div>

            <div className={localPanelClass}>
              <div className="video-header">
                <span>{userName || 'Вы'}</span>
                <span className="self-tag">Вы</span>
              </div>

              {!isCameraOff && (
                <video ref={localVideoRef} autoPlay playsInline muted />
              )}

              {localStatusText && (
                <div className="video-overlay">
                  <div className="video-overlay-title">{userName || 'Вы'}</div>
                  <div className="video-overlay-text">{localStatusText}</div>
                </div>
              )}
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