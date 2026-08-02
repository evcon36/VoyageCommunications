import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Room, RoomEvent, Track, ConnectionQuality } from 'livekit-client';
// @livekit/track-processors загружается лениво при включении размытия —
// статический импорт ломает старт на части браузеров (WASM-инициализация)
import './App.css';
import Icon from './Icons';
import AuthPage from './components/AuthPage';
import { getMe } from './services/auth';
import { getAltDomainUrl, ALT_DOMAIN_HINT, buildInviteLink } from './altDomain';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const BASE = import.meta.env.VITE_BASE_PATH || '/communications/';

// iPad с iPadOS 13+ представляется как MacIntel, поэтому проверяем ещё и тачи.
const IS_IOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

// identity приходит с суффиксом (#a1b2) для уникальности устройств,
// отображаем человеку только имя
const displayName = (p) => p?.name || String(p?.identity || '').split('#')[0];

// Эмодзи-реакции в звонке
const REACTIONS = ['❤️', '👍', '😂', '😮', '👏', '✋'];

// кликабельные ссылки в тексте чата
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function renderMessageText(text) {
  const parts = String(text).split(URL_RE);
  return parts.map((part, i) =>
    URL_RE.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="chat-link">{part}</a>
      : part
  );
}

// Кастомный селект в фирменном тёмном стиле (нативный <select> нельзя стилизовать —
// ОС рисует свой светлый список опций). options: [{value, label}].
function Select({ value, onChange, options, placeholder, className = '', size = 'md', align = 'left' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const current = options.find(o => o.value === value);
  const label = current ? current.label : (placeholder || '—');

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (v) => { onChange(v); setOpen(false); };
  const onBtnKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(Math.max(0, options.findIndex(o => o.value === value))); return; }
      setActive(a => { const n = e.key === 'ArrowDown' ? a + 1 : a - 1; return (n + options.length) % options.length; });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open && active >= 0) pick(options[active].value); else setOpen(o => !o);
    }
  };

  return (
    <div ref={rootRef} className={`vs ${className} ${open ? 'vs--open' : ''} vs--${size}`}>
      <button type="button" className="vs-trigger" onClick={() => setOpen(o => !o)} onKeyDown={onBtnKey}
        aria-haspopup="listbox" aria-expanded={open}
        style={open ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)', background: 'rgba(0,0,0,0.5)' } : undefined}>
        <span className={`vs-value${!current ? ' vs-value--placeholder' : ''}`}>{label}</span>
        <svg className="vs-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : 'none', color: open ? 'var(--accent)' : undefined, transition: 'transform .18s ease, color .15s' }}>
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className={`vs-menu vs-menu--${align}`} role="listbox">
          {options.map((o, i) => (
            <button type="button" key={o.value ?? `__${i}`} role="option" aria-selected={o.value === value}
              className={`vs-option${o.value === value ? ' vs-option--selected' : ''}${i === active ? ' vs-option--active' : ''}`}
              onMouseEnter={() => setActive(i)} onClick={() => pick(o.value)}>
              <span className="vs-option-label">{o.label}</span>
              {o.value === value && <svg className="vs-check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5L6 11l5.5-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Аватар: реальная картинка, если она есть, иначе инициал
// Сервер хранит аватары относительным путём вида /uploads/avatars/x.jpg.
// В браузере он сам достраивается до домена, а в мобильном приложении
// указывал бы внутрь бандла — картинки не находились. Достраиваем явно.
function mediaUrl(path) {
  if (!path) return path;
  return /^(https?:|data:|blob:)/.test(path) ? path : `${SERVER_URL}${path}`;
}

function Avatar({ url, name, className = 'company-member-avatar' }) {
  const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
  return url
    ? <img className={className} src={mediaUrl(url)} alt="" loading="lazy" />
    : <span className={className}>{initial}</span>;
}

// Реальный переключатель-слайдер (заменяет текстовые «Вкл/Выкл»)
function Switch({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      className={`sw${checked ? ' sw--on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="sw-thumb" />
    </button>
  );
}

// мягкий звуковой сигнал входа/выхода участника (WebAudio, без файлов)
let chimeCtx = null;
function playChime(joined) {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = chimeCtx;
    const notes = joined ? [523.25, 783.99] : [783.99, 523.25]; // C5→G5 вход, G5→C5 выход
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.12 + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.3);
    });
  } catch {}
}

// All available sounds
// Клипы с голосом реального публичного лица — это чужая интеллектуальная
// собственность, и App Store такое отклоняет (Guideline 5.2.1). На iOS
// оставляем только нейтральные аплодисменты; сами файлы вырезаются из
// iOS-сборки отдельным шагом в codemagic.yaml.
const SOUNDS = [
  { id: 'applause',       emoji: '👏', label: 'Аплодисменты',    file: BASE + 'applause.mp3' },
  ...(IS_IOS ? [] : [
    { id: 'trump-money',    emoji: '💵', label: 'We need money',   file: BASE + 'trump-money.mp3' },
    { id: 'trump-amazing',  emoji: '✨', label: "You're amazing",  file: BASE + 'trump-amazing.mp3' },
    { id: 'trump-beautiful',emoji: '💛', label: "You're beautiful",file: BASE + 'trump-beautiful.mp3' },
    { id: 'trump-50',       emoji: '📊', label: '50%',             file: BASE + 'trump-50.mp3' },
  ]),
];

// Почему звонок закончился — человеку нужно объяснение, а не тишина
const CALL_END_TEXT = {
  declined: 'Звонок отклонён',
  cancelled: 'Звонок отменён',
  timeout: 'Не ответили',
  busy: 'Абонент занят',
  unavailable: 'Абонент не в сети',
  taken: 'Вы ответили на другом устройстве',
  self: 'Нельзя позвонить самому себе',
};

// Гудок дозвона и звонок входящего — генерируем, чтобы не тащить mp3.
function startRingTone(kind) {
  let ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return () => {}; }
  let stopped = false;
  const beep = () => {
    if (stopped || ctx.state === 'closed') return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'in' ? 620 : 440;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.95);
    if (kind === 'in' && navigator.vibrate) navigator.vibrate(400);
  };
  beep();
  const id = setInterval(beep, kind === 'in' ? 2000 : 3000);
  return () => {
    stopped = true;
    clearInterval(id);
    if (navigator.vibrate) navigator.vibrate(0);
    try { ctx.close(); } catch { /* уже закрыт */ }
  };
}

// ── Подбор сетки ──
// Раньше плитки держали пропорцию камеры и складывались в ленту с прокруткой:
// на трёх участниках приходилось листать. Теперь наоборот — сетка обязана
// поместиться в экран, а видео заполняет ячейку с обрезкой, как в FaceTime.
// Перебираем все варианты «столбцы × строки» и берём тот, где ячейка крупнее
// и ближе к вертикальной пропорции: лица в таких ячейках читаются лучше.
const SPEAKER_FROM = 6;      // на телефоне с этого числа — главный + лента
const TILE_GAP = 8;
const DEFAULT_ASPECT = 9 / 16;

// ── Ошибки подключения к LiveKit ──
// Срыв рукопожатия на слабой сети выглядит как окончательный отказ, хотя
// достаточно повторить. Сюда же попадают формулировки самой библиотеки
// («could not establish signal connection: Abort handler called»), которые
// пользователю показывать бессмысленно.
const RETRIABLE_CONNECT = /503|service unavailable|websocket|signal connection|abort handler|timeout|timed out|network/i;
function isRetriableConnect(e) {
  return RETRIABLE_CONNECT.test(String(e?.message || ''));
}
function humanConnectError(e) {
  const m = String(e?.message || '');
  if (RETRIABLE_CONNECT.test(m)) {
    return 'не удалось связаться с сервером звонков. Проверьте интернет и попробуйте ещё раз';
  }
  return m || 'неизвестная ошибка';
}

// ── Раскладка без обрезки ──
// Видео никогда не режем: плитка принимает пропорцию потока. Участники
// разбиваются на ряды, ряд заполняет ширину, высота ряда следует из суммы
// пропорций. Последний неполный ряд не растягиваем — он берёт высоту
// предыдущего и центрируется. Если не помещается по высоте, уменьшаем
// всё пропорционально: узких обрезанных столбиков быть не должно.
function packRows(aspects, W, H, gap = TILE_GAP) {
  const n = aspects.length;
  if (!n || W <= 0 || H <= 0) return null;
  let best = null;
  const variants = 1 << Math.max(n - 1, 0);
  for (let mask = 0; mask < variants; mask++) {
    const rows = [];
    let cur = [0];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) { rows.push(cur); cur = []; }
      cur.push(i);
    }
    rows.push(cur);

    const heights = [];
    let prev = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const sum = rows[i].reduce((a, idx) => a + aspects[idx], 0);
      const fill = (W - gap * (rows[i].length - 1)) / sum;
      const isLast = i === rows.length - 1 && rows.length > 1;
      const h = isLast ? Math.min(fill, prev) : fill;
      heights.push(h);
      prev = h;
    }
    const total = heights.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
    const scale = Math.min(1, H / total);
    const finalH = heights.map(h => h * scale);

    let minArea = Infinity;
    rows.forEach((row, i) => row.forEach(idx => {
      minArea = Math.min(minArea, aspects[idx] * finalH[i] * finalH[i]);
    }));
    // берём раскладку, где самая мелкая плитка крупнее всего — так никто
    // не оказывается в «щели», пока сосед занимает пол-экрана
    if (!best || minArea > best.minArea) {
      best = { rows, heights: finalH, minArea, total: total * scale };
    }
  }
  return best;
}

// --- Persistent audio for remote participants (always mounted) ---
function RemoteAudio({ participant, volume = 1, localMuted = false }) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (!participant) return;
    const attach = () => {
      const audioPub = participant.getTrackPublication(Track.Source.Microphone);
      if (audioPub?.track && audioPub.isSubscribed && audioRef.current) {
        audioPub.track.attach(audioRef.current);
      }
    };
    attach();
    participant.on('trackSubscribed', attach);
    participant.on('trackPublished', attach);
    return () => {
      participant.off('trackSubscribed', attach);
      participant.off('trackPublished', attach);
    };
  }, [participant]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = localMuted;
      audioRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume, localMuted]);

  return <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />;
}

// --- Screen share main view ---
function ScreenShareTile({ participant, isLocal }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!participant) return;
    let attached = null;

    const attach = () => {
      const pub = participant.getTrackPublication(Track.Source.ScreenShare);
      const track = pub?.track && (isLocal || pub.isSubscribed) ? pub.track : null;
      if (track && videoRef.current && attached !== track) {
        if (attached) attached.detach(videoRef.current);
        track.attach(videoRef.current);
        attached = track;
      } else if (!track && attached && videoRef.current) {
        attached.detach(videoRef.current);
        attached = null;
      }
    };

    attach();
    participant.on('trackPublished', attach);
    participant.on('trackSubscribed', attach);
    participant.on('localTrackPublished', attach);
    participant.on('trackUnpublished', attach);
    participant.on('trackUnsubscribed', attach);

    return () => {
      participant.off('trackPublished', attach);
      participant.off('trackSubscribed', attach);
      participant.off('localTrackPublished', attach);
      participant.off('trackUnpublished', attach);
      participant.off('trackUnsubscribed', attach);
      if (attached && videoRef.current) {
        try { attached.detach(videoRef.current); } catch {}
      }
    };
  }, [participant, isLocal]);

  return (
    <div className="screen-share-main">
      <video ref={videoRef} autoPlay playsInline muted />
      <div className="screen-share-label">
        <span>{displayName(participant)} — демонстрация экрана</span>
      </div>
    </div>
  );
}

// --- Single participant tile ---
function ParticipantTile({ participant, isLocal, isFrontCamera, small, localMuted, onToggleMute, backdrop, gridSpan, onMeta }) {
  const videoRef = useRef(null);
  const backdropRef = useRef(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [isMicOff, setIsMicOff] = useState(false);
  const [isCamOff, setIsCamOff] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [videoAspect, setVideoAspect] = useState(null); // w/h реального потока (портрет/ландшафт)

  // подсветка активного говорящего
  useEffect(() => {
    if (!participant) return;
    const onSpeak = () => setIsSpeaking(participant.isSpeaking);
    participant.on('isSpeakingChanged', onSpeak);
    onSpeak();
    return () => participant.off('isSpeakingChanged', onSpeak);
  }, [participant]);

  // следим за реальными размерами видео — чтобы плитка приняла форму потока
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const update = () => {
      if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight);
    };
    v.addEventListener('loadedmetadata', update);
    v.addEventListener('resize', update);
    update();
    return () => {
      v.removeEventListener('loadedmetadata', update);
      v.removeEventListener('resize', update);
    };
  }, [hasVideo]);

  useEffect(() => {
    if (!participant) return;
    let attached = null;

    const updateState = () => {
      const cameraPub = participant.getTrackPublication(Track.Source.Camera);
      const micPub = participant.getTrackPublication(Track.Source.Microphone);

      const camTrack = cameraPub?.track && (isLocal || cameraPub.isSubscribed) ? cameraPub.track : null;
      const camMuted = cameraPub ? cameraPub.isMuted : true;
      setIsCamOff(camMuted);
      setIsMicOff(micPub?.isMuted ?? false);

      if (camTrack && !camMuted && videoRef.current) {
        if (attached !== camTrack) {
          if (attached) attached.detach(videoRef.current);
          camTrack.attach(videoRef.current);
          attached = camTrack;
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

    updateState();

    const handleAll = () => { updateState(); };

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

  // размытая подложка того же потока — заполняет поля по бокам,
  // когда видео показывается целиком (contain) в полноэкранном PiP
  useEffect(() => {
    const bg = backdropRef.current;
    if (!backdrop || !bg || !participant) return;
    const pub = participant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track && (isLocal || pub.isSubscribed) && !pub.isMuted ? pub.track : null;
    if (track) { try { track.attach(bg); } catch {} }
    return () => { if (track) { try { track.detach(bg); } catch {} } };
  }, [backdrop, participant, isLocal, hasVideo]);

  const mirrorStyle =
    isLocal && isFrontCamera && !isCamOff
      ? { transform: 'scaleX(-1)', WebkitTransform: 'scaleX(-1)' }
      : {};

  // Плитка сообщает наверх только пропорцию потока, чтобы её подогнали под
  // видео. Факт «камера выключена» она НЕ сообщает: это решает родитель по
  // публикации собеседника. Иначе выходил замкнутый круг, см. hasCameraOn.
  useEffect(() => {
    onMeta?.(participant?.identity, videoAspect);
  }, [onMeta, participant?.identity, videoAspect]);

  return (
    <div
      className={`participant-tile${small ? ' participant-tile--small' : ''}${isSpeaking ? ' participant-tile--speaking' : ''}`}
      style={{ ...(videoAspect ? { '--tile-aspect': videoAspect } : null), ...gridSpan }}
    >
      {backdrop && (
        <video ref={backdropRef} className="tile-backdrop" autoPlay playsInline muted
          style={{ display: hasVideo && !isCamOff ? 'block' : 'none' }} />
      )}
      <video
        ref={videoRef}
        className="tile-video"
        autoPlay
        playsInline
        muted={isLocal}
        style={{ ...mirrorStyle, display: hasVideo && !isCamOff ? 'block' : 'none' }}
      />
      {(!hasVideo || isCamOff) && (
        <div className="tile-no-video">
          <div className="tile-avatar">
            {(displayName(participant) || '?')[0].toUpperCase()}
          </div>
        </div>
      )}
      <div className="tile-footer">
        <span className="tile-name">{displayName(participant)}</span>
        <span className="tile-icons">
          {isMicOff && <span title="Микрофон выкл"><Icon name="micOff" size={13} /></span>}
          {isCamOff && <span title="Камера выкл"><Icon name="cameraOff" size={13} /></span>}
          {!isLocal && !small && (
            <button
              className={`tile-mute-btn${localMuted ? ' tile-mute-btn--on' : ''}`}
              title={localMuted ? 'Включить звук' : 'Заглушить'}
              onClick={e => { e.stopPropagation(); onToggleMute?.(); }}
            >
              <Icon name={localMuted ? 'volumeOff' : 'volume'} size={14} />
            </button>
          )}
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

  // ?room=xxx&key=yyy в ссылке — приглашение сразу в конкретную комнату
  const [roomId, setRoomId] = useState(() =>
    new URLSearchParams(window.location.search).get('room') || '');
  const inviteKeyRef = useRef(new URLSearchParams(window.location.search).get('key') || null);
  const [userName, setUserName] = useState('Иван');

  // ── Гостевой вход по ссылке (без аккаунта) ──
  // Пускаем только по полной ссылке-приглашению: нужен и номер комнаты, и ключ.
  const guestInvite = useRef({
    room: new URLSearchParams(window.location.search).get('room') || '',
    key: new URLSearchParams(window.location.search).get('key') || '',
  }).current;
  const hasGuestInvite = Boolean(guestInvite.room && guestInvite.key);
  const [guestMode, setGuestMode] = useState(false);   // вошли как гость
  const [guestDismissed, setGuestDismissed] = useState(false); // выбрали «войти в аккаунт»
  const [guestNameInput, setGuestNameInput] = useState('');
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState('');
  // стабильный идентификатор гостя на время сессии — нужен приёмной,
  // чтобы «впустить» относилось именно к этому человеку
  const guestIdRef = useRef(
    `g-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  );

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
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isScreenFullscreen, setIsScreenFullscreen] = useState(false);

  const [callHistory, setCallHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Режим работы: personal | business | employee (миграция со старого businessMode)
  const [workMode, setWorkMode] = useState(() => {
    const wm = localStorage.getItem('workMode');
    if (wm === 'business' || wm === 'employee' || wm === 'personal') return wm;
    return localStorage.getItem('businessMode') === '1' ? 'business' : 'personal';
  });
  const businessMode = workMode === 'business';
  const employeeMode = workMode === 'employee';
  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState('');
  const [companyInvite, setCompanyInvite] = useState({}); // { slug: 'nick' }

  // Аккаунт-центр
  const [myRooms, setMyRooms] = useState([]);
  const [myRoomsLoading, setMyRoomsLoading] = useState(false);
  const [editName, setEditName] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const avatarInputRef = useRef(null);

  const [actionMessages, setActionMessages] = useState([]);

  // Settings
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('sound');
  const [masterVolume, setMasterVolume] = useState(() => Number(localStorage.getItem('vol_master') ?? 100));
  const [applauseVolume, setApplauseVolume] = useState(() => Number(localStorage.getItem('vol_applause') ?? 80));
  const [usersVolume, setUsersVolume] = useState(() => Number(localStorage.getItem('vol_users') ?? 100));
  const [autoEnableCamera, setAutoEnableCamera] = useState(() => localStorage.getItem('autoCamera') !== 'false');
  const [mutedUsers, setMutedUsers] = useState(() => new Set());

  // Sounds panel
  const [isSoundsPanelOpen, setIsSoundsPanelOpen] = useState(false);

  // Запись звонка
  const [recActive, setRecActive] = useState(false);
  const recActiveRef = useRef(false);
  useEffect(() => { recActiveRef.current = recActive; }, [recActive]);
  const [recStartedBy, setRecStartedBy] = useState(null);
  const [recBusy, setRecBusy] = useState(false);
  const [myRecordings, setMyRecordings] = useState([]);
  const [recordingsLoading, setRecordingsLoading] = useState(false);

  // Приватные комнаты
  const [roomInfo, setRoomInfo] = useState(null); // инфо о текущем roomId, если комната зарегистрирована

  // Контакты
  const [contacts, setContacts] = useState([]);
  const [contactSearch, setContactSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  // Звонок — одно состояние на обе роли. Раньше звонящий сразу оказывался
  // «в звонке», а получатель жил в отдельной переменной, и стороны расходились.
  // { role:'out'|'in', callId, peer, peerName, roomSlug, inviteKey, phase:'ringing'|'connecting' }
  const [call, setCall] = useState(null);
  const [callNotice, setCallNotice] = useState('');   // «Отклонён», «Занят» и т.п.
  const [callLeft, setCallLeft] = useState(0);        // сколько секунд осталось звонить
  // Доступ к камере и микрофону отклонён: iOS не даёт спросить повторно,
  // вернуть можно только в настройках системы — объясняем это пользователю.
  const [mediaBlocked, setMediaBlocked] = useState(false);
  const [knockRequest, setKnockRequest] = useState(null); // { username, name, roomId } — у владельца
  const [knocking, setKnocking] = useState(false);        // мы ждём, когда впустят
  // Комната ожидания
  const [waitingForHost, setWaitingForHost] = useState(false);       // мы в приёмной
  const waitingRetryRef = useRef(null);                              // { slug, key } для повтора
  const [waitingList, setWaitingList] = useState([]);                // у ведущего: [{socketId, name, userId}]
  const knockTimerRef = useRef(null);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isContactsOpen, setIsContactsOpen] = useState(false);

  // PiP 1-на-1 (телефон/планшет): большой собеседник + перетаскиваемая своя камера
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  // Положение своего плавающего окна: null = «ещё не трогали», встаёт
  // в правый нижний угол автоматически
  const [selfPos, setSelfPos] = useState(null);
  const [selfDragging, setSelfDragging] = useState(false);

  // Реакции-эмодзи
  const [isReactionsOpen, setIsReactionsOpen] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState([]); // [{id, emoji, x}]

  // Качество соединения (своё)
  const [connQuality, setConnQuality] = useState('excellent');

  // Размытие фона (модуль подгружается лениво при первом включении)
  const [blurEnabled, setBlurEnabled] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const blurModuleRef = useRef(null);

  // иммерсивный режим: управление всплывает по тапу (телефон) / движению мыши (ПК)
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsVisibleRef = useRef(true);
  useEffect(() => { controlsVisibleRef.current = controlsVisible; }, [controlsVisible]);
  const controlsTimerRef = useRef(null);
  const scheduleHideControls = () => {
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 4000);
  };
  const revealControls = () => { setControlsVisible(true); scheduleHideControls(); };
  // телефон/планшет: тап переключает
  const onStageTap = () => {
    clearTimeout(controlsTimerRef.current);
    setControlsVisible(v => {
      if (!v) scheduleHideControls();
      return !v;
    });
  };
  // ПК: движение мыши показывает управление, через 4с бездействия — прячет
  const onDesktopMouseMove = () => {
    clearTimeout(controlsTimerRef.current);
    if (!controlsVisibleRef.current) setControlsVisible(true);
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 4000);
  };

  // Audio refs for each sound
  const soundRefs = useRef({});
  SOUNDS.forEach(s => { if (!soundRefs.current[s.id]) soundRefs.current[s.id] = null; });

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
  const [authNetError, setAuthNetError] = useState(false);
  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { setAuthChecked(true); return; }
    setAuthNetError(false);
    try {
      const result = await getMe(token);
      setAuthUser(result.user);
      setUserName(result.user.displayName || result.user.username || 'Иван');
      // дефолтный ID комнаты: ник + 3 случайные цифры (если не пришли по ссылке)
      setRoomId(prev => prev || `${result.user.username}-${Math.floor(100 + Math.random() * 900)}`);
      setAuthChecked(true);
    } catch (e) {
      if (e.status === 401) {
        // токен реально недействителен — только тогда выходим
        localStorage.removeItem('token');
        setAuthUser(null);
        setAuthError('Сессия истекла. Войдите снова.');
        setAuthChecked(true);
      } else {
        // сеть моргнула — токен НЕ трогаем, предлагаем повторить
        setAuthNetError(true);
        setAuthChecked(true);
      }
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  // Fetch call history
  const fetchHistory = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setHistoryLoading(true);
    try {
      const resp = await fetch(`${SERVER_URL}/rooms/history`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        setCallHistory(data.sessions || []);
      }
    } catch {}
    finally { setHistoryLoading(false); }
  }, []);

  // Load history when account panel opens on history tab
  useEffect(() => {
    if (isAccountPanelOpen && accountTab === 'history') fetchHistory();
  }, [isAccountPanelOpen, accountTab, fetchHistory]);

  // ── Запись звонка ──
  const toggleRecording = async () => {
    if (recBusy) return;
    setRecBusy(true);
    try {
      const token = localStorage.getItem('token');
      const path = recActive ? '/recordings/stop' : '/recordings/start';
      const resp = await fetch(`${SERVER_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roomId: roomIdRef.current }),
      });
      const data = await resp.json();
      if (resp.ok) {
        const nowActive = !recActive;
        setRecActive(nowActive);
        setRecStartedBy(nowActive ? userName.trim() : null);
        socket.emit('recording-state', { roomId: roomIdRef.current, active: nowActive, by: userName.trim() });
        setStatus(nowActive ? 'Запись включена' : 'Запись остановлена — файл появится в аккаунте');
      } else {
        setStatus(data.message || 'Ошибка записи');
      }
    } catch {
      setStatus('Ошибка записи');
    } finally {
      setRecBusy(false);
    }
  };

  // Проверить, не идёт ли уже запись (при входе в комнату)
  const checkRecordingStatus = useCallback(async (rid) => {
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/recordings/status/${encodeURIComponent(rid)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        setRecActive(data.active);
        setRecStartedBy(data.startedBy);
      }
    } catch {}
  }, []);

  const fetchMyRecordings = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setRecordingsLoading(true);
    try {
      const resp = await fetch(`${SERVER_URL}/recordings/my`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        setMyRecordings(data.recordings || []);
      }
    } catch {}
    finally { setRecordingsLoading(false); }
  }, []);

  useEffect(() => {
    if (isAccountPanelOpen && accountTab === 'recordings') fetchMyRecordings();
  }, [isAccountPanelOpen, accountTab, fetchMyRecordings]);

  // опрос статуса обработки (расшифровка или ИИ), пока идёт
  const pollTranscript = useCallback((recId, field = 'transcriptStatus') => {
    const token = localStorage.getItem('token');
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${SERVER_URL}/recordings/${recId}/transcript`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        const value = field === 'aiStatus' ? d.aiStatus : field === 'summaryStatus' ? d.summaryStatus : d.status;
        if (value === 'done' || value === 'failed') {
          clearInterval(iv);
          setMyRecordings(prev => prev.map(x => x.id === recId
            ? { ...x, transcriptStatus: d.status, aiStatus: d.aiStatus, transcript: d.transcript, transcriptAi: d.transcriptAi, summary: d.summary, summaryStatus: d.summaryStatus }
            : x));
        }
      } catch {}
    }, 6000);
  }, []);

  // скачать расшифровку текстовым файлом (с таймкодами). ai=true — версия ИИ
  const downloadTranscript = (rec, ai = false) => {
    const segments = ai ? rec.transcriptAi : rec.transcript;
    if (!Array.isArray(segments) || !segments.length) return;
    const fmt = (s) => {
      const m = Math.floor(s / 60), ss = Math.floor(s % 60);
      return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    };
    const header = `Запись звонка #${rec.roomId}\n` +
      `Дата: ${new Date(rec.startedAt).toLocaleString('ru-RU')}\n` +
      (ai ? 'Версия: улучшено ИИ\n' : 'Версия: оригинал (авто-распознавание)\n') + '\n';
    const body = segments
      .map(s => `[${fmt(s.start)}–${fmt(s.end)}] ${s.speaker || 'Говорящий'}: ${s.text}`)
      .join('\n');
    const blob = new Blob(['﻿' + header + body], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `расшифровка-${rec.roomId}${ai ? '-ии' : ''}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ИИ-саммари звонка
  const requestSummary = async (recId) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/recordings/${recId}/summary`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 202) {
        setMyRecordings(prev => prev.map(r => r.id === recId ? { ...r, summaryStatus: 'processing' } : r));
        pollTranscript(recId, 'summaryStatus');
      } else {
        const d = await resp.json().catch(() => ({}));
        setProfileMsg(d.message || 'Не удалось запустить саммари');
        setTimeout(() => setProfileMsg(''), 3500);
      }
    } catch {
      setProfileMsg('Ошибка сети');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  // скачать саммари файлом
  const downloadSummary = (rec) => {
    if (!rec.summary) return;
    const blob = new Blob(['﻿' + `Саммари звонка #${rec.roomId}\nДата: ${new Date(rec.startedAt).toLocaleString('ru-RU')}\n\n` + rec.summary], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `саммари-${rec.roomId}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ИИ-улучшение расшифровки
  const enhanceTranscript = async (recId) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/recordings/${recId}/enhance`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 202) {
        setMyRecordings(prev => prev.map(r => r.id === recId ? { ...r, aiStatus: 'processing' } : r));
        pollTranscript(recId, 'aiStatus');
      } else {
        const d = await resp.json().catch(() => ({}));
        setProfileMsg(d.message || 'Не удалось запустить ИИ');
        setTimeout(() => setProfileMsg(''), 3500);
      }
    } catch {
      setProfileMsg('Ошибка сети');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  // ── Удаление аккаунта ──
  // Требование App Store (Guideline 5.1.1(v)): если в приложении есть регистрация,
  // должна быть и возможность удалить аккаунт прямо здесь, без писем в поддержку.
  const [delOpen, setDelOpen] = useState(false);
  const [delPreview, setDelPreview] = useState(null);
  const [delConfirm, setDelConfirm] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState('');

  const openDeleteAccount = async () => {
    setDelError('');
    setDelConfirm('');
    setDelOpen(true);
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(`${SERVER_URL}/auth/account/deletion-preview`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setDelPreview(await r.json());
    } catch { /* предпросмотр необязателен — удалить можно и без него */ }
  };

  const confirmDeleteAccount = async () => {
    setDelBusy(true);
    setDelError('');
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(`${SERVER_URL}/auth/account/delete`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDelError(d.message || 'Не удалось удалить аккаунт');
        return;
      }
      if (joined) leaveCall();
      setDelOpen(false);
      // показываем экран восстановления вместо приложения
      setAuthUser(u => (u ? { ...u, deletionRequestedAt: new Date().toISOString(), purgeAt: d.purge_at } : u));
    } catch {
      setDelError('Ошибка сети');
    } finally {
      setDelBusy(false);
    }
  };

  const restoreAccount = async () => {
    setDelBusy(true);
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(`${SERVER_URL}/auth/account/restore`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setAuthUser(u => (u ? { ...u, deletionRequestedAt: null, purgeAt: null } : u));
    } catch { /* пусть пользователь попробует ещё раз */ } finally {
      setDelBusy(false);
    }
  };

  // Файл записи больше не лежит в открытом доступе: сначала просим у сервера
  // подписанную ссылку (живёт 5 минут), потом уже скачиваем по ней.
  const downloadRecording = async (recId) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/recordings/${recId}/link`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok || !d.url) {
        setProfileMsg(d.message || 'Не удалось получить ссылку на запись');
        setTimeout(() => setProfileMsg(''), 3500);
        return;
      }
      window.location.href = `${SERVER_URL}${d.url}`;
    } catch {
      setProfileMsg('Ошибка сети');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  const startTranscribe = async (recId) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/recordings/${recId}/transcribe`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.status === 202) {
        setMyRecordings(prev => prev.map(r => r.id === recId ? { ...r, transcriptStatus: 'processing' } : r));
        pollTranscript(recId);
      } else {
        const d = await resp.json().catch(() => ({}));
        setProfileMsg(d.message || 'Не удалось запустить расшифровку');
        setTimeout(() => setProfileMsg(''), 3500);
      }
    } catch {
      setProfileMsg('Ошибка сети');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  // ── Бизнес: компании ──
  const fetchCompanies = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setCompaniesLoading(true);
    try {
      const resp = await fetch(`${SERVER_URL}/companies/my`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) { const d = await resp.json(); setCompanies(d.companies || []); }
    } catch {}
    finally { setCompaniesLoading(false); }
  }, []);

  useEffect(() => { if (authUser) fetchCompanies(); }, [authUser, fetchCompanies]);

  // активная компания для брендинга (первая, где владелец/админ, иначе первая)
  const activeCompany = useMemo(() => {
    if (!companies.length) return null;
    return companies.find(c => c.myRole === 'owner' || c.myRole === 'admin') || companies[0];
  }, [companies]);
  // компании, которыми можно управлять (для кнопки «Панель управления» на главном)
  const manageableCompanies = useMemo(
    () => companies.filter(c => c.myRole === 'owner' || c.myRole === 'admin'),
    [companies]
  );
  // Владелец не может быть сотрудником собственной компании: кабинет — только там, где нанят.
  // Админ — это нанятый сотрудник с правами, поэтому он в списке остаётся.
  const employeeCompanies = useMemo(() => companies.filter(c => c.myRole !== 'owner'), [companies]);
  const activeEmployeeCompany = employeeCompanies[0] || null;
  const canBeEmployee = employeeCompanies.length > 0;

  // ГИБРИД-брендинг: у COMS фиксированный акцент ВЕЗДЕ. Цвет компании больше не
  // перекрашивает всё приложение — он живёт только как точка/метка внутри её админки/кабинета
  // (инлайн-стиль на .company-dot / .admin-company-dot). Здесь чистим старый глобальный override.
  useEffect(() => {
    const root = document.documentElement;
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
  }, []);

  // Тема интерфейса (тёмная/светлая), запоминается
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  const changeWorkMode = (m) => {
    setWorkMode(m);
    localStorage.setItem('workMode', m);
    localStorage.removeItem('businessMode');
  };

  const createCompany = async () => {
    const name = newCompanyName.trim();
    if (name.length < 2) { setProfileMsg('Название: минимум 2 символа'); setTimeout(() => setProfileMsg(''), 2500); return; }
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/companies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      });
      const d = await resp.json();
      if (resp.ok) { setNewCompanyName(''); setCompanies(prev => [{ ...d.company, myRole: 'owner' }, ...prev]); setProfileMsg('Компания создана'); }
      else setProfileMsg(d.message || 'Ошибка');
    } catch { setProfileMsg('Ошибка сети'); }
    setTimeout(() => setProfileMsg(''), 2500);
  };

  const inviteToCompany = async (slug) => {
    const uname = (companyInvite[slug] || '').trim();
    if (!uname) return;
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/companies/${slug}/invite`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: uname, role: 'member' }),
      });
      const d = await resp.json();
      if (resp.ok) { setCompanyInvite(p => ({ ...p, [slug]: '' })); fetchCompanies(); setProfileMsg(d.message); }
      else setProfileMsg(d.message || 'Ошибка');
    } catch { setProfileMsg('Ошибка сети'); }
    setTimeout(() => setProfileMsg(''), 2500);
  };

  const removeCompanyMember = async (slug, username) => {
    const token = localStorage.getItem('token');
    try {
      await fetch(`${SERVER_URL}/companies/${slug}/members/${encodeURIComponent(username)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      fetchCompanies();
    } catch {}
  };

  const setCompanyAccent = async (slug, accent) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/companies/${slug}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ accent }),
      });
      if (resp.ok) setCompanies(prev => prev.map(c => c.slug === slug ? { ...c, accent } : c));
    } catch {}
  };

  const deleteCompany = async (slug) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`${SERVER_URL}/companies/${slug}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) setCompanies(prev => prev.filter(c => c.slug !== slug));
    } catch {}
  };

  // ── Админ-панель компании ──
  const [adminPanel, setAdminPanel] = useState(null); // { slug, ...company }
  const [adminTab, setAdminTab] = useState('overview');
  const [adminStats, setAdminStats] = useState(null);
  const [adminRooms, setAdminRooms] = useState([]);
  const [adminRecordings, setAdminRecordings] = useState([]);
  const [adminAudit, setAdminAudit] = useState([]);
  const [adminMeetings, setAdminMeetings] = useState([]);
  const [adminAnalytics, setAdminAnalytics] = useState(null);
  const [adminDepartments, setAdminDepartments] = useState([]);
  const [newDepName, setNewDepName] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [newMeeting, setNewMeeting] = useState({ title: '', at: '' });
  const [upcomingMeetings, setUpcomingMeetings] = useState([]); // главный экран

  // ── Кабинет сотрудника ──
  const [empPanel, setEmpPanel] = useState(false);
  const [empTab, setEmpTab] = useState('overview');
  const [empSlug, setEmpSlug] = useState(null);
  const [empCompany, setEmpCompany] = useState(null); // { ...company, myRole, members, departments }
  const [empMe, setEmpMe] = useState(null);            // { me, activity }
  const [empRooms, setEmpRooms] = useState([]);
  const [empMeetings, setEmpMeetings] = useState([]);

  const apiGet = async (path) => {
    const token = localStorage.getItem('token');
    const r = await fetch(`${SERVER_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? r.json() : null;
  };
  const apiSend = async (path, method, body) => {
    const token = localStorage.getItem('token');
    const r = await fetch(`${SERVER_URL}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  };

  const openAdmin = async (company) => {
    setAdminPanel(company);
    setAdminTab('overview');
    const d = await apiGet(`/companies/${company.slug}/stats`);
    if (d) setAdminStats(d);
  };
  const closeAdmin = () => { setAdminPanel(null); setAdminStats(null); setAdminRooms([]); setAdminRecordings([]); setAdminAudit([]); setAdminAnalytics(null); setAdminDepartments([]); };

  useEffect(() => {
    if (!adminPanel) return;
    const s = adminPanel.slug;
    if (adminTab === 'overview') apiGet(`/companies/${s}/stats`).then(d => d && setAdminStats(d));
    if (adminTab === 'rooms') apiGet(`/companies/${s}/rooms`).then(d => d && setAdminRooms(d.rooms || []));
    if (adminTab === 'recordings') apiGet(`/companies/${s}/recordings`).then(d => d && setAdminRecordings(d.recordings || []));
    if (adminTab === 'audit') apiGet(`/companies/${s}/audit`).then(d => d && setAdminAudit(d.log || []));
    if (adminTab === 'meetings') apiGet(`/companies/${s}/meetings`).then(d => d && setAdminMeetings(d.meetings || []));
    if (adminTab === 'analytics') apiGet(`/companies/${s}/analytics`).then(d => d && setAdminAnalytics(d));
    if (adminTab === 'departments' || adminTab === 'members') apiGet(`/companies/${s}/departments`).then(d => d && setAdminDepartments(d.departments || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminPanel, adminTab]);

  // ближайшие встречи компаний — на главном экране
  const fetchUpcomingMeetings = useCallback(async () => {
    const d = await apiGet('/companies/meetings/upcoming');
    if (d) setUpcomingMeetings(d.meetings || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (authUser && companies.length) fetchUpcomingMeetings(); }, [authUser, companies.length, fetchUpcomingMeetings]);

  const scheduleMeeting = async () => {
    if (newMeeting.title.trim().length < 2 || !newMeeting.at) { setProfileMsg('Заполните название и время'); setTimeout(()=>setProfileMsg(''),2500); return; }
    const { ok, data } = await apiSend(`/companies/${adminPanel.slug}/meetings`, 'POST', { title: newMeeting.title.trim(), scheduledAt: new Date(newMeeting.at).toISOString() });
    if (ok) { setNewMeeting({ title: '', at: '' }); setAdminMeetings(prev => [...prev, data.meeting].sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt))); fetchUpcomingMeetings(); }
    else { setProfileMsg(data.message || 'Ошибка'); setTimeout(()=>setProfileMsg(''),2500); }
  };
  const deleteMeeting = async (id) => {
    await apiSend(`/companies/${adminPanel.slug}/meetings/${id}`, 'DELETE');
    setAdminMeetings(prev => prev.filter(m => m.id !== id));
    fetchUpcomingMeetings();
  };
  const joinMeeting = (m) => {
    inviteKeyRef.current = m.inviteKey;
    setRoomId(m.roomSlug);
    closeAdmin();
    setIsAccountPanelOpen(false);
    setStatus(`Встреча «${m.title}» — нажмите «Войти в комнату»`);
  };

  const refreshAdminCompany = async () => {
    const d = await apiGet(`/companies/${adminPanel.slug}`);
    if (d?.company) { setAdminPanel({ ...d.company, slug: adminPanel.slug }); setCompanies(prev => prev.map(c => c.slug === adminPanel.slug ? { ...c, ...d.company } : c)); }
  };
  const changeMemberRole = async (username, role) => {
    await apiSend(`/companies/${adminPanel.slug}/members/${encodeURIComponent(username)}`, 'PATCH', { role });
    refreshAdminCompany();
  };
  const adminRemoveMember = async (username) => {
    await apiSend(`/companies/${adminPanel.slug}/members/${encodeURIComponent(username)}`, 'DELETE');
    refreshAdminCompany();
  };
  const adminInvite = async (username, role = 'member') => {
    const { ok, data } = await apiSend(`/companies/${adminPanel.slug}/invite`, 'POST', { username, role });
    setProfileMsg(ok ? data.message : (data.message || 'Ошибка'));
    setTimeout(() => setProfileMsg(''), 2500);
    if (ok) refreshAdminCompany();
  };
  const updatePolicy = async (patch) => {
    const { ok, data } = await apiSend(`/companies/${adminPanel.slug}`, 'PATCH', patch);
    if (ok) { setAdminPanel(p => ({ ...p, ...data.company })); setCompanies(prev => prev.map(c => c.slug === adminPanel.slug ? { ...c, ...data.company } : c)); }
  };
  const createDepartment = async () => {
    const name = newDepName.trim();
    if (name.length < 2) { setProfileMsg('Название отдела: 2+ символа'); setTimeout(()=>setProfileMsg(''),2000); return; }
    const { ok, data } = await apiSend(`/companies/${adminPanel.slug}/departments`, 'POST', { name });
    if (ok) { setNewDepName(''); setAdminDepartments(prev => [...prev, { id: data.department.id, name: data.department.name, head: null, count: 0 }]); }
    else { setProfileMsg(data.message || 'Ошибка'); setTimeout(()=>setProfileMsg(''),2000); }
  };
  const deleteDepartment = async (id) => {
    await apiSend(`/companies/${adminPanel.slug}/departments/${id}`, 'DELETE');
    setAdminDepartments(prev => prev.filter(d => d.id !== id));
    refreshAdminCompany();
  };
  const setDepartmentHead = async (id, head) => {
    await apiSend(`/companies/${adminPanel.slug}/departments/${id}`, 'PATCH', { head });
    setAdminDepartments(prev => prev.map(d => d.id === id ? { ...d, head } : d));
  };
  const setMemberProfile = async (username, patch) => {
    const { ok } = await apiSend(`/companies/${adminPanel.slug}/members/${encodeURIComponent(username)}/profile`, 'PATCH', patch);
    if (ok) { refreshAdminCompany(); apiGet(`/companies/${adminPanel.slug}/departments`).then(d => d && setAdminDepartments(d.departments || [])); }
  };
  const createCompanyRoom = async () => {
    const name = newRoomName.trim() || 'Переговорка';
    const { ok, data } = await apiSend(`/companies/${adminPanel.slug}/rooms`, 'POST', { name });
    if (ok) { setNewRoomName(''); setAdminRooms(prev => [data.room, ...prev]); }
    else { setProfileMsg(data.message || 'Ошибка'); setTimeout(() => setProfileMsg(''), 2500); }
  };
  const deleteCompanyRoom = async (roomSlug) => {
    await apiSend(`/companies/${adminPanel.slug}/rooms/${roomSlug}`, 'DELETE');
    setAdminRooms(prev => prev.filter(r => r.slug !== roomSlug));
  };
  const enterCompanyRoom = (room) => {
    inviteKeyRef.current = room.inviteKey;
    setRoomId(room.slug);
    closeAdmin();
    setIsAccountPanelOpen(false);
    setStatus(`Комната «${room.name}» готова — нажмите «Войти в комнату»`);
  };

  // ── Кабинет сотрудника ──
  const openEmployee = () => {
    const slug = activeEmployeeCompany?.slug;
    if (!slug) return;
    setEmpSlug(slug);
    setEmpTab('overview');
    setEmpPanel(true);
  };
  const closeEmployee = () => { setEmpPanel(false); setEmpCompany(null); setEmpMe(null); setEmpRooms([]); setEmpMeetings([]); };

  useEffect(() => {
    if (!empPanel || !empSlug) return;
    apiGet(`/companies/${empSlug}`).then(d => d?.company && setEmpCompany(d.company));
    apiGet(`/companies/${empSlug}/me`).then(d => d && setEmpMe(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empPanel, empSlug]);

  useEffect(() => {
    if (!empPanel || !empSlug) return;
    if (empTab === 'rooms') apiGet(`/companies/${empSlug}/rooms`).then(d => d && setEmpRooms(d.rooms || []));
    if (empTab === 'meetings') apiGet(`/companies/${empSlug}/meetings`).then(d => d && setEmpMeetings(d.meetings || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empPanel, empSlug, empTab]);

  const enterEmployeeRoom = (room) => {
    inviteKeyRef.current = room.inviteKey;
    setRoomId(room.slug);
    closeEmployee();
    setIsAccountPanelOpen(false);
    setStatus(`Комната «${room.name}» готова — нажмите «Войти в комнату»`);
  };
  const joinEmployeeMeeting = (m) => {
    inviteKeyRef.current = m.inviteKey;
    setRoomId(m.roomSlug);
    closeEmployee();
    setIsAccountPanelOpen(false);
    setStatus(`Встреча «${m.title}» — нажмите «Войти в комнату»`);
  };

  // Комната ожидания: ведущий впускает/отклоняет
  const admitWaiter = (w) => {
    socket.emit('wait-admit', { roomId: roomIdRef.current, socketId: w.socketId, userId: w.userId });
    setWaitingList(prev => prev.filter(x => x.socketId !== w.socketId));
  };
  const denyWaiter = (w) => {
    socket.emit('wait-deny', { roomId: roomIdRef.current, socketId: w.socketId });
    setWaitingList(prev => prev.filter(x => x.socketId !== w.socketId));
  };
  const cancelWaiting = () => {
    setWaitingForHost(false);
    waitingRetryRef.current = null;
    setStatus('Вы вышли из приёмной');
  };

  // кик участника (модерация, для владельца комнаты)
  const kickParticipant = async (identity) => {
    const token = localStorage.getItem('token');
    try {
      await fetch(`${SERVER_URL}/rooms/moderate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roomId: roomIdRef.current, targetIdentity: identity, action: 'remove' }),
      });
      setStatus('Участник удалён из звонка');
    } catch { setStatus('Не удалось удалить участника'); }
  };

  // Мои комнаты (вкладка в аккаунте)
  const fetchMyRooms = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setMyRoomsLoading(true);
    try {
      const resp = await fetch(`${SERVER_URL}/rooms/my`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        setMyRooms(data.rooms || []);
      }
    } catch {}
    finally { setMyRoomsLoading(false); }
  }, []);

  useEffect(() => {
    if (isAccountPanelOpen && accountTab === 'rooms') fetchMyRooms();
  }, [isAccountPanelOpen, accountTab, fetchMyRooms]);

  const deleteRoom = async (slug) => {
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) setMyRooms(prev => prev.filter(r => r.slug !== slug));
    } catch {}
  };

  const copyRoomLinkFor = async (room) => {
    try {
      const key = room.isPrivate && room.inviteKey ? room.inviteKey : null;
      await navigator.clipboard.writeText(buildInviteLink(room.slug, key));
      setProfileMsg('Ссылка скопирована');
      setTimeout(() => setProfileMsg(''), 2000);
    } catch {}
  };

  // Сохранить отображаемое имя
  const saveDisplayName = async () => {
    const name = editName.trim();
    if (!name) return;
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/auth/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ display_name: name }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setAuthUser(prev => ({ ...prev, displayName: data.display_name }));
        setUserName(data.display_name);
        setProfileMsg('Имя сохранено');
      } else {
        setProfileMsg(data.message || 'Ошибка');
      }
    } catch {
      setProfileMsg('Ошибка сети');
    }
    setTimeout(() => setProfileMsg(''), 2500);
  };

  // Загрузка аватарки: сжимаем в 256x256 JPEG на клиенте
  const uploadAvatar = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const img = new Image();
    img.onload = async () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // вписываем квадрат по центру
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
      try {
        const token = localStorage.getItem('token');
        const resp = await fetch(`${SERVER_URL}/auth/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ dataUrl }),
        });
        const data = await resp.json();
        if (resp.ok) {
          setAuthUser(prev => ({ ...prev, avatarUrl: data.avatar_url }));
          setProfileMsg('Аватар обновлён');
        } else {
          setProfileMsg(data.message || 'Ошибка загрузки');
        }
      } catch {
        setProfileMsg('Ошибка сети');
      }
      setTimeout(() => setProfileMsg(''), 2500);
    };
    img.src = URL.createObjectURL(file);
  };

  // Инфо о комнате: приватность, права (с задержкой при вводе)
  useEffect(() => {
    if (!authUser || !roomId.trim()) { setRoomInfo(null); return; }
    const timer = setTimeout(async () => {
      try {
        const token = localStorage.getItem('token');
        const resp = await fetch(`${SERVER_URL}/rooms/info/${encodeURIComponent(roomId.trim())}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          setRoomInfo(data.exists ? data : null);
        }
      } catch { setRoomInfo(null); }
    }, 400);
    return () => clearTimeout(timer);
  }, [roomId, authUser]);

  const createPrivateRoom = async (opts = {}) => {
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/rooms/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: opts.name || `Комната ${userName.trim() || 'без имени'}`,
          isPrivate: opts.isPrivate ?? true,
          waitingRoom: !!opts.waitingRoom,
          muteOnJoin: !!opts.muteOnJoin,
          companyId: opts.companyId || undefined,
        }),
      });
      if (!resp.ok) { setStatus('Не удалось создать комнату'); return null; }
      const { room } = await resp.json();
      inviteKeyRef.current = room.inviteKey;
      setRoomId(room.slug);
      setRoomInfo({ exists: true, name: room.name, isPrivate: room.isPrivate, isOwner: true, hasAccess: true, waitingRoom: room.waitingRoom, muteOnJoin: room.muteOnJoin, members: [], inviteKey: room.inviteKey });
      setStatus(room.waitingRoom ? 'Комната с приёмной создана — отправьте ссылку' : 'Приватная комната создана — отправьте ссылку приглашённым');
      return room;
    } catch {
      setStatus('Не удалось создать комнату');
      return null;
    }
  };

  // ── Контакты ──
  const fetchContacts = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const resp = await fetch(`${SERVER_URL}/contacts`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        setContacts(data.contacts || []);
      }
    } catch {}
  }, []);

  useEffect(() => { if (authUser) fetchContacts(); }, [authUser, fetchContacts]);

  // Глобальный поиск людей (с задержкой при вводе)
  useEffect(() => {
    const q = contactSearch.trim();
    if (q.length < 2) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const token = localStorage.getItem('token');
        const resp = await fetch(`${SERVER_URL}/contacts/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          setSearchResults(data.users || []);
        }
      } catch {}
    }, 400);
    return () => clearTimeout(timer);
  }, [contactSearch]);

  const addContact = async (username) => {
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username }),
      });
      if (resp.ok) {
        fetchContacts();
        setContactSearch('');
        setSearchResults([]);
      }
    } catch {}
  };

  const removeContact = async (username) => {
    try {
      const token = localStorage.getItem('token');
      await fetch(`${SERVER_URL}/contacts/${encodeURIComponent(username)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setContacts(prev => prev.filter(c => c.contactUsername !== username));
    } catch {}
  };

  // Позвонить контакту: создаём приватную комнату, зовём его и заходим сами
  const callContact = async (username) => {
    if (call) return;                                    // уже звоним — второй клик игнорируем
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`${SERVER_URL}/rooms/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username }),
      });
      if (!resp.ok) { setCallNotice('Не удалось создать звонок'); return; }
      const { room } = await resp.json();
      // Комнату создаём, но НЕ входим: пока не ответили, это дозвон, а не
      // разговор. Иначе тикал таймер и писалась тишина в пустой комнате.
      setCall({
        role: 'out', phase: 'ringing', peer: username, peerName: username,
        roomSlug: room.slug, inviteKey: room.inviteKey,
      });
      socket.emit('call-start', {
        toUsername: username,
        roomSlug: room.slug,
        inviteKey: room.inviteKey,
        fromName: userName.trim() || authUser?.username,
      });
    } catch {
      setCallNotice('Не удалось создать звонок');
    }
  };

  // Вошли в комнату — экран дозвона больше не нужен
  useEffect(() => { if (joined) setCall(null); }, [joined]);

  // Обратный отсчёт: человек должен видеть, что звонок не будет ждать вечно
  useEffect(() => {
    if (call?.phase !== 'ringing') { setCallLeft(0); return; }
    setCallLeft(45);
    const id = setInterval(() => setCallLeft(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [call?.callId, call?.phase]);

  // Гудки и вибрация. Без звука входящий звонок просто пропускают.
  useEffect(() => {
    if (call?.phase !== 'ringing') return;
    return startRingTone(call.role === 'in' ? 'in' : 'out');
  }, [call?.callId, call?.phase, call?.role]);

  useEffect(() => {
    if (!callNotice) return;
    const id = setTimeout(() => setCallNotice(''), 4000);
    return () => clearTimeout(id);
  }, [callNotice]);

  const acceptCall = async () => {
    const c = call;
    if (!c || c.role !== 'in') return;
    socket.emit('call-accept', { callId: c.callId });
    // Обязательно выйти из текущего звонка: иначе микрофон остаётся в старой
    // комнате и прежние собеседники продолжают нас слышать.
    if (joined) await leaveCall();
    setCall({ ...c, phase: 'connecting' });
    inviteKeyRef.current = c.inviteKey;
    setRoomId(c.roomSlug);
    joinRoomWith(c.roomSlug, c.inviteKey);
  };

  const declineCall = () => {
    if (call?.callId) socket.emit('call-decline', { callId: call.callId });
    setCall(null);
  };

  const cancelCall = () => {
    if (call?.callId) socket.emit('call-cancel', { callId: call.callId });
    setCall(null);
  };

  // ── Постучаться в приватную комнату ──
  const startKnock = (slug) => {
    setKnocking(true);
    setStatus('Запрос отправлен — ждём, когда владелец впустит...');
    socket.emit('knock', { roomId: slug, username: authUser?.username, name: userName.trim() });
    let attempts = 0;
    clearInterval(knockTimerRef.current);
    knockTimerRef.current = setInterval(async () => {
      attempts++;
      if (attempts > 20) {
        clearInterval(knockTimerRef.current);
        setKnocking(false);
        setStatus('Владелец не ответил. Попросите ссылку-приглашение.');
        return;
      }
      try {
        const token = localStorage.getItem('token');
        const resp = await fetch(`${SERVER_URL}/rooms/info/${encodeURIComponent(slug)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.exists && data.hasAccess) {
            clearInterval(knockTimerRef.current);
            setKnocking(false);
            setStatus('Вас впустили!');
            joinRoomWith(slug, null);
          }
        }
      } catch {}
    }, 3000);
  };

  useEffect(() => () => clearInterval(knockTimerRef.current), []);

  // Владелец впускает постучавшегося
  const approveKnock = async () => {
    if (!knockRequest) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${SERVER_URL}/rooms/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug: knockRequest.roomId, username: knockRequest.username }),
      });
      addAction(`✅ ${knockRequest.name || knockRequest.username} впущен в комнату`);
    } catch {}
    setKnockRequest(null);
  };

  // Action messages (join/leave/applause) — auto-disappear after 4s
  const addAction = useCallback((msg) => {
    const id = Date.now();
    setActionMessages(prev => [...prev.slice(-4), { id, msg }]);
    setTimeout(() => setActionMessages(prev => prev.filter(m => m.id !== id)), 4000);
  }, []);

  // всплывающая эмодзи-реакция на экране
  const showFloatingReaction = useCallback((emoji) => {
    const id = Date.now() + Math.random();
    const x = 10 + Math.random() * 80; // % от ширины
    setFloatingReactions(prev => [...prev.slice(-14), { id, emoji, x }]);
    setTimeout(() => setFloatingReactions(prev => prev.filter(r => r.id !== id)), 3000);
  }, []);

  // Chat via Socket.IO
  useEffect(() => {
    socket.on('chat-message', (message) => {
      setMessages(prev => [...prev, message]);
    });

    socket.on('sound', ({ soundId, fromUser, toUser }) => {
      const s = SOUNDS.find(x => x.id === soundId);
      const emoji = s?.emoji ?? '🔔';
      const label = s?.label ?? soundId;
      const msg = toUser
        ? `${emoji} ${fromUser} респектанул ${toUser} — ${label}`
        : `${emoji} ${fromUser} включил ${label}`;
      addAction(msg);
      const audio = soundRefs.current[soundId];
      if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
    });

    socket.on('room-full', () => {
      setStatus('Комната заполнена — максимум 10 участников');
    });

    socket.on('call-incoming', (c) => {
      setCall({
        role: 'in', phase: 'ringing', callId: c.callId,
        peer: c.from, peerName: c.fromName || c.from,
        roomSlug: c.roomSlug, inviteKey: c.inviteKey,
      });
    });
    socket.on('call-ringing', ({ callId }) => setCall(p => (p ? { ...p, callId } : p)));
    socket.on('call-accepted', ({ roomSlug, inviteKey }) => {
      setCall(p => (p ? { ...p, phase: 'connecting' } : p));
      inviteKeyRef.current = inviteKey;
      setRoomId(roomSlug);
      joinRoomWithRef.current?.(roomSlug, inviteKey);
    });
    socket.on('call-ended', ({ reason }) => {
      setCall(null);
      setCallNotice(CALL_END_TEXT[reason] || 'Звонок завершён');
    });
    socket.on('knock', (req) => setKnockRequest(req));

    socket.on('recording-state', ({ active, by }) => {
      setRecActive(active);
      setRecStartedBy(active ? by : null);
      addAction(active ? `⏺ ${by} включил запись звонка` : '⏹ Запись остановлена');
    });

    socket.on('reaction', ({ emoji, fromName }) => {
      showFloatingReaction(emoji);
      if (emoji === '✋') addAction(`✋ ${fromName} поднял руку`);
    });

    // Комната ожидания
    socket.on('wait-knock', (req) => setWaitingList(prev => prev.some(w => w.socketId === req.socketId) ? prev : [...prev, req]));
    socket.on('wait-admitted', () => {
      const r = waitingRetryRef.current;
      setWaitingForHost(false);
      if (r) { setStatus('Вас впустили — подключаемся…'); joinRoomWith(r.slug, r.key); }
    });
    socket.on('wait-denied', () => {
      setWaitingForHost(false);
      waitingRetryRef.current = null;
      setStatus('Ведущий отклонил ваш вход');
    });

    return () => {
      socket.off('chat-message');
      socket.off('sound');
      socket.off('room-full');
      socket.off('recording-state');
      socket.off('reaction');
      socket.off('wait-knock');
      socket.off('wait-admitted');
      socket.off('wait-denied');
      socket.off('call-incoming');
      socket.off('call-ringing');
      socket.off('call-accepted');
      socket.off('call-ended');
      socket.off('knock');
    };
  }, [addAction, showFloatingReaction]);

  // Сообщаем серверу, кто мы — для входящих звонков (и после переподключений)
  useEffect(() => {
    if (!authUser?.username) return;
    const announce = () => socket.emit('presence', { username: authUser.username });
    announce();
    socket.on('connect', announce);
    return () => socket.off('connect', announce);
  }, [authUser]);

  // Persist and apply volumes
  useEffect(() => { localStorage.setItem('vol_master', masterVolume); }, [masterVolume]);
  useEffect(() => { localStorage.setItem('vol_applause', applauseVolume); }, [applauseVolume]);
  useEffect(() => { localStorage.setItem('vol_users', usersVolume); }, [usersVolume]);
  useEffect(() => { localStorage.setItem('autoCamera', autoEnableCamera); }, [autoEnableCamera]);

  // Apply applause/sound volumes
  useEffect(() => {
    const v = (applauseVolume / 100) * (masterVolume / 100);
    SOUNDS.forEach(s => {
      const a = soundRefs.current[s.id];
      if (a) a.volume = v;
    });
  }, [applauseVolume, masterVolume]);

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

  const joinRoom = () => joinRoomWith(roomId.trim(), inviteKeyRef.current);

  // Гость подтвердил имя — сразу заводим его в звонок, без промежуточного экрана.
  // userName к этому моменту уже проставлен (пустая строка = сервер даст «Гость N»).
  useEffect(() => {
    if (!guestMode || joined || joiningRef.current) return;
    joinRoomWith(guestInvite.room, guestInvite.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guestMode]);

  // Обработчики сокета регистрируются один раз, поэтому свежую ссылку на
  // joinRoomWith держим в ref: иначе при ответе на звонок сработает версия
  // с первого рендера — с пустым именем и без авторизации.
  const joinRoomWithRef = useRef(null);

  const joinRoomWith = async (slug, key) => {
    // пустые поля — объясняем, а не молчим
    if (!slug) { setStatus('Введите ID комнаты'); return; }
    // гость мог нажать «Пропустить» — тогда имя присвоит сервер («Гость N»)
    if (!guestMode && !userName.trim()) { setStatus('Введите ваше имя'); return; }
    if (joined || joiningRef.current) return;
    if (slug !== roomId) setRoomId(slug);
    joiningRef.current = true;
    setStatus('Получаем токен...');

    // Если старая комната ещё существует — сначала отключаемся
    if (livekitRoomRef.current) {
      try {
        livekitRoomRef.current.removeAllListeners();
        await livekitRoomRef.current.disconnect();
      } catch {}
      livekitRoomRef.current = null;
      await new Promise(r => setTimeout(r, 500));
    }

    try {
      const authToken = localStorage.getItem('token');
      const tokenController = new AbortController();
      const tokenTimeout = setTimeout(() => tokenController.abort(), 15000);
      let resp;
      try {
        // гость идёт по отдельному маршруту: без аккаунта, строго по ключу из ссылки
        resp = guestMode
          ? await fetch(`${SERVER_URL}/rooms/guest-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roomId: slug,
              key: key || undefined,
              name: userName.trim() || undefined,
              guestId: guestIdRef.current,
            }),
            signal: tokenController.signal,
          })
          : await fetch(`${SERVER_URL}/rooms/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ roomId: slug, key: key || undefined }),
            signal: tokenController.signal,
          });
      } catch (fetchErr) {
        if (fetchErr.name === 'AbortError') {
          throw new Error('Нет ответа от сервера — проверьте интернет-соединение');
        }
        throw new Error('Не удалось связаться с сервером — проверьте интернет-соединение');
      } finally {
        clearTimeout(tokenTimeout);
      }

      // комната ожидания — ведущий должен впустить
      if (resp.status === 202) {
        joiningRef.current = false;
        waitingRetryRef.current = { slug, key };
        setWaitingForHost(true);
        setStatus('Ожидаем, пока ведущий впустит вас…');
        socket.emit('wait-knock', {
          roomId: slug,
          name: userName.trim(),
          // у гостя нет аккаунта — представляемся временным id, его же проверит сервер
          userId: guestMode ? guestIdRef.current : authUser?.id,
        });
        return;
      }

      if (!resp.ok) {
        const err = await resp.json();
        // приватная комната без ссылки — стучимся владельцу
        if (resp.status === 403 && err.needKnock) {
          joiningRef.current = false;
          startKnock(slug);
          return;
        }
        joiningRef.current = false;
        setStatus(`Ошибка: ${err.message}`);
        return;
      }

      const { token: lkToken, wsUrl, ice } = await resp.json();

      // TURN-креды приходят вместе с токеном комнаты и живут несколько часов.
      // Постоянного пароля в бандле больше нет — иначе TURN мог использовать любой.
      const iceServers = Array.isArray(ice) && ice.length
        ? ice
        : [{ urls: 'stun:stun.l.google.com:19302' }];

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 640, height: 360, frameRate: 15 },
        },
        // чистый звук: эхо/шумоподавление + авто-громкость (важно и для речи, и для транскрибации)
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
        publishDefaults: {
          simulcast: false,
          videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
          videoSimulcastLayers: [],
          // аудио: битрейт выше дефолтного (чище речь), без DTX (не режет тихую речь),
          // RED — устойчивость к потере пакетов
          audioPreset: { maxBitrate: 48_000 },
          dtx: false,
          red: true,
        },
        webRTCConfig: {
          iceServers,
          // all = прямое UDP-соединение с LiveKit (низкая задержка), TURN только как
          // запасной путь. НЕ relay: форс-релей по TCP копит буфер → звук отстаёт, видео сыпется
          iceTransportPolicy: 'all',
        },
      });
      livekitRoomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        joiningRef.current = false;
        setJoined(true);
        setCallStartedAt(Date.now());
        setStatus('Подключено');
        revealControls();
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
        setStatus(`${displayName(p)} подключился`);
        playChime(true);
        forceUpdate();
      });

      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        setStatus(`${displayName(p)} отключился`);
        playChime(false);
        forceUpdate();
      });

      // подсветка говорящих + своё качество соединения
      room.on(RoomEvent.ActiveSpeakersChanged, forceUpdate);
      room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant === room.localParticipant) {
          setConnQuality(
            quality === ConnectionQuality.Excellent ? 'excellent'
            : quality === ConnectionQuality.Good ? 'good' : 'poor');
        }
      });

      // Публикация и снятие публикации — то, по чему раскладка решает, есть
      // у человека камера или он уходит квадратиком вниз. Без этих двух
      // событий участник, включивший камеру позже всех, оставался внизу.
      room.on(RoomEvent.TrackPublished, forceUpdate);
      room.on(RoomEvent.TrackUnpublished, forceUpdate);
      room.on(RoomEvent.TrackSubscribed, forceUpdate);
      room.on(RoomEvent.TrackUnsubscribed, forceUpdate);
      room.on(RoomEvent.LocalTrackPublished, forceUpdate);
      room.on(RoomEvent.LocalTrackUnpublished, forceUpdate);
      room.on(RoomEvent.TrackMuted, forceUpdate);
      room.on(RoomEvent.TrackUnmuted, forceUpdate);

      // пока идёт запись — шлём серверу, кто говорит (для разметки транскрипта по никам)
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        if (!recActiveRef.current) return;
        const s = speakers && speakers[0];
        if (s) socket.emit('rec-speaker', { roomId: roomIdRef.current, speaker: displayName(s) });
      });

      setStatus('Подключаемся...');
      // Повторяем не только на 503 (лимит узла LiveKit, ещё не истёкший
      // departure_timeout), но и на срыве самого соединения: на мобильном
      // интернете рукопожатие иногда не успевает, и раньше это была
      // окончательная ошибка с английским текстом вместо новой попытки.
      let connectAttempts = 0;
      while (true) {
        try {
          await room.connect(wsUrl, lkToken, {
            websocketTimeout: 20000,
            peerConnectionTimeout: 20000,
          });
          break;
        } catch (connErr) {
          if (isRetriableConnect(connErr) && connectAttempts < 4) {
            connectAttempts++;
            setStatus(`Не дозвонились до сервера, повтор ${connectAttempts}/4...`);
            await new Promise(r => setTimeout(r, 2000 * connectAttempts));
          } else {
            throw connErr;
          }
        }
      }

      setStatus('Включаем микрофон...');
      try {
        if (autoEnableCamera) {
          await room.localParticipant.enableCameraAndMicrophone();
        } else {
          await room.localParticipant.setMicrophoneEnabled(true);
        }
        // Событие Connected приходит раньше, чем включается микрофон,
        // поэтому статус нужно вернуть сюда — иначе на экране навсегда
        // остаётся «Включаем микрофон…».
        setStatus('Подключено');
      } catch (camErr) {
        console.warn('Camera/mic error:', camErr);
        let micOk = false;
        try { await room.localParticipant.setMicrophoneEnabled(true); micOk = true; } catch { /* микрофон тоже закрыт */ }
        const denied = camErr?.name === 'NotAllowedError' || camErr?.name === 'SecurityError';
        if (denied && !micOk) setMediaBlocked(true);
        setStatus(micOk ? 'Камера недоступна — только микрофон' : 'Нет доступа к камере и микрофону');
      }

      // политика «выключать микрофон при входе» (для гостей, не для владельца)
      if (roomInfo?.muteOnJoin && !roomInfo?.isOwner) {
        try { await room.localParticipant.setMicrophoneEnabled(false); setIsMuted(true); } catch {}
      }
      forceUpdate();

      socket.emit('join-room', { roomId: slug, userName: userName.trim(), userId: authUser?.id });
      checkRecordingStatus(slug);

    } catch (error) {
      console.error('joinRoom error:', error);
      setStatus(`Ошибка: ${humanConnectError(error)}`);
      // комнату оставлять нельзя: следующая попытка входа наткнётся на
      // полуживой объект и оборвётся ещё на подключении
      const dead = livekitRoomRef.current;
      livekitRoomRef.current = null;
      if (dead) { try { dead.removeAllListeners(); await dead.disconnect(); } catch { /* уже мёртвая */ } }
      joiningRef.current = false;
    }
  };

  joinRoomWithRef.current = joinRoomWith;

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
    setRecActive(false);
    setRecStartedBy(null);
    setBlurEnabled(false);
    setIsReactionsOpen(false);
    setConnQuality('excellent');
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
    // iPadOS 13+ маскируется под десктопный Mac — ловим по тач-экрану
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
    if (!isMobile) { setStatus('Переключение камеры доступно только на мобильных'); return; }
    if (isSharingScreen) { setStatus('Сначала остановите демонстрацию экрана'); return; }

    const room = livekitRoomRef.current;
    if (!room || !joined) return;
    const nextFront = !isFrontCamera;
    const facingMode = nextFront ? 'user' : 'environment';

    try {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const track = pub?.track;
      if (track && typeof track.restartTrack === 'function') {
        // перезапуск существующего трека с новой камерой — надёжно на мобильных
        await track.restartTrack({ facingMode });
      } else {
        // запасной путь, если трека почему-то нет
        await room.localParticipant.setCameraEnabled(false);
        await room.localParticipant.setCameraEnabled(true, { facingMode });
      }
      // флаг зеркала меняем ТОЛЬКО после успешного переключения
      setIsFrontCamera(nextFront);
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

    // iOS/iPadOS doesn't support getDisplayMedia at all
    if (IS_IOS && !isSharingScreen) {
      setStatus('Демонстрация экрана недоступна на iOS/iPadOS — ограничение Apple');
      return;
    }

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

  const sendSound = (soundId) => {
    const toUser = screenSharePresenter && screenSharePresenter !== livekitRoomRef.current?.localParticipant
      ? displayName(screenSharePresenter)
      : null;
    socket.emit('sound', { roomId: roomIdRef.current, soundId, fromUser: userName.trim(), toUser });
    setIsSoundsPanelOpen(false);
  };

  // отправить эмодзи-реакцию всем в комнате
  const sendReaction = (emoji) => {
    socket.emit('reaction', { roomId: roomIdRef.current, emoji, fromName: userName.trim() });
    setIsReactionsOpen(false);
  };

  // размытие фона (локальная камера); модуль тянем только по требованию
  const toggleBlur = async () => {
    const room = livekitRoomRef.current;
    if (!room || blurBusy) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track;
    if (!track) { setStatus('Сначала включите камеру'); return; }
    setBlurBusy(true);
    try {
      if (blurEnabled) {
        await track.stopProcessor();
        setBlurEnabled(false);
        setStatus('Размытие фона выключено');
      } else {
        if (!blurModuleRef.current) {
          blurModuleRef.current = await import('@livekit/track-processors');
        }
        const mod = blurModuleRef.current;
        if (mod.supportsBackgroundProcessors && !mod.supportsBackgroundProcessors()) {
          setStatus('Размытие фона не поддерживается этим браузером');
          return;
        }
        await track.setProcessor(mod.BackgroundBlur(10));
        setBlurEnabled(true);
        setStatus('Размытие фона включено');
      }
    } catch (e) {
      console.error('blur error:', e);
      setStatus('Размытие фона не поддерживается на этом устройстве');
    } finally {
      setBlurBusy(false);
    }
  };

  const toggleUserMute = useCallback((identity) => {
    setMutedUsers(prev => {
      const next = new Set(prev);
      next.has(identity) ? next.delete(identity) : next.add(identity);
      return next;
    });
  }, []);

  const muteAll = useCallback(() => {
    const room = livekitRoomRef.current;
    if (!room) return;
    const identities = Array.from(room.remoteParticipants.values()).map(p => p.identity);
    setMutedUsers(new Set(identities));
  }, []);

  const copyRoomLink = async () => {
    try {
      // для своей приватной комнаты добавляем ключ — по такой ссылке доступ автоматический
      const key = roomInfo?.isOwner && roomInfo?.inviteKey ? roomInfo.inviteKey : null;
      const link = buildInviteLink(roomId.trim(), key);
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setStatus('Не удалось скопировать ссылку');
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

  // тач-устройство (телефон/планшет) — для раскладки 1-на-1
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setIsTouchDevice(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);

  const PIP_MARGIN = 12;
  const SELF_W = 104, SELF_H = 148;
  // Перетаскивание своего окна. Тап отличаем от перетаскивания по смещению:
  // сдвинули меньше пяти пикселей — считаем тапом и увеличиваем окно.
  const onSelfPointerDown = (e) => {
    if (selfBig) return;                       // увеличенное окно не таскаем
    e.stopPropagation();
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const base = selfPos || { x: r.width - SELF_W - PIP_MARGIN, y: r.height - SELF_H - 150 };
    const start = { x: e.clientX, y: e.clientY, ox: base.x, oy: base.y, moved: false };
    setSelfDragging(true);
    const clampX = v => Math.min(Math.max(PIP_MARGIN, v), r.width - SELF_W - PIP_MARGIN);
    const clampY = v => Math.min(Math.max(PIP_MARGIN, v), r.height - SELF_H - PIP_MARGIN);
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) start.moved = true;
      setSelfPos({ x: clampX(start.ox + dx), y: clampY(start.oy + dy) });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSelfDragging(false);
      if (!start.moved) { setSelfBig(true); return; }
      // после отпускания прилипаем к ближайшему углу
      const lx = clampX(start.ox + (ev.clientX - start.x));
      const ly = clampY(start.oy + (ev.clientY - start.y));
      setSelfPos({
        x: lx < (r.width - SELF_W) / 2 ? PIP_MARGIN : r.width - SELF_W - PIP_MARGIN,
        y: ly < (r.height - SELF_H) / 2 ? PIP_MARGIN : r.height - SELF_H - PIP_MARGIN,
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ── Раскладка участников ──
  // Меряем сам контейнер, а не окно: в WKWebView 100vh врёт, а на повороте
  // приходят промежуточные размеры. Округляем и обновляем через rAF, иначе
  // ResizeObserver зацикливается на субпикселях.
  const stageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !window.ResizeObserver) return;
    let raf = 0;
    const ro = new ResizeObserver(([e]) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = e.contentRect;
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        setStageSize(p => (p.w === w && p.h === h ? p : { w, h }));
      });
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [joined]);

  const [pinnedId, setPinnedId] = useState(null);
  const [selfBig, setSelfBig] = useState(false);   // своё видео увеличено втрое
  useEffect(() => {
    if (pinnedId && !allParticipants.some(p => p.identity === pinnedId)) setPinnedId(null);
  }, [allParticipants, pinnedId]);

  // Пропорции потоков приходят от плиток: их можно узнать только измерив видео
  const [tileAspect, setTileAspect] = useState({});
  const onTileMeta = useCallback((id, aspect) => {
    if (!id) return;
    setTileAspect(prev => (prev[id] === aspect ? prev : { ...prev, [id]: aspect }));
  }, []);

  const localP = livekitRoomRef.current?.localParticipant;
  // Своё видео живёт в плавающем окне и в сетку не попадает никогда
  const remotes = allParticipants.filter(p => p !== localP);
  // Камера включена — это факт публикации у собеседника, и только он. Раньше
  // об этом сообщала сама плитка, и получался замкнутый круг: пока поток не
  // подписан, плитка говорила «камеры нет», её убирали из сетки, видеоэлемент
  // исчезал, adaptiveStream переставал подписывать поток — и человек навсегда
  // оставался квадратиком внизу, хотя камера у него работала.
  const hasCameraOn = (p) => {
    const pub = p.getTrackPublication(Track.Source.Camera);
    return Boolean(pub) && !pub.isMuted;
  };
  // Выключенная камера уходит из сетки вниз маленьким квадратом: она не
  // должна отнимать место у тех, кого действительно видно
  const visible = remotes.filter(hasCameraOn);
  const cameraOff = remotes.filter(p => !hasCameraOn(p));

  // «Главный + лента» — только на телефоне и только когда людей много
  const speakerMode = (isTouchDevice && visible.length >= SPEAKER_FROM) || Boolean(pinnedId);
  const mainParticipant = speakerMode
    ? (visible.find(p => p.identity === pinnedId) || visible[0])
    : null;
  const stripParticipants = speakerMode ? visible.filter(p => p !== mainParticipant) : [];

  const offRowH = cameraOff.length ? 64 + TILE_GAP : 0;
  const pack = packRows(
    visible.map(p => tileAspect[p.identity] || DEFAULT_ASPECT),
    stageSize.w,
    Math.max(stageSize.h - offRowH, 80),
  );

  // Find participant with active screen share
  const screenSharePresenter = useMemo(() => {
    return allParticipants.find(p => {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      return pub?.track && (p === livekitRoomRef.current?.localParticipant || pub.isSubscribed) && !pub.isMuted;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParticipants, renderTick]);

  // Позиция своего окна хранится в пикселях. При повороте экрана сцена
  // меняет размеры, и старые координаты уводили окно за границу — оно
  // просто пропадало из виду. Поэтому возвращаем его в видимую область.
  useEffect(() => {
    if (!selfPos || !stageSize.w || !stageSize.h) return;
    const x = Math.min(Math.max(PIP_MARGIN, selfPos.x), Math.max(PIP_MARGIN, stageSize.w - SELF_W - PIP_MARGIN));
    const y = Math.min(Math.max(PIP_MARGIN, selfPos.y), Math.max(PIP_MARGIN, stageSize.h - SELF_H - PIP_MARGIN));
    if (x !== selfPos.x || y !== selfPos.y) setSelfPos({ x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSize.w, stageSize.h]);

  if (!authChecked) return <div className="auth-page">Проверяем авторизацию...</div>;

  // сеть недоступна, но сессия сохранена — даём повторить без выхода из аккаунта
  if (authNetError && !authUser) {
    const altUrl = getAltDomainUrl();
    return (
      <div className="auth-page auth-retry">
        <div className="auth-retry-card">
          <div className="auth-retry-title">Нет связи с сервером</div>
          <div className="auth-retry-text">Похоже, интернет нестабилен. Ваш аккаунт на месте — попробуйте ещё раз.</div>
          <button className="primary-btn" onClick={() => { setAuthChecked(false); checkAuth(); }}>Повторить</button>
          {altUrl && (
            <div className="alt-domain-box">
              <div className="alt-domain-text">{ALT_DOMAIN_HINT}</div>
              <a className="ghost-btn alt-domain-btn" href={altUrl}>Открыть запасной вход</a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Пришли по полной ссылке-приглашению и аккаунта нет — предлагаем войти гостем.
  // Регистрация не нужна: имя можно ввести или пропустить (тогда «Гость N»).
  if (!authUser && !guestMode && hasGuestInvite && !guestDismissed) {
    const enterAsGuest = async (name) => {
      setGuestError('');
      setGuestBusy(true);
      try {
        const r = await fetch(
          `${SERVER_URL}/rooms/guest-info/${encodeURIComponent(guestInvite.room)}?key=${encodeURIComponent(guestInvite.key)}`,
        );
        const info = await r.json();
        if (!info.exists) { setGuestError('Комната не найдена — возможно, ссылка устарела'); return; }
        if (!info.guestAllowed) { setGuestError('Ссылка неполная или недействительна — попросите прислать её заново'); return; }
        setUserName(name);            // сервер подставит «Гость N», если пусто
        setRoomId(guestInvite.room);
        inviteKeyRef.current = guestInvite.key;
        setGuestMode(true);           // дальше вход выполнит эффект ниже
      } catch {
        setGuestError('Не удалось связаться с сервером — проверьте интернет');
      } finally {
        setGuestBusy(false);
      }
    };

    return (
      <div className="auth-shell">
        <div className="auth-header">
          <div className="brand">COMS</div>
          <div className="subtitle">присоединиться к звонку</div>
        </div>
        <div className="auth-card">
          <form
            className="auth-form"
            onSubmit={(e) => { e.preventDefault(); if (guestNameInput.trim()) enterAsGuest(guestNameInput.trim()); }}
          >
            <div className="auth-form-head">
              <h2>Вас пригласили в звонок</h2>
              <p>Аккаунт не нужен — представьтесь, и можно заходить.</p>
            </div>

            {guestError && <div className="auth-alert auth-alert-error">{guestError}</div>}

            <div className="field-group">
              <label htmlFor="guest-name">Ваше имя</label>
              <input
                id="guest-name"
                type="text"
                placeholder="Как вас представить участникам"
                value={guestNameInput}
                onChange={(e) => setGuestNameInput(e.target.value)}
                autoFocus
                maxLength={32}
              />
            </div>

            <div className="auth-actions">
              <button className="primary-btn" type="submit" disabled={guestBusy || !guestNameInput.trim()}>
                {guestBusy ? 'Подключаемся…' : 'Войти в звонок'}
              </button>
              <button className="ghost-btn" type="button" disabled={guestBusy} onClick={() => enterAsGuest('')}>
                Пропустить — войти как гость
              </button>
            </div>
          </form>
        </div>
        <div className="guest-login-hint">
          Есть аккаунт COMS?{' '}
          <button className="linklike" type="button" onClick={() => { inviteKeyRef.current = guestInvite.key; setGuestMode(false); setGuestDismissed(true); }}>
            Войти в аккаунт
          </button>
        </div>
      </div>
    );
  }

  // гостя дальше пропускаем: аккаунта у него нет, но доступ к звонку есть
  if (!authUser && !guestMode) {
    return (
      <AuthPage
        onLoginSuccess={(user) => {
          setAuthUser(user);
          setUserName(user.displayName || user.username || 'Иван');
          setRoomId(prev => prev || `${user.username}-${Math.floor(100 + Math.random() * 900)}`);
          setAuthError('');
        }}
        authError={authError}
      />
    );
  }

  // Аккаунт помечен на удаление: пользоваться приложением нельзя, пока
  // человек не передумает. Так ревьюер Apple видит, что удаление настоящее.
  if (authUser?.deletionRequestedAt) {
    const purge = authUser.purgeAt ? new Date(authUser.purgeAt) : null;
    return (
      <div className="app-shell deletion-shell">
        <div className="deletion-card">
          <h1 className="deletion-title">Аккаунт удаляется</h1>
          <p className="deletion-text">
            Мы получили запрос на удаление вашего аккаунта Voyage. Доступ к звонкам,
            записям и контактам закрыт.
          </p>
          <p className="deletion-text">
            {purge
              ? <>Данные будут стёрты навсегда <b>{purge.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '')}</b>. До этого дня удаление можно отменить.</>
              : <>Данные будут стёрты через 30 дней. До этого срока удаление можно отменить.</>}
          </p>
          <div className="deletion-actions">
            <button className="primary-btn" onClick={restoreAccount} disabled={delBusy}>
              {delBusy ? 'Восстанавливаем…' : 'Восстановить аккаунт'}
            </button>
            <button
              className="ghost-btn"
              onClick={() => { localStorage.removeItem('token'); setAuthUser(null); }}
            >
              Выйти
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Helper: format duration in seconds → "X ч Y мин Z сек"
  const fmtDuration = (sec) => {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h} ч ${m} мин`;
    return m > 0 ? `${m} мин ${s} сек` : `${s} сек`;
  };

  // Переключатель режима работы (обычный / бизнес / сотрудник).
  // «Сотрудник» недоступен, если нет компаний, где вы наняты (владелец своей компании — не её сотрудник).
  const empDisabledHint = companies.length
    ? 'Вы владелец своей компании — управляйте ей в режиме «Бизнес»'
    : 'Вас пока не добавили сотрудником ни в одну компанию';
  const modeSelector = (
    <div className="mode-seg" role="tablist" aria-label="Режим работы">
      {[['personal', 'Обычный'], ['business', 'Бизнес'], ['employee', 'Сотрудник']].map(([m, l]) => {
        const disabled = m === 'employee' && !canBeEmployee;
        return (
          <button key={m} type="button" role="tab" aria-selected={workMode === m} disabled={disabled}
            title={disabled ? empDisabledHint : undefined}
            className={`mode-seg-btn${workMode === m ? ' mode-seg-btn--active' : ''}`}
            onClick={() => changeWorkMode(m)}>{l}</button>
        );
      })}
    </div>
  );

  return (
    <div className="app-shell">
      {/* Hidden sound audio elements */}
      {SOUNDS.map(s => (
        <audio key={s.id} ref={el => { soundRefs.current[s.id] = el; }} src={s.file} preload="auto" />
      ))}

      {/* ── Доступ к камере и микрофону отклонён ── */}
      {mediaBlocked && (
        <div className="call-popup media-blocked">
          <div className="call-popup-title"><Icon name="cameraOff" size={18} /> Нет доступа к камере и микрофону</div>
          <p className="media-blocked-text">
            Разрешение было отклонено. Заново запросить его приложение не может —
            вернуть доступ получится только в настройках телефона.
          </p>
          <p className="media-blocked-path">Настройки → COMS → включить «Камера» и «Микрофон»</p>
          <div className="call-popup-actions">
            <button className="primary-btn" onClick={() => setMediaBlocked(false)}>Понятно</button>
          </div>
        </div>
      )}

      {/* ── Входящий звонок ── */}
      {call?.role === 'in' && call.phase === 'ringing' && (
        <div className="call-popup">
          <div className="call-popup-title"><Icon name="phone" size={18} /> Входящий звонок</div>
          <div className="call-popup-from">{call.peerName}</div>
          <div className="call-popup-hint">осталось {callLeft} с</div>
          <div className="call-popup-actions">
            <button className="primary-btn" onClick={acceptCall}>Принять</button>
            <button className="ghost-btn" onClick={declineCall}>Отклонить</button>
          </div>
        </div>
      )}

      {/* ── Исходящий звонок: дозвон, ещё не разговор ── */}
      {call?.role === 'out' && (
        <div className="dialing-shell">
          <div className="dialing-card">
            <div className="dialing-avatar">{(call.peerName || '?')[0].toUpperCase()}</div>
            <div className="dialing-name">{call.peerName}</div>
            <div className="dialing-state">
              {call.phase === 'connecting'
                ? 'Соединяем…'
                : <>Вызов… <span className="dialing-left">{callLeft} с</span></>}
            </div>
            {call.phase === 'ringing' && (
              <button className="ctrl-round ctrl-round--danger dialing-cancel" onClick={cancelCall} aria-label="Отменить звонок">
                <Icon name="phoneOff" size={22} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Почему звонок не состоялся — иначе человек не понимает, что произошло */}
      {callNotice && <div className="call-notice">{callNotice}</div>}

      {/* ── Кто-то стучится в приватную комнату (видит владелец в звонке) ── */}
      {knockRequest && roomInfo?.isOwner && (
        <div className="call-popup">
          <div className="call-popup-title">🚪 Запрос на вход</div>
          <div className="call-popup-from">{knockRequest.name || knockRequest.username} просится в комнату</div>
          <div className="call-popup-actions">
            <button className="primary-btn" onClick={approveKnock}>Впустить</button>
            <button className="ghost-btn" onClick={() => setKnockRequest(null)}>Игнорировать</button>
          </div>
        </div>
      )}

      {/* Комната ожидания — экран гостя */}
      {waitingForHost && (
        <div className="modal-backdrop">
          <div className="waiting-card">
            <div className="waiting-spinner"><span className="spinner" /></div>
            <div className="waiting-title">Вы в комнате ожидания</div>
            <div className="waiting-text">Ведущий скоро впустит вас в звонок. Пожалуйста, подождите.</div>
            <button className="ghost-btn" onClick={cancelWaiting}>Отменить</button>
          </div>
        </div>
      )}

      {/* Комната ожидания — панель допуска для ведущего */}
      {joined && waitingList.length > 0 && (
        <div className="waiting-admit">
          <div className="waiting-admit-title">Ожидают входа ({waitingList.length})</div>
          {waitingList.map(w => (
            <div className="waiting-admit-row" key={w.socketId}>
              <span className="waiting-admit-name">{w.name || 'Гость'}</span>
              <span className="waiting-admit-actions">
                <button className="primary-btn waiting-admit-btn" onClick={() => admitWaiter(w)}>Впустить</button>
                <button className="ghost-btn waiting-admit-btn" onClick={() => denyWaiter(w)}>Отклонить</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Контакты (по кнопке) ── */}
      {isContactsOpen && (
        <aside className="chat-overlay">
          <div className="chat-header">
            <div className="chat-title"><Icon name="users" size={17} /> Контакты ({contacts.length})</div>
            <button className="ghost-btn" style={{ height: 36, padding: '0 12px' }} onClick={() => setIsContactsOpen(false)}><Icon name="close" size={16} /></button>
          </div>
          <div className="chat-body">
            <input
              className="contact-search"
              value={contactSearch}
              onChange={e => setContactSearch(e.target.value)}
              placeholder="Найти человека по нику..."
            />
            {searchResults.length > 0 && (
              <div className="search-results">
                {searchResults
                  .filter(u => u.username !== authUser?.username)
                  .map(u => (
                    <div className="contact-row" key={u.username}>
                      <span className="contact-name">
                        {u.display_name || u.username}
                        <span className="contact-nick"> @{u.username}</span>
                      </span>
                      {contacts.some(c => c.contactUsername === u.username)
                        ? <span className="contact-added">в контактах</span>
                        : <button className="ghost-btn contact-btn" onClick={() => addContact(u.username)}>+ Добавить</button>}
                    </div>
                  ))}
              </div>
            )}
            <div className="contacts-list">
              {contacts.length === 0 && searchResults.length === 0
                ? <div className="participants-empty">Найдите людей по нику и добавьте в контакты</div>
                : contacts.map(c => (
                    <div className="contact-row" key={c.contactUsername}>
                      <span className="contact-name">@{c.contactUsername}</span>
                      <span className="contact-actions">
                        <button className="ghost-btn contact-btn contact-btn--call" onClick={() => { setIsContactsOpen(false); callContact(c.contactUsername); }}><Icon name="phone" size={14} /> Позвонить</button>
                        <button className="ghost-btn contact-btn" title="Убрать из контактов" onClick={() => removeContact(c.contactUsername)}><Icon name="close" size={16} /></button>
                      </span>
                    </div>
                  ))}
            </div>
          </div>
        </aside>
      )}

      {/* ── Участники (в звонке, по кнопке) ── */}
      {isParticipantsOpen && joined && (
        <aside className="chat-overlay">
          <div className="chat-header">
            <div className="chat-title"><Icon name="users" size={17} /> Участники ({allParticipants.length})</div>
            <button className="ghost-btn" style={{ height: 36, padding: '0 12px' }} onClick={() => setIsParticipantsOpen(false)}><Icon name="close" size={16} /></button>
          </div>
          <div className="chat-body">
            {allParticipants.map(p => {
              const isLocal = p === livekitRoomRef.current?.localParticipant;
              const iAmHost = roomInfo?.isOwner;
              return (
                <div className="participant-item" key={p.identity}>
                  <span className="participant-name">{displayName(p)}</span>
                  <span className="participant-actions-row">
                    {iAmHost && !isLocal && (
                      <button className="kick-btn" title="Удалить из звонка" onClick={() => kickParticipant(p.identity)}>Удалить</button>
                    )}
                    <span className="participant-badge">{isLocal ? 'Вы' : 'В комнате'}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* ── Админ-панель компании ── */}
      {/* ── Кабинет сотрудника ── */}
      {empPanel && (
        <div className="admin-overlay">
          <div className="admin-header">
            <div className="admin-header-title">
              <span className="admin-company-dot" style={{ background: empCompany?.accent || 'var(--accent)' }} />
              {empCompany?.name || '…'}
              <span className="admin-header-sub">кабинет сотрудника</span>
            </div>
            <div className="admin-header-actions">
              {employeeCompanies.length > 1 && (
                <Select className="emp-company-switch" size="sm" align="right" value={empSlug || ''}
                  onChange={v => { setEmpSlug(v); setEmpTab('overview'); }}
                  options={employeeCompanies.map(c => ({ value: c.slug, label: c.name }))} />
              )}
              <button className="modal-close-btn" onClick={closeEmployee}><Icon name="close" size={16} /></button>
            </div>
          </div>
          <div className="admin-body">
            <nav className="admin-nav">
              {[['overview', 'Обзор'], ['team', 'Команда'], ['rooms', 'Комнаты'], ['meetings', 'Встречи']].map(([id, label]) => (
                <button key={id} className={`admin-nav-btn${empTab === id ? ' admin-nav-btn--active' : ''}`} onClick={() => setEmpTab(id)}>{label}</button>
              ))}
            </nav>
            <div className="admin-content">
              {empTab === 'overview' && (
                <div className="emp-overview">
                  <div className="emp-profile-card">
                    <Avatar url={authUser?.avatarUrl} name={empMe?.me?.username || authUser?.username} className="emp-avatar" />
                    <div className="emp-profile-main">
                      <div className="emp-profile-name">{empMe?.me?.username || authUser?.username}</div>
                      <div className="emp-profile-title">{empMe?.me?.title || 'Должность не указана'}</div>
                      <div className="emp-profile-meta">
                        <span className="emp-chip">{empMe?.me?.department || 'Без отдела'}</span>
                        <span className="emp-chip emp-chip--role">{empMe?.me?.role === 'owner' ? 'владелец' : empMe?.me?.role === 'admin' ? 'админ' : 'участник'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="admin-stats-grid">
                    <div className="admin-stat"><div className="admin-stat-num">{empMe?.activity?.meetings ?? '—'}</div><div className="admin-stat-label">Моих встреч</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{empMe?.activity?.minutes ?? '—'}</div><div className="admin-stat-label">Минут в звонках</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{(empCompany?.members || []).length || '—'}</div><div className="admin-stat-label">Коллег</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{empMe?.activity?.lastActive ? new Date(empMe.activity.lastActive).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—'}</div><div className="admin-stat-label">Последняя активность</div></div>
                  </div>
                </div>
              )}

              {empTab === 'team' && (
                empCompany && (empCompany.members || []).length > 0 ? (
                  <div className="emp-team">
                    {(empCompany.members || []).map(m => (
                      <div className="employee-row" key={m.username}>
                        <Avatar url={m.avatarUrl} name={m.username} />
                        <div className="emp-team-main">
                          <div className="emp-team-name">{m.username}{m.username === (empMe?.me?.username) ? ' · вы' : ''}</div>
                          <div className="emp-team-sub">{m.title || 'должность не указана'}</div>
                        </div>
                        <div className="emp-team-tags">
                          {m.department?.name && <span className="emp-chip">{m.department.name}</span>}
                          <span className="emp-chip emp-chip--role">{m.role === 'owner' ? 'владелец' : m.role === 'admin' ? 'админ' : 'участник'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <div className="participants-empty">Список команды загружается…</div>
              )}

              {empTab === 'rooms' && (
                empRooms.length === 0
                  ? <div className="participants-empty">Постоянных комнат компании пока нет.</div>
                  : empRooms.map(r => (
                    <div className="admin-room-row" key={r.slug}>
                      <div className="admin-room-info">
                        <div className="admin-room-name">{r.name}</div>
                        <div className="admin-room-meta">{r.waitingRoom ? 'приёмная · ' : ''}{r.muteOnJoin ? 'мьют при входе' : 'вход с микрофоном'}</div>
                      </div>
                      <div className="admin-room-actions">
                        <button className="ghost-btn room-card-btn" onClick={() => { navigator.clipboard.writeText(buildInviteLink(r.slug, r.inviteKey)); setProfileMsg('Ссылка скопирована'); setTimeout(() => setProfileMsg(''), 2000); }}>Ссылка</button>
                        <button className="primary-btn room-card-btn" onClick={() => enterEmployeeRoom(r)}>Войти</button>
                      </div>
                    </div>
                  ))
              )}

              {empTab === 'meetings' && (
                empMeetings.length === 0
                  ? <div className="participants-empty">Запланированных встреч нет.</div>
                  : empMeetings.map(m => (
                    <div className="admin-room-row" key={m.id}>
                      <div className="admin-room-info">
                        <div className="admin-room-name">{m.title}</div>
                        <div className="admin-room-meta">{new Date(m.scheduledAt).toLocaleString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {m.createdBy}</div>
                      </div>
                      <div className="admin-room-actions">
                        <button className="primary-btn room-card-btn" onClick={() => joinEmployeeMeeting(m)}>Войти</button>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      )}

      {adminPanel && (
        <div className="admin-overlay">
          <div className="admin-header">
            <div className="admin-header-title">
              <span className="admin-company-dot" style={{ background: adminPanel.accent }} />
              {adminPanel.name}
              <span className="admin-header-sub">панель управления</span>
            </div>
            <button className="modal-close-btn" onClick={closeAdmin}><Icon name="close" size={16} /></button>
          </div>
          <div className="admin-body">
            <nav className="admin-nav">
              {[['overview','Обзор'],['members','Сотрудники'],['departments','Отделы'],['analytics','Аналитика'],['meetings','Встречи'],['rooms','Комнаты'],['recordings','Записи'],['settings','Настройки'],['audit','Журнал']].map(([id,label]) => (
                <button key={id} className={`admin-nav-btn${adminTab===id?' admin-nav-btn--active':''}`} onClick={() => setAdminTab(id)}>{label}</button>
              ))}
            </nav>
            <div className="admin-content">
              {profileMsg && <div className="profile-msg">{profileMsg}</div>}

              {adminTab === 'overview' && (
                <div className="admin-stats-grid">
                  <div className="admin-stat"><div className="admin-stat-num">{adminStats?.members ?? '—'}</div><div className="admin-stat-label">Сотрудников</div></div>
                  <div className="admin-stat"><div className="admin-stat-num">{adminStats?.rooms ?? '—'}</div><div className="admin-stat-label">Комнат</div></div>
                  <div className="admin-stat"><div className="admin-stat-num">{adminStats?.meetings ?? '—'}</div><div className="admin-stat-label">Встреч</div></div>
                  <div className="admin-stat"><div className="admin-stat-num">{adminStats?.totalMinutes ?? '—'}</div><div className="admin-stat-label">Минут в звонках</div></div>
                  <div className="admin-stat"><div className="admin-stat-num">{adminStats?.recordings ?? '—'}</div><div className="admin-stat-label">Записей</div></div>
                </div>
              )}

              {adminTab === 'members' && (
                <div className="admin-members">
                  <div className="company-invite">
                    <input value={companyInvite[adminPanel.slug] || ''}
                      onChange={e => setCompanyInvite(p => ({ ...p, [adminPanel.slug]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); adminInvite(companyInvite[adminPanel.slug]); setCompanyInvite(p => ({ ...p, [adminPanel.slug]: '' })); } }}
                      placeholder="Добавить сотрудника по нику" />
                    <button onClick={() => { adminInvite(companyInvite[adminPanel.slug]); setCompanyInvite(p => ({ ...p, [adminPanel.slug]: '' })); }}>Добавить</button>
                  </div>
                  <div className="company-members company-members--rich">
                    {(adminPanel.members || []).map(m => (
                      <div className="employee-row" key={m.username}>
                        <Avatar url={m.avatarUrl} name={m.username} />
                        <div className="employee-main">
                          <div className="employee-top">
                            <span className="company-member-name">{m.username}</span>
                            {m.role === 'owner' ? (
                              <span className="company-member-role">владелец</span>
                            ) : adminPanel.myRole === 'owner' ? (
                              <Select className="admin-role-select" size="sm" value={m.role}
                                onChange={v => changeMemberRole(m.username, v)}
                                options={[{ value: 'member', label: 'участник' }, { value: 'admin', label: 'админ' }]} />
                            ) : (
                              <span className="company-member-role">{m.role === 'admin' ? 'админ' : 'участник'}</span>
                            )}
                          </div>
                          <div className="employee-fields">
                            <input className="employee-title-input" defaultValue={m.title || ''} placeholder="Должность"
                              key={`${m.username}-${m.title||''}`}
                              onBlur={e => { const v = e.target.value.trim(); if (v !== (m.title||'')) setMemberProfile(m.username, { title: v }); }}
                              onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
                            <Select className="employee-dep-select" size="sm" value={m.departmentId || m.department?.id || ''}
                              onChange={v => setMemberProfile(m.username, { departmentId: v || null })}
                              options={[{ value: '', label: 'Без отдела' }, ...adminDepartments.map(d => ({ value: d.id, label: d.name }))]} />
                          </div>
                        </div>
                        {m.role !== 'owner' && (
                          <button className="company-x" title="Убрать" onClick={() => adminRemoveMember(m.username)}>✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {adminTab === 'departments' && (
                <div className="admin-departments">
                  <div className="company-invite">
                    <input value={newDepName} onChange={e => setNewDepName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createDepartment(); } }}
                      placeholder="Новый отдел (напр. Продажи)" />
                    <button onClick={createDepartment}>Создать</button>
                  </div>
                  {adminDepartments.length === 0
                    ? <div className="participants-empty">Отделов пока нет. Создайте структуру компании — затем назначайте сотрудников во вкладке «Сотрудники».</div>
                    : adminDepartments.map(d => (
                      <div className="admin-room-row" key={d.id}>
                        <div className="admin-room-info">
                          <div className="admin-room-name">{d.name}</div>
                          <div className="admin-room-meta">{d.count} {d.count === 1 ? 'сотрудник' : (d.count >= 2 && d.count <= 4 ? 'сотрудника' : 'сотрудников')}{d.head ? ` · руководитель: ${d.head}` : ''}</div>
                        </div>
                        <div className="admin-room-actions">
                          <Select className="admin-role-select" size="sm" align="right" value={d.head || ''} placeholder="Руководитель…"
                            onChange={v => setDepartmentHead(d.id, v || null)}
                            options={[{ value: '', label: 'Руководитель…' }, ...(adminPanel.members || []).map(m => ({ value: m.username, label: m.username }))]} />
                          <button className="ghost-btn room-card-btn room-card-btn--danger" onClick={() => deleteDepartment(d.id)}>✕</button>
                        </div>
                      </div>
                    ))}
                </div>
              )}

              {adminTab === 'analytics' && (
                <div className="admin-analytics">
                  <div className="admin-stats-grid">
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics?.summary?.employees ?? '—'}</div><div className="admin-stat-label">Сотрудников</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics?.summary?.activeThisWeek ?? '—'}</div><div className="admin-stat-label">Активны за неделю</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics?.summary?.totalMinutes ?? '—'}</div><div className="admin-stat-label">Минут суммарно</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics?.summary?.avgMinutes ?? '—'}</div><div className="admin-stat-label">Минут в среднем</div></div>
                  </div>
                  {(!adminAnalytics || adminAnalytics.rows.length === 0)
                    ? <div className="participants-empty">Данных пока нет. Статистика появится после звонков в комнатах компании.</div>
                    : <div className="analytics-table">
                        <div className="analytics-head">
                          <span className="ac-name">Сотрудник</span>
                          <span className="ac-dep">Отдел</span>
                          <span className="ac-num">Встреч</span>
                          <span className="ac-num">Минут</span>
                          <span className="ac-last">Активность</span>
                        </div>
                        {adminAnalytics.rows.map(r => (
                          <div className="analytics-row" key={r.username}>
                            <span className="ac-name">
                              <Avatar url={r.avatarUrl} name={r.username} className="company-member-avatar analytics-av" />
                              <span className="ac-name-txt"><b>{r.username}</b>{r.title ? <small>{r.title}</small> : null}</span>
                            </span>
                            <span className="ac-dep">{r.department || '—'}</span>
                            <span className="ac-num" data-l="Встреч:">{r.meetings}</span>
                            <span className="ac-num" data-l="Минут:">{r.minutes}</span>
                            <span className="ac-last">
                              {r.lastActive
                                ? <span className={`ac-badge${r.active7d ? ' ac-badge--on' : ''}`}>{new Date(r.lastActive).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})}</span>
                                : <span className="ac-badge ac-badge--never">—</span>}
                            </span>
                          </div>
                        ))}
                      </div>}
                </div>
              )}

              {adminTab === 'meetings' && (
                <div className="admin-meetings">
                  <div className="meeting-form">
                    <input className="meeting-input" value={newMeeting.title} onChange={e => setNewMeeting(p => ({ ...p, title: e.target.value }))} placeholder="Название встречи" />
                    <input className="meeting-input" type="datetime-local" value={newMeeting.at} onChange={e => setNewMeeting(p => ({ ...p, at: e.target.value }))} />
                    <button className="primary-btn" onClick={scheduleMeeting}>Запланировать</button>
                  </div>
                  {adminMeetings.length === 0
                    ? <div className="participants-empty">Запланированных встреч нет.</div>
                    : adminMeetings.map(m => (
                        <div className="admin-room-row" key={m.id}>
                          <div className="admin-room-info">
                            <div className="admin-room-name">{m.title}</div>
                            <div className="admin-room-meta">{new Date(m.scheduledAt).toLocaleString('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} · {m.createdBy}</div>
                          </div>
                          <div className="admin-room-actions">
                            <button className="ghost-btn room-card-btn" onClick={() => { navigator.clipboard.writeText(buildInviteLink(m.roomSlug, m.inviteKey)); setProfileMsg('Ссылка скопирована'); setTimeout(()=>setProfileMsg(''),2000); }}>Ссылка</button>
                            <button className="ghost-btn room-card-btn" onClick={() => joinMeeting(m)}>Войти</button>
                            <button className="ghost-btn room-card-btn room-card-btn--danger" onClick={() => deleteMeeting(m.id)}>✕</button>
                          </div>
                        </div>
                      ))}
                </div>
              )}

              {adminTab === 'rooms' && (
                <div className="admin-rooms">
                  <div className="company-invite">
                    <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createCompanyRoom(); } }}
                      placeholder="Название переговорки" />
                    <button onClick={createCompanyRoom}>Создать</button>
                  </div>
                  {adminRooms.length === 0
                    ? <div className="participants-empty">Постоянных комнат пока нет. Создайте переговорку с фиксированной ссылкой.</div>
                    : adminRooms.map(r => (
                      <div className="admin-room-row" key={r.slug}>
                        <div className="admin-room-info">
                          <div className="admin-room-name">{r.name}</div>
                          <div className="admin-room-meta">{r.waitingRoom ? 'приёмная · ' : ''}{r.muteOnJoin ? 'мьют при входе' : 'вход с микрофоном'}</div>
                        </div>
                        <div className="admin-room-actions">
                          <button className="ghost-btn room-card-btn" onClick={() => { navigator.clipboard.writeText(buildInviteLink(r.slug, r.inviteKey)); setProfileMsg('Ссылка скопирована'); setTimeout(()=>setProfileMsg(''),2000); }}>Ссылка</button>
                          <button className="ghost-btn room-card-btn" onClick={() => enterCompanyRoom(r)}>Войти</button>
                          <button className="ghost-btn room-card-btn room-card-btn--danger" onClick={() => deleteCompanyRoom(r.slug)}>✕</button>
                        </div>
                      </div>
                    ))}
                </div>
              )}

              {adminTab === 'recordings' && (
                adminRecordings.length === 0
                  ? <div className="participants-empty">Записей встреч компании пока нет.</div>
                  : <div className="calls-history-list">
                      {adminRecordings.map(rec => (
                        <div className="call-history-card" key={rec.id}>
                          <div className="call-history-room"><Icon name="record" size={14} /> #{rec.roomId}</div>
                          <div className="call-history-row"><span>Начал</span><span>{rec.startedBy}</span></div>
                          <div className="call-history-row"><span>Дата</span><span>{new Date(rec.startedAt).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span></div>
                          {rec.status === 'done' && rec.fileName && (
                            <div className="room-card-actions">
                              <button className="ghost-btn room-card-btn" onClick={() => downloadRecording(rec.id)}><Icon name="download" size={14} /> Скачать</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
              )}

              {adminTab === 'settings' && (
                <div className="admin-settings">
                  <div className="admin-set-row">
                    <div><div className="admin-set-title">Фирменный цвет</div><div className="admin-set-sub">Брендинг всего интерфейса</div></div>
                    <input type="color" value={adminPanel.accent} onChange={e => updatePolicy({ accent: e.target.value })} className="admin-color" />
                  </div>
                  <div className="admin-set-row">
                    <div><div className="admin-set-title">Комната ожидания по умолчанию</div><div className="admin-set-sub">Новые комнаты создаются с приёмной</div></div>
                    <Switch checked={adminPanel.defaultWaitingRoom} onChange={v => updatePolicy({ defaultWaitingRoom: v })} label="Комната ожидания по умолчанию" />
                  </div>
                  <div className="admin-set-row">
                    <div><div className="admin-set-title">Выключать микрофон при входе</div><div className="admin-set-sub">Гости входят с выключенным микрофоном</div></div>
                    <Switch checked={adminPanel.defaultMuteOnJoin} onChange={v => updatePolicy({ defaultMuteOnJoin: v })} label="Выключать микрофон при входе" />
                  </div>
                  <div className="admin-set-row">
                    <div><div className="admin-set-title">Кто может записывать</div><div className="admin-set-sub">Право на запись встреч</div></div>
                    <Select className="admin-role-select" align="right" value={adminPanel.recordPolicy}
                      onChange={v => updatePolicy({ recordPolicy: v })}
                      options={[{ value: 'anyone', label: 'все участники' }, { value: 'admin', label: 'админы и владелец' }, { value: 'owner', label: 'только владелец' }]} />
                  </div>
                  <div className="admin-set-row">
                    <div><div className="admin-set-title">Кто может создавать комнаты</div><div className="admin-set-sub">Право на переговорки компании</div></div>
                    <Select className="admin-role-select" align="right" value={adminPanel.whoCanCreateRooms}
                      onChange={v => updatePolicy({ whoCanCreateRooms: v })}
                      options={[{ value: 'anyone', label: 'все сотрудники' }, { value: 'admin', label: 'только админы' }]} />
                  </div>
                  <div className="admin-set-row">
                    <div><div className="admin-set-title">Гостевой доступ</div><div className="admin-set-sub">Люди вне компании могут заходить по ссылке</div></div>
                    <Switch checked={adminPanel.guestAccess} onChange={v => updatePolicy({ guestAccess: v })} label="Гостевой доступ" />
                  </div>
                </div>
              )}

              {adminTab === 'audit' && (
                adminAudit.length === 0
                  ? <div className="participants-empty">Журнал пуст.</div>
                  : <div className="admin-audit">
                      {adminAudit.map(a => (
                        <div className="admin-audit-row" key={a.id}>
                          <span className="admin-audit-actor">{a.actor}</span>
                          <span className="admin-audit-action">{({member_added:'добавил',member_removed:'убрал',role_changed:'сменил роль',room_created:'создал комнату',room_deleted:'удалил комнату',settings_changed:'изменил настройки'})[a.action] || a.action}</span>
                          {a.detail && <span className="admin-audit-detail">{a.detail}</span>}
                          <span className="admin-audit-time">{new Date(a.createdAt).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                        </div>
                      ))}
                    </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Account modal overlay ── */}
      {isAccountPanelOpen && (
        <div className="modal-backdrop" onClick={() => setIsAccountPanelOpen(false)}>
          <aside className="account-modal" onClick={e => e.stopPropagation()}>
            <div className="account-modal-header">
              <div>
                <div className="account-modal-title">voyage account</div>
                <div className="account-modal-sub">профиль и история активности</div>
              </div>
              <button className="modal-close-btn" onClick={() => setIsAccountPanelOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="account-tabs">
              <button className={accountTab === 'profile' ? 'tab-btn tab-btn--active' : 'tab-btn'} onClick={() => setAccountTab('profile')}>Профиль</button>
              <button className={accountTab === 'rooms' ? 'tab-btn tab-btn--active' : 'tab-btn'} onClick={() => setAccountTab('rooms')}>Комнаты</button>
              <button className={accountTab === 'history' ? 'tab-btn tab-btn--active' : 'tab-btn'} onClick={() => setAccountTab('history')}>История</button>
              <button className={accountTab === 'recordings' ? 'tab-btn tab-btn--active' : 'tab-btn'} onClick={() => setAccountTab('recordings')}>Записи</button>
              <button className={accountTab === 'business' ? 'tab-btn tab-btn--active' : 'tab-btn'} onClick={() => setAccountTab('business')}>Бизнес</button>
              <button className={accountTab === 'employee' ? 'tab-btn tab-btn--active' : 'tab-btn'} onClick={() => setAccountTab('employee')}>Сотрудник</button>
            </div>

            {profileMsg && <div className="profile-msg">{profileMsg}</div>}

            {accountTab === 'business' && (
              <div className="account-section">
                <div className="mode-pick">
                  <div className="mode-pick-title">Режим работы</div>
                  <div className="mode-pick-sub">Обычный — личные звонки · Бизнес — управление компанией · Сотрудник — рабочий кабинет</div>
                  {modeSelector}
                </div>

                <div className="field-group" style={{ marginTop: 16 }}>
                  <label>Зарегистрировать компанию</label>
                  <div className="invite-row">
                    <input
                      value={newCompanyName}
                      onChange={e => setNewCompanyName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createCompany(); } }}
                      placeholder="Название компании или фонда"
                    />
                    <button className="ghost-btn" onClick={createCompany}>Создать</button>
                  </div>
                </div>

                {companiesLoading ? (
                  <div className="participants-empty">Загрузка…</div>
                ) : companies.length === 0 ? (
                  <div className="participants-empty">У вас пока нет компаний. Создайте — и получите брендинг, роли и инструменты для бизнес-встреч.</div>
                ) : (
                  <div className="calls-history-list">
                    {companies.map(c => {
                      const canManage = c.myRole === 'owner' || c.myRole === 'admin';
                      return (
                        <div className="call-history-card company-card" key={c.slug}>
                          <div className="company-card-head">
                            <span className="company-dot" style={{ background: c.accent }} />
                            <span className="call-history-room">{c.name}</span>
                            <span className="company-role">{c.myRole === 'owner' ? 'владелец' : c.myRole === 'admin' ? 'админ' : 'участник'}</span>
                          </div>
                          {canManage && (
                            <div className="company-accent-row">
                              <span>Фирменный цвет</span>
                              <input type="color" value={c.accent} onChange={e => setCompanyAccent(c.slug, e.target.value)} />
                            </div>
                          )}
                          <div className="company-members">
                            {(c.members || []).map(m => (
                              <div className="company-member" key={m.username}>
                                <Avatar url={m.avatarUrl} name={m.username} />
                                <span className="company-member-name">{m.username}</span>
                                <span className="company-member-role">{m.role === 'owner' ? 'владелец' : m.role === 'admin' ? 'админ' : 'участник'}</span>
                                {canManage && m.role !== 'owner' && (
                                  <button className="company-x" title="Убрать" onClick={() => removeCompanyMember(c.slug, m.username)}>✕</button>
                                )}
                              </div>
                            ))}
                          </div>
                          {canManage && (
                            <div className="company-invite">
                              <input
                                value={companyInvite[c.slug] || ''}
                                onChange={e => setCompanyInvite(p => ({ ...p, [c.slug]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); inviteToCompany(c.slug); } }}
                                placeholder="Добавить сотрудника по нику"
                              />
                              <button onClick={() => inviteToCompany(c.slug)}>Добавить</button>
                            </div>
                          )}
                          <div className="room-card-actions">
                            {c.myRole === 'owner' && (
                              <button className="ghost-btn room-card-btn room-card-btn--danger" onClick={() => deleteCompany(c.slug)}>Удалить</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {accountTab === 'employee' && (
              <div className="account-section">
                <div className="mode-pick">
                  <div className="mode-pick-title">Режим работы</div>
                  <div className="mode-pick-sub">Включите «Сотрудник», чтобы получить рабочий кабинет: профиль, команда, комнаты и встречи компании</div>
                  {modeSelector}
                </div>

                {companiesLoading ? (
                  <div className="participants-empty">Загрузка…</div>
                ) : employeeCompanies.length === 0 ? (
                  <div className="participants-empty">
                    {companies.length
                      ? 'Вы владелец своей компании, а владелец не может быть её сотрудником. Управляйте компанией в режиме «Бизнес» — кнопка «Панель управления» на главном экране.'
                      : 'Вас пока не добавили сотрудником ни в одну компанию. Как только владелец добавит ваш ник — здесь появится рабочий кабинет.'}
                  </div>
                ) : (
                  <>
                    <div className="field-group" style={{ marginTop: 16 }}>
                      <label>Где я работаю</label>
                    </div>
                    <div className="calls-history-list">
                      {employeeCompanies.map(c => (
                        <div className="call-history-card company-card" key={c.slug}>
                          <div className="company-card-head">
                            <span className="company-dot" style={{ background: c.accent }} />
                            <span className="call-history-room">{c.name}</span>
                            <span className="company-role">{c.myRole === 'owner' ? 'владелец' : c.myRole === 'admin' ? 'админ' : 'участник'}</span>
                          </div>
                          <div className="room-card-actions">
                            <button className="primary-btn room-card-btn" onClick={() => { setEmpSlug(c.slug); setEmpTab('overview'); setEmpPanel(true); setIsAccountPanelOpen(false); }}>Открыть кабинет</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {accountTab === 'profile' && (
              <div className="account-section">
                <div className="profile-head">
                  <button
                    className="avatar-btn"
                    title="Сменить аватар"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {authUser?.avatarUrl
                      ? <img src={mediaUrl(authUser.avatarUrl)} alt="" className="avatar-img" />
                      : <span className="avatar-placeholder">{(authUser?.displayName || authUser?.username || '?')[0].toUpperCase()}</span>}
                    <span className="avatar-edit-hint">✎</span>
                  </button>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={e => { uploadAvatar(e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <div className="profile-head-info">
                    <div className="profile-display-name">{authUser?.displayName || authUser?.username}</div>
                    <div className="profile-username">@{authUser?.username}</div>
                  </div>
                </div>

                <div className="field-group">
                  <label>Отображаемое имя</label>
                  <div className="invite-row">
                    <input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveDisplayName(); } }}
                      placeholder={authUser?.displayName || 'Как вас видят в звонках'}
                    />
                    <button className="ghost-btn" onClick={saveDisplayName}>Сохранить</button>
                  </div>
                </div>

                <div className="account-info-card">
                  <div className="account-info-row"><span>Никнейм</span><strong>{authUser?.username || '—'}</strong></div>
                  <div className="account-info-row"><span>ID аккаунта</span><strong className="id-text">{authUser?.id || '—'}</strong></div>
                  <div className="account-info-row"><span>Регистрация</span><strong>{authUser?.createdAt ? new Date(authUser.createdAt).toLocaleDateString('ru-RU') : '—'}</strong></div>
                  <div className="account-info-row"><span>С Voyage</span><strong>{daysSinceRegistration ? `${daysSinceRegistration} дн.` : '—'}</strong></div>
                  <div className="account-info-row">
                    <span>Telegram</span>
                    <strong>{authUser?.telegramLinked
                      ? (authUser?.telegramUsername ? `@${authUser.telegramUsername}` : 'привязан')
                      : 'не привязан'}</strong>
                  </div>
                </div>

                {/* Криптокошелёк и токены на iOS не показываем: Apple разбирает
                    операции с криптоактивами и внешние ссылки на покупку отдельно
                    и строго (Guidelines 3.1.1 и 3.1.5(b)), а к звонкам это не относится */}
                {!IS_IOS && (
                <div className="account-info-card" style={{ marginTop: 12 }}>
                  <div className="account-info-row">
                    <span>VOCO</span>
                    <strong>{(authUser?.vocoBalance ?? 0).toLocaleString('ru-RU')}</strong>
                  </div>
                  <div className="account-info-row">
                    <span>Кошелёк</span>
                    <strong className="id-text">
                      {authUser?.walletAddress
                        ? `${authUser.walletAddress.slice(0, 6)}…${authUser.walletAddress.slice(-4)}`
                        : 'не привязан'}
                    </strong>
                  </div>
                  {authUser?.walletAddress ? (
                    <a
                      href="https://voyage-community.ru/voco/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ghost-btn wallet-btn"
                    >
                      <Icon name="link" size={15} /> Управление VOCO
                    </a>
                  ) : (
                    <button
                      className="ghost-btn wallet-btn"
                      onClick={async () => {
                        try {
                          const token = localStorage.getItem('token');
                          const r = await fetch('https://voyage-community.ru/api/accounts/wallet-link/ticket', {
                            method: 'POST', headers: { Authorization: `Bearer ${token}` },
                          });
                          const d = await r.json();
                          if (r.ok && d.url) window.open(d.url, '_blank', 'noopener');
                        } catch { /* ignore */ }
                      }}
                    >
                      <Icon name="link" size={15} /> Привязать кошелёк
                    </button>
                  )}
                </div>
                )}

                <div className="legal-links">
                  {/* В приложении новую вкладку открыть некуда: WKWebView просто
                      игнорирует target="_blank". Внутри приложения переходим на
                      месте — на странице есть ссылка обратно. */}
                  <a
                    href={`${BASE}privacy.html`}
                    target={IS_IOS ? undefined : '_blank'}
                    rel={IS_IOS ? undefined : 'noopener noreferrer'}
                  >
                    Политика конфиденциальности
                  </a>
                </div>

                {/* Удаление аккаунта — обязательный пункт для App Store */}
                <div className="danger-zone">
                  <div className="danger-zone-title">Удаление аккаунта</div>
                  {!delOpen ? (
                    <>
                      <p className="danger-zone-text">
                        Аккаунт Voyage будет удалён вместе со звонками, записями, контактами
                        и компаниями, которыми вы владеете.
                      </p>
                      <button className="ghost-btn danger-btn" onClick={openDeleteAccount}>
                        Удалить аккаунт
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="danger-zone-text">Будет безвозвратно удалено:</p>
                      <ul className="danger-zone-list">
                        <li>профиль, логин и вход во все сервисы Voyage</li>
                        <li>история звонков и записи конференций</li>
                        <li>контакты и ваши комнаты</li>
                        <li>компании, которыми вы владеете, — вместе с данными их сотрудников</li>
                        {delPreview?.vpn_active && (
                          <li className="danger-zone-warn">
                            активная подписка VPN
                            {delPreview.vpn_expires_at
                              ? ` (оплачена до ${new Date(delPreview.vpn_expires_at).toLocaleDateString('ru-RU')})`
                              : ''} — деньги не возвращаются
                          </li>
                        )}
                      </ul>
                      <p className="danger-zone-text">
                        У вас будет {delPreview?.grace_days || 30} дней, чтобы передумать: до этого
                        срока аккаунт можно вернуть, просто войдя снова. Потом данные сотрутся навсегда.
                      </p>
                      <label className="danger-zone-label" htmlFor="del-confirm">
                        Введите <b>УДАЛИТЬ</b> для подтверждения
                      </label>
                      <input
                        id="del-confirm"
                        className="text-input"
                        value={delConfirm}
                        onChange={e => setDelConfirm(e.target.value)}
                        placeholder="УДАЛИТЬ"
                        autoComplete="off"
                      />
                      {delError && <div className="danger-zone-error">{delError}</div>}
                      <div className="danger-zone-actions">
                        <button className="ghost-btn" onClick={() => setDelOpen(false)} disabled={delBusy}>
                          Отмена
                        </button>
                        <button
                          className="ghost-btn danger-btn"
                          onClick={confirmDeleteAccount}
                          disabled={delBusy || delConfirm.trim().toUpperCase() !== 'УДАЛИТЬ'}
                        >
                          {delBusy ? 'Удаляем…' : 'Удалить навсегда'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {accountTab === 'recordings' && (
              <div className="account-section">
                {recordingsLoading
                  ? <div className="participants-empty">Загрузка...</div>
                  : myRecordings.length === 0
                    ? <div className="participants-empty">Записей пока нет. Нажмите «Запись» во время звонка.</div>
                    : <div className="calls-history-list">
                        {myRecordings.map(rec => {
                          const durSec = rec.endedAt ? Math.round((new Date(rec.endedAt) - new Date(rec.startedAt)) / 1000) : null;
                          return (
                            <div className="call-history-card" key={rec.id}>
                              <div className="call-history-room">
                                <Icon name="record" size={14} /> #{rec.roomId}
                              </div>
                              <div className="call-history-row">
                                <span>Дата</span>
                                <span>{new Date(rec.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                              <div className="call-history-row">
                                <span>Длительность</span>
                                <span>{rec.status === 'active' ? 'идёт запись…' : fmtDuration(durSec)}</span>
                              </div>
                              {rec.status === 'done' && rec.fileName && (
                                <div className="room-card-actions">
                                  <button className="ghost-btn room-card-btn" onClick={() => downloadRecording(rec.id)}>
                                    <Icon name="download" size={14} /> Видео
                                  </button>
                                  {rec.transcriptStatus !== 'done' && rec.transcriptStatus !== 'processing' && (
                                    <button className="ghost-btn room-card-btn" onClick={() => startTranscribe(rec.id)}>
                                      <Icon name="chat" size={14} /> {rec.transcriptStatus === 'failed' ? 'Повторить расшифровку' : 'Расшифровать'}
                                    </button>
                                  )}
                                  {rec.transcriptStatus === 'done' && Array.isArray(rec.transcript) && rec.transcript.length > 0 && (
                                    <>
                                      <button className="ghost-btn room-card-btn" onClick={() => downloadTranscript(rec, false)}>
                                        <Icon name="download" size={14} /> Текст
                                      </button>
                                      {rec.aiStatus === 'done' && Array.isArray(rec.transcriptAi) ? (
                                        <button className="ghost-btn room-card-btn" onClick={() => downloadTranscript(rec, true)}>
                                          <Icon name="download" size={14} /> Текст ИИ
                                        </button>
                                      ) : rec.aiStatus !== 'processing' && (
                                        <button className="ghost-btn room-card-btn" onClick={() => enhanceTranscript(rec.id)}>
                                          <Icon name="sparkles" size={14} /> {rec.aiStatus === 'failed' ? 'Повторить ИИ' : 'Улучшить ИИ'}
                                        </button>
                                      )}
                                      {rec.summaryStatus === 'done' && rec.summary ? (
                                        <button className="ghost-btn room-card-btn" onClick={() => downloadSummary(rec)}>
                                          <Icon name="download" size={14} /> Саммари
                                        </button>
                                      ) : rec.summaryStatus !== 'processing' && (
                                        <button className="ghost-btn room-card-btn" onClick={() => requestSummary(rec.id)}>
                                          <Icon name="notes" size={14} /> {rec.summaryStatus === 'failed' ? 'Повторить саммари' : 'Саммари ИИ'}
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                              {rec.transcriptStatus === 'processing' && (
                                <div className="transcript-status">
                                  <span className="spinner" /> Расшифровка речи… обычно 1–2 минуты на минуту записи
                                </div>
                              )}
                              {rec.aiStatus === 'processing' && (
                                <div className="transcript-status">
                                  <span className="spinner" /> ИИ исправляет ошибки распознавания…
                                </div>
                              )}
                              {rec.summaryStatus === 'processing' && (
                                <div className="transcript-status">
                                  <span className="spinner" /> ИИ составляет саммари звонка…
                                </div>
                              )}
                              {rec.transcriptStatus === 'done' && (!Array.isArray(rec.transcript) || rec.transcript.length === 0) && (
                                <div className="transcript-status">Речь не распознана (тишина или неразборчиво)</div>
                              )}
                              {(rec.aiStatus === 'failed' || rec.summaryStatus === 'failed') && (
                                <div className="transcript-status">
                                  {rec.aiStatus === 'failed' && rec.summaryStatus === 'failed'
                                    ? 'ИИ-обработка и саммари не удались'
                                    : rec.aiStatus === 'failed' ? 'ИИ-обработка не удалась' : 'Саммари не удалось'}
                                  {' — сервис ИИ был недоступен. Нажмите «Повторить», расшифровка при этом сохранена.'}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                }
              </div>
            )}

            {accountTab === 'rooms' && (
              <div className="account-section">
                {myRoomsLoading
                  ? <div className="participants-empty">Загрузка...</div>
                  : myRooms.length === 0
                    ? <div className="participants-empty">У вас пока нет комнат. Создайте приватную на главном экране.</div>
                    : <div className="calls-history-list">
                        {myRooms.map(r => (
                          <div className="call-history-card" key={r.slug}>
                            <div className="call-history-room">
                              <Icon name={r.isPrivate ? 'lock' : 'globe'} size={14} /> {r.name}
                            </div>
                            <div className="call-history-row"><span>ID</span><span>{r.slug}</span></div>
                            {r.members?.length > 0 && (
                              <div className="call-history-row"><span>Приглашены</span><span>{r.members.join(', ')}</span></div>
                            )}
                            <div className="room-card-actions">
                              <button className="ghost-btn room-card-btn" onClick={() => { setRoomId(r.slug); setIsAccountPanelOpen(false); }}>Войти</button>
                              <button className="ghost-btn room-card-btn" onClick={() => copyRoomLinkFor(r)}>Ссылка</button>
                              {r.ownerId === authUser?.id && (
                                <button className="ghost-btn room-card-btn room-card-btn--danger" onClick={() => deleteRoom(r.slug)}>Удалить</button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                }
              </div>
            )}

            {accountTab === 'history' && (
              <div className="account-section">
                {historyLoading
                  ? <div className="participants-empty">Загрузка...</div>
                  : callHistory.length === 0
                    ? <div className="participants-empty">История звонков пока пуста</div>
                    : <div className="calls-history-list">
                        {callHistory.map(s => (
                          <div className="call-history-card" key={s.id}>
                            <div className="call-history-room">#{s.roomId}</div>
                            <div className="call-history-row">
                              <span>Длительность</span>
                              <span>{fmtDuration(s.duration)}</span>
                            </div>
                            <div className="call-history-row">
                              <span>Дата</span>
                              <span>{new Date(s.joinedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                }
              </div>
            )}

          </aside>
        </div>
      )}

      {/* ── Chat overlay panel ── */}
      {isChatOpen && (
        <aside className="chat-overlay">
          <div className="chat-header">
            <div className="chat-title">Чат комнаты</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="chat-room">{roomId}</div>
              <button className="ghost-btn" style={{ height: 36, padding: '0 12px' }} onClick={() => setIsChatOpen(false)}><Icon name="close" size={16} /></button>
            </div>
          </div>
          <div className="chat-body chat-thread" ref={chatBodyRef}>
            {messages.length === 0
              ? <div className="chat-empty">Сообщений пока нет. Напишите первое сообщение.</div>
              : messages.map((msg, i) => {
                const isOwn = msg.userName === userName;
                // Имя показываем только у первого сообщения подряд от одного
                // человека — иначе лента превращается в частокол подписей.
                const prev = messages[i - 1];
                const startsGroup = !prev || prev.userName !== msg.userName;
                return (
                  <div
                    key={`${msg.timestamp}-${i}`}
                    className={`msg${isOwn ? ' msg--own' : ''}${startsGroup ? ' msg--start' : ''}`}
                  >
                    {startsGroup && !isOwn && <div className="msg-author">{msg.userName}</div>}
                    <div className="msg-bubble">
                      <span className="msg-text">{renderMessageText(msg.text)}</span>
                      <span className="msg-time">{msg.timestamp}</span>
                    </div>
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
              placeholder="Сообщение"
              disabled={!joined}
            />
            <button className="send-btn" onClick={sendMessage} disabled={!joined || !messageText.trim()} aria-label="Отправить">
              <Icon name="send" size={20} />
            </button>
          </div>
        </aside>
      )}

      {/* ── Settings panel ── */}
      {isSettingsOpen && (
        <aside className="chat-overlay settings-overlay">
          <div className="chat-header">
            <div className="chat-title"><Icon name="settings" size={17} /> Настройки</div>
            <button className="ghost-btn" style={{ height: 36, padding: '0 12px' }} onClick={() => setIsSettingsOpen(false)}><Icon name="close" size={16} /></button>
          </div>
          <div className="settings-tabs">
            {[['sound','Звук'],['video','Видео'],['users','Участники']].map(([id, label]) => (
              <button key={id} className={`tab-btn${settingsTab === id ? ' tab-btn--active' : ''}`} onClick={() => setSettingsTab(id)}>{label}</button>
            ))}
          </div>

          {settingsTab === 'sound' && (
            <div className="settings-body">
              <div className="settings-section-title">Громкость</div>
              <div className="settings-row">
                <label>Общая громкость</label>
                <div className="slider-wrap">
                  <input type="range" min="0" max="100" value={masterVolume}
                    onChange={e => setMasterVolume(Number(e.target.value))} />
                  <span>{masterVolume}%</span>
                </div>
              </div>
              <div className="settings-row">
                <label>Громкость звуков</label>
                <div className="slider-wrap">
                  <input type="range" min="0" max="100" value={applauseVolume}
                    onChange={e => setApplauseVolume(Number(e.target.value))} />
                  <span>{applauseVolume}%</span>
                </div>
              </div>
              <div className="settings-row">
                <label>Громкость участников</label>
                <div className="slider-wrap">
                  <input type="range" min="0" max="100" value={usersVolume}
                    onChange={e => setUsersVolume(Number(e.target.value))} />
                  <span>{usersVolume}%</span>
                </div>
              </div>
            </div>
          )}

          {settingsTab === 'video' && (
            <div className="settings-body">
              <div className="settings-section-title">Камера</div>
              <div className="settings-row settings-row--toggle">
                <label>Авто-включение камеры при входе</label>
                <Switch checked={autoEnableCamera} onChange={setAutoEnableCamera} label="Авто-включение камеры" />
              </div>
              <div className="settings-row settings-row--toggle">
                <label>Размытие фона{blurBusy ? ' …' : ''}</label>
                <Switch checked={blurEnabled} onChange={() => { if (!blurBusy && joined) toggleBlur(); }} label="Размытие фона" />
              </div>
            </div>
          )}

          {settingsTab === 'users' && (
            <div className="settings-body">
              <div className="settings-section-title">Управление участниками</div>
              <button className="primary-btn" style={{ width: '100%', marginBottom: 16 }} onClick={muteAll}>
                <Icon name="volumeOff" size={16} /> Заглушить всех
              </button>
              {allParticipants.filter(p => p !== livekitRoomRef.current?.localParticipant).length === 0
                ? <div className="participants-empty">Нет других участников</div>
                : allParticipants
                    .filter(p => p !== livekitRoomRef.current?.localParticipant)
                    .map(p => (
                      <div className="settings-user-row" key={p.identity}>
                        <span className="settings-user-name">{displayName(p)}</span>
                        <button
                          className={`toggle-btn${mutedUsers.has(p.identity) ? ' toggle-btn--off' : ' toggle-btn--on'}`}
                          onClick={() => toggleUserMute(p.identity)}
                        >
                          <><Icon name={mutedUsers.has(p.identity) ? 'volumeOff' : 'volume'} size={14} /> {mutedUsers.has(p.identity) ? 'Заглушён' : 'Слышен'}</>
                        </button>
                      </div>
                    ))
              }
            </div>
          )}
        </aside>
      )}

      {/* ── Sounds panel ── */}
      {isSoundsPanelOpen && (
        <div className="sounds-panel-backdrop" onClick={() => setIsSoundsPanelOpen(false)}>
          <div className="sounds-panel" onClick={e => e.stopPropagation()}>
            <div className="sounds-panel-title"><Icon name="music" size={18} /> Звуки</div>
            <div className="sounds-grid">
              {SOUNDS.map(s => (
                <button key={s.id} className="sound-btn" onClick={() => sendSound(s.id)}>
                  <span className="sound-btn-emoji">{s.emoji}</span>
                  <span className="sound-btn-label">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Pre-call setup (shown when not in call) ── */}
      {!joined && (
        <div className="precall-wrap">
          <div className="topbar">
            <div className="brand-row">
              <div className="brand">COMS</div>
              {businessMode && activeCompany && (
                <div className="business-badge">{activeCompany.name} · бизнес</div>
              )}
              {employeeMode && activeEmployeeCompany && (
                <div className="business-badge business-badge--emp">{activeEmployeeCompany.name} · сотрудник</div>
              )}
            </div>
            <div className="topbar-right">
              <div className="status-badge">{status}</div>
              <button className="ghost-btn theme-toggle-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} aria-label="Сменить тему">{theme === 'dark' ? '☀' : '☾'}</button>
              {/* у гостя нет аккаунта — показываем только выход из звонка */}
              {guestMode ? (
                <button className="ghost-btn logout-btn" onClick={() => { if (joined) leaveCall(); window.location.href = BASE; }}>
                  Выйти
                </button>
              ) : (
                <>
                  <button className="ghost-btn account-toggle-btn" onClick={() => setIsAccountPanelOpen(p => !p)}><Icon name="menu" size={16} /> Аккаунт</button>
                  <button className="ghost-btn logout-btn" onClick={() => {
                    localStorage.removeItem('token');
                    setAuthUser(null);
                    if (joined) leaveCall();
                  }}>Выйти</button>
                </>
              )}
            </div>
          </div>

          {/* Быстрый доступ по режиму: панель управления / кабинет сотрудника */}
          {businessMode && manageableCompanies.length > 0 && (
            <div className="mode-bar">
              {manageableCompanies.map(c => (
                <button key={c.slug} className="primary-btn mode-bar-btn" onClick={() => openAdmin(c)}>
                  <Icon name="menu" size={16} /> Панель управления{manageableCompanies.length > 1 ? ` · ${c.name}` : ''}
                </button>
              ))}
            </div>
          )}
          {employeeMode && canBeEmployee && (
            <div className="mode-bar">
              <button className="primary-btn mode-bar-btn" onClick={openEmployee}>
                <Icon name="users" size={16} /> Кабинет сотрудника
              </button>
            </div>
          )}

          <div className="setup-card">
            <div className="field-group">
              <label>Ваше имя</label>
              <input value={userName} onChange={e => setUserName(e.target.value)} placeholder="Введите имя" />
            </div>
            <div className="field-group">
              <label>ID комнаты</label>
              <input value={roomId} onChange={e => setRoomId(e.target.value)} placeholder="Введите ID комнаты" />
              {roomInfo?.exists && (
                <div className={`room-badge${roomInfo.isPrivate ? ' room-badge--private' : ''}`}>
                  <Icon name={roomInfo.isPrivate ? 'lock' : 'globe'} size={13} /> {roomInfo.isPrivate ? 'Приватная' : 'Открытая'} · {roomInfo.name}
                  {roomInfo.isPrivate && !roomInfo.hasAccess && !knocking && ' — вход по ссылке или по запросу'}
                </div>
              )}
            </div>

            <div className="setup-actions">
              <button className="primary-btn" onClick={joinRoom} disabled={knocking}>
                {knocking ? 'Ждём владельца...' : 'Войти в комнату'}
              </button>
              {/* создание комнат и контакты — только для владельцев аккаунта */}
              {!guestMode && (
                <>
                  <button className="ghost-btn" onClick={createPrivateRoom}><Icon name="lock" size={16} /> Создать приватную комнату</button>
                  <button className="ghost-btn" onClick={copyRoomLink}>{copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</button>
                  <button className={`ghost-btn${isContactsOpen ? ' active' : ''}`} onClick={() => setIsContactsOpen(p => !p)}>
                    <Icon name="users" size={16} /> Контакты{contacts.length > 0 ? ` (${contacts.length})` : ''}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Ближайшие встречи компаний */}
          {(businessMode || employeeMode) && upcomingMeetings.length > 0 && (
            <div className="upcoming-card">
              <div className="upcoming-title">Ближайшие встречи</div>
              {upcomingMeetings.map(m => {
                const soon = new Date(m.scheduledAt) - new Date() < 15 * 60 * 1000;
                return (
                  <div className="upcoming-row" key={m.id}>
                    <div className="upcoming-info">
                      <div className="upcoming-name">{m.title}</div>
                      <div className="upcoming-time">{new Date(m.scheduledAt).toLocaleString('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
                    </div>
                    <button className={soon ? 'primary-btn upcoming-btn' : 'ghost-btn upcoming-btn'}
                      onClick={() => { inviteKeyRef.current = m.inviteKey; setRoomId(m.roomSlug); setStatus(`Встреча «${m.title}» — нажмите «Войти в комнату»`); }}>
                      {soon ? 'Присоединиться' : 'Открыть'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── In-call fullscreen layout ── */}
      {joined && (
        <div
          className={`call-fullscreen${controlsVisible ? '' : ' controls-hidden'}`}
          onMouseMove={isTouchDevice ? undefined : onDesktopMouseMove}
        >
          {/* Top bar (overlay, авто-скрытие) */}
          <div className="call-topbar" onClick={e => e.stopPropagation()}>
            <div className="call-topbar-left">
              <div className="brand" style={{ fontSize: 18 }}>COMS</div>
              <div className="call-room-badge">{roomId}</div>
              <button className="call-link-btn" title="Скопировать ссылку на звонок" onClick={() => { copyRoomLink(); setStatus('Ссылка скопирована'); }}>
                <Icon name="link" size={14} />
              </button>
              <div className="call-timer">{formattedCallTime}</div>
              {connQuality !== 'excellent' && (
                <div className={`conn-badge conn-badge--${connQuality}`} title="Качество вашего соединения">
                  {connQuality === 'good' ? 'сеть: средне' : 'сеть: слабо'}
                </div>
              )}
              {recActive && (
                <div className="rec-indicator" title={`Запись включил ${recStartedBy}`}>
                  <span className="rec-dot" /> REC
                </div>
              )}
            </div>
            <div className="call-topbar-right">
              {status !== 'Подключено' && <div className="status-badge">{status}</div>}
              <button className="ghost-btn" style={{ height: 36, padding: '0 12px' }} title="Участники" onClick={() => setIsParticipantsOpen(p => !p)}><Icon name="users" size={16} /> {allParticipants.length}</button>
              <button className="ghost-btn" style={{ height: 36, padding: '0 12px' }} onClick={() => { setAccountTab('profile'); setIsAccountPanelOpen(p => !p); }}><Icon name="menu" size={16} /></button>
            </div>
          </div>

          {/* Floating emoji reactions */}
          <div className="floating-reactions" aria-hidden="true">
            {floatingReactions.map(r => (
              <span key={r.id} className="floating-reaction" style={{ left: `${r.x}%` }}>{r.emoji}</span>
            ))}
          </div>

          {/* Action messages (join/leave/applause) */}
          <div className="action-messages">
            {actionMessages.map(m => (
              <div key={m.id} className="action-msg">{m.msg}</div>
            ))}
          </div>

          {/* Always-on audio for remote participants */}
          <div style={{ display: 'none' }}>
            {allParticipants
              .filter(p => p !== livekitRoomRef.current?.localParticipant)
              .map(p => (
                <RemoteAudio
                  key={p.identity}
                  participant={p}
                  volume={(usersVolume / 100) * (masterVolume / 100)}
                  localMuted={mutedUsers.has(p.identity)}
                />
              ))}
          </div>

          {/* Video area — full window; тап (телефон) показывает/прячет управление */}
          <div ref={stageRef} className={`video-stage${isScreenFullscreen ? ' video-stage--fs' : ''}`} onClick={isTouchDevice ? onStageTap : undefined}>
            {screenSharePresenter ? (
              <div className="presenter-layout">
                <ScreenShareTile
                  participant={screenSharePresenter}
                  isLocal={screenSharePresenter === livekitRoomRef.current?.localParticipant}
                />
                <button
                  className="screen-fullscreen-btn"
                  title={isScreenFullscreen ? 'Свернуть' : 'На весь экран'}
                  onClick={() => setIsScreenFullscreen(v => !v)}
                >
                  {isScreenFullscreen ? '↙ Свернуть' : '↗ На весь экран'}
                </button>

                {isScreenFullscreen && (
                  <div className="fs-controls">
                    <button className={`fs-btn ${isMuted ? 'fs-btn--off' : ''}`} onClick={toggleMute}>
                      <span className="fs-btn-icon"><Icon name={isMuted ? 'micOff' : 'mic'} size={18} /></span>
                      <span className="fs-btn-label">{isMuted ? 'Вкл' : 'Выкл'}</span>
                    </button>
                    <button className={`fs-btn ${isCameraOff ? 'fs-btn--off' : ''}`} onClick={toggleCamera}>
                      <span className="fs-btn-icon"><Icon name={isCameraOff ? 'cameraOff' : 'camera'} size={18} /></span>
                      <span className="fs-btn-label">{isCameraOff ? 'Вкл' : 'Выкл'}</span>
                    </button>
                    <button className="fs-btn fs-btn--applause" onClick={() => setIsSoundsPanelOpen(p => !p)}>
                      <span className="fs-btn-icon"><Icon name="music" size={18} /></span>
                      <span className="fs-btn-label">Звуки</span>
                    </button>
                    <button className={`fs-btn ${isChatOpen ? 'fs-btn--active' : ''}`} onClick={() => setIsChatOpen(p => !p)}>
                      <span className="fs-btn-icon"><Icon name="chat" size={18} /></span>
                      <span className="fs-btn-label">Чат</span>
                    </button>
                    <button className="fs-btn fs-btn--danger" onClick={() => { setIsScreenFullscreen(false); leaveCall(); }}>
                      <span className="fs-btn-icon"><Icon name="phoneOff" size={18} /></span>
                      <span className="fs-btn-label">Завершить</span>
                    </button>
                  </div>
                )}
                {!isScreenFullscreen && (
                  <div className="camera-strip">
                    {allParticipants.map(p => (
                      <ParticipantTile
                        key={p.identity}
                        participant={p}
                        isLocal={p === livekitRoomRef.current?.localParticipant}
                        isFrontCamera={isFrontCamera}
                        small
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : speakerMode ? (
              /* Много участников на телефоне: один крупно, остальные лентой.
                 Выбор главного — тап по миниатюре: тап по большому видео
                 уже переключает панель управления. */
              <div className="speaker-layout">
                <div className="speaker-main">
                  <ParticipantTile
                    key={mainParticipant.identity}
                    participant={mainParticipant}
                    isFrontCamera={isFrontCamera}
                    localMuted={mutedUsers.has(mainParticipant.identity)}
                    onToggleMute={() => toggleUserMute(mainParticipant.identity)}
                    onMeta={onTileMeta}
                  />
                  {pinnedId && (
                    <button className="pin-chip" onClick={(e) => { e.stopPropagation(); setPinnedId(null); }}>
                      Закреплён: {displayName(mainParticipant)} <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
                <div className="speaker-strip">
                  {stripParticipants.map(p => (
                    <button
                      key={p.identity}
                      className="speaker-thumb"
                      onClick={(e) => { e.stopPropagation(); setPinnedId(p.identity); }}
                      aria-label={`Показать крупно: ${displayName(p)}`}
                    >
                      <ParticipantTile participant={p} isFrontCamera={isFrontCamera} onMeta={onTileMeta} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /* Рядная раскладка без обрезки: плитка принимает пропорцию
                 потока, ряд заполняет ширину, неполный ряд центрируется. */
              <div className="tile-rows">
                {pack && pack.rows.map((row, ri) => (
                  <div className="tile-row" key={ri} style={{ height: Math.round(pack.heights[ri]) }}>
                    {row.map(idx => {
                      const p = visible[idx];
                      const h = pack.heights[ri];
                      const a = tileAspect[p.identity] || DEFAULT_ASPECT;
                      return (
                        <ParticipantTile
                          key={p.identity}
                          participant={p}
                          isFrontCamera={isFrontCamera}
                          localMuted={mutedUsers.has(p.identity)}
                          onToggleMute={() => toggleUserMute(p.identity)}
                          onMeta={onTileMeta}
                          gridSpan={{ width: Math.round(a * h), height: Math.round(h), flex: '0 0 auto' }}
                        />
                      );
                    })}
                  </div>
                ))}
                {/* Выключенная камера не занимает место в сетке — только
                    маленький квадрат снизу, чтобы человек не пропал совсем */}
                {cameraOff.length > 0 && (
                  <div className="off-row">
                    {cameraOff.map(p => (
                      <div className="off-chip" key={p.identity} title={displayName(p)}>
                        <span className="off-chip-letter">{(displayName(p) || '?')[0].toUpperCase()}</span>
                        <span className="off-chip-name">{displayName(p)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Своё видео — всегда плавающее окно, в сетку не попадает.
                Тап увеличивает втрое, фон за ним затемняется и размывается. */}
            {localP && (
              <>
                {selfBig && <div className="self-scrim" onClick={(e) => { e.stopPropagation(); setSelfBig(false); }} />}
                <div
                  className={`self-pip${selfBig ? ' self-pip--big' : ''}${selfDragging ? ' self-pip--drag' : ''}`}
                  style={!selfBig && selfPos ? { left: selfPos.x, top: selfPos.y, right: 'auto', bottom: 'auto' } : undefined}
                  onPointerDown={onSelfPointerDown}
                  onClick={(e) => { e.stopPropagation(); if (selfBig) setSelfBig(false); }}
                >
                  <ParticipantTile participant={localP} isLocal isFrontCamera={isFrontCamera} onMeta={onTileMeta} />
                </div>
              </>
            )}
          </div>

          {/* Controls bar — иконки, overlay, авто-скрытие */}
          <div className="controls-bar" onClick={e => { e.stopPropagation(); revealControls(); }}>
            {/* Попап реакций — сосед сетки, а не потомок кнопки: раньше он
                центрировался по кнопке шириной 48px и уезжал за край экрана */}
            {isReactionsOpen && (
              <div className="reactions-popover" onClick={e => e.stopPropagation()}>
                {REACTIONS.map(e => (
                  <button key={e} className="reaction-btn" onClick={() => sendReaction(e)}>{e}</button>
                ))}
              </div>
            )}
            <div className="controls-grid">
            <button className={`ctrl-round ${isMuted ? 'ctrl-round--off' : ''}`} title={isMuted ? 'Включить микрофон' : 'Выключить микрофон'} onClick={toggleMute}>
              <Icon name={isMuted ? 'micOff' : 'mic'} size={22} />
            </button>
            <button className={`ctrl-round ${isCameraOff ? 'ctrl-round--off' : ''}`} title={isCameraOff ? 'Включить камеру' : 'Выключить камеру'} onClick={toggleCamera}>
              <Icon name={isCameraOff ? 'cameraOff' : 'camera'} size={22} />
            </button>
            <button className="ctrl-round" title="Сменить камеру" onClick={switchCamera} disabled={isSharingScreen}>
              <Icon name="flip" size={22} />
            </button>
            {/* На iOS getDisplayMedia не существует — кнопку не показываем вовсе,
                чтобы не предлагать заведомо нерабочее действие */}
            {!IS_IOS && (
              <button className={`ctrl-round ${isSharingScreen ? 'ctrl-round--active' : ''}`} title="Демонстрация экрана" onClick={startScreenShare}>
                <Icon name="screen" size={22} />
              </button>
            )}
            {/* Ради одних аплодисментов панель открывать незачем: на iOS
                остальные звуки вырезаны из сборки (чужие права на голос) */}
            {SOUNDS.length > 1 && (
              <button className={`ctrl-round ${isSoundsPanelOpen ? 'ctrl-round--active' : ''}`} title="Звуки" onClick={() => setIsSoundsPanelOpen(p => !p)}>
                <Icon name="music" size={22} />
              </button>
            )}
            <button className={`ctrl-round ${isReactionsOpen ? 'ctrl-round--active' : ''}`} title="Реакции" onClick={() => setIsReactionsOpen(p => !p)}>
              <Icon name="smile" size={22} />
            </button>
            <button className={`ctrl-round ${isChatOpen ? 'ctrl-round--active' : ''}`} title="Чат" onClick={() => setIsChatOpen(p => !p)}>
              <Icon name="chat" size={22} />
              {messages.length > 0 && <span className="ctrl-badge">{messages.length}</span>}
            </button>
            <button className={`ctrl-round ${isSettingsOpen ? 'ctrl-round--active' : ''}`} title="Настройки" onClick={() => setIsSettingsOpen(p => !p)}>
              <Icon name="settings" size={22} />
            </button>
            {/* запись доступна только пользователям с аккаунтом — файл попадает в их аккаунт */}
            {!guestMode && (
              <button
                className={`ctrl-round ${recActive ? 'ctrl-round--rec' : ''}`}
                onClick={toggleRecording}
                disabled={recBusy}
                title={recActive ? `Остановить запись (включил ${recStartedBy})` : 'Записать звонок'}
              >
                <Icon name={recActive ? 'stop' : 'record'} size={22} />
              </button>
            )}
            {/* Сброс — последняя кнопка сетки: на телефоне он встаёт
                в правый нижний угол, отдельный ряд под него не нужен */}
            <button className="ctrl-round ctrl-round--danger" title="Завершить звонок" aria-label="Завершить звонок" onClick={leaveCall}>
              <Icon name="phoneOff" size={22} />
            </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
