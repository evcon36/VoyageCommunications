import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';
import { LK, loadLiveKit, prefetchLiveKit } from './livekit';
import { serverUrl, apiFetch, mediaOrigin, onOriginChange, pickOrigin } from './net';
// @livekit/track-processors загружается лениво при включении размытия —
// статический импорт ломает старт на части браузеров (WASM-инициализация)
import './App.css';
import Icon from './Icons';
import AuthPage from './components/AuthPage';
import { getMe } from './services/auth';
import { getAltDomainUrl, ALT_DOMAIN_HINT, buildInviteLink } from './altDomain';

const BASE = import.meta.env.VITE_BASE_PATH || '/communications/';

// iPad с iPadOS 13+ представляется как MacIntel, поэтому проверяем ещё и тачи.
const IS_IOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// Сокет раньше поднимался сразу при загрузке файла, то есть ДО того, как
// выяснено, какой вход работает. Он уходил на адрес по умолчанию и, если тот
// у оператора закрыт, честно долбился в него с повторами, показывая «не
// дозвонились до сервера». Теперь ждём выбора входа: задержка меньше
// полусекунды, зато первый же запрос идёт по рабочему адресу.
// На айфоне обычные запросы идут через системную сеть, а не через страницу
// (иначе там не уходит ни один запрос сложнее простого GET). Запасной
// транспорт сокета устроен на тех же запросах и после такой подмены ломается,
// поэтому на айфоне оставляем только вебсокет. Android работает по-обычному,
// там запасной транспорт нужен и его не трогаем.
const IS_IOS_APP = window.Capacitor?.getPlatform?.() === 'ios';
const socket = io(serverUrl(), {
  transports: IS_IOS_APP ? ['websocket'] : ['websocket', 'polling'],
  autoConnect: false,
});
pickOrigin().then((origin) => {
  try { socket.io.uri = origin; socket.io.opts.host = undefined; } catch { /* адрес не сменился */ }
  socket.connect();
});

// Если запросы к серверу переехали на другой вход, сокет обязан переехать
// следом. Иначе получается худший случай: приложение живо, экраны работают,
// а звонки не доходят, потому что сокет висит на мёртвом адресе.
onOriginChange((origin) => {
  try {
    socket.io.uri = origin;
    socket.io.opts.host = undefined;   // иначе socket.io соберёт адрес из старых частей
    socket.disconnect().connect();
  } catch (e) {
    console.error('Не удалось перевести сокет на новый адрес:', e?.message);
  }
});

// identity приходит с суффиксом (#a1b2) для уникальности устройств,
// отображаем человеку только имя
const displayName = (p) => p?.name || String(p?.identity || '').split('#')[0];

// Эмодзи-реакции в звонке
const REACTIONS = ['❤️', '👍', '😂', '😮', '👏', '✋'];

// кликабельные ссылки в тексте чата
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
// Отдельная копия без флага g: у общего регэкспа с g сохраняется lastIndex
// между вызовами test, и ссылки то оборачивались в кликабельные, то нет.
const URL_ONE = /^https?:\/\/[^\s<>"']+$/;
function renderMessageText(text) {
  const parts = String(text).split(URL_RE);
  return parts.map((part, i) =>
    URL_ONE.test(part)
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
  return /^(https?:|data:|blob:)/.test(path) ? path : `${mediaOrigin()}${path}`;
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
  busy: 'Сейчас занят',
  'busy-self': 'Вы уже в разговоре. Сначала завершите текущий звонок',
  unavailable: 'Сейчас не в сети',
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

// ── Плавающее окно своей камеры (только на телефоне) ──
// Длинная сторона задана, короткая считается из пропорции потока: окно
// принимает форму камеры, и видео в нём никогда не обрезается.
const SELF_LONG = 156;
const SELF_ZOOM = 3;         // во сколько раз увеличивается по тапу
const PIP_MARGIN = 12;
const SELF_MODE_KEY = 'coms-self-mode';

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
  if (/permission|notallowed|notfound|notreadable|device/i.test(m)) {
    return 'нет доступа к камере или микрофону. Разрешите его в настройках';
  }
  // Сообщение библиотеки на английском и человеку ничего не объясняет, но
  // без него нельзя понять, на чём именно рвётся: на телефоне консоли нет.
  // Поэтому короткий технический хвост остаётся на экране, а полный текст
  // кладём в буфер по нажатию на сообщение.
  console.error('connect error:', m);
  const tail = m.replace(/\s+/g, ' ').slice(0, 70);
  return `не удалось войти в звонок. Попробуйте ещё раз${tail ? ` · ${tail}` : ''}`;
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
    // Уменьшать надо только сами плитки: зазоры между рядами не сжимаются.
    // Если делить всю высоту вместе с ними, сетка вылезает за экран на
    // высоту зазоров, и последний ряд подрезается снизу.
    const gaps = gap * (rows.length - 1);
    const sumH = heights.reduce((a, b) => a + b, 0);
    const scale = Math.min(1, Math.max(0, H - gaps) / sumH);
    const finalH = heights.map(h => h * scale);
    const total = sumH * scale + gaps;

    let minArea = Infinity;
    rows.forEach((row, i) => row.forEach(idx => {
      minArea = Math.min(minArea, aspects[idx] * finalH[i] * finalH[i]);
    }));
    // берём раскладку, где самая мелкая плитка крупнее всего — так никто
    // не оказывается в «щели», пока сосед занимает пол-экрана
    if (!best || minArea > best.minArea) {
      best = { rows, heights: finalH, minArea, total };
    }
  }
  return best;
}

// --- Persistent audio for remote participants (always mounted) ---
function RemoteAudio({ participant, volume = 1, localMuted = false }) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (!participant) return;
    // Элемент запоминаем сейчас: к моменту уборки ref уже может указывать
    // на другой узел, и отвязали бы мы не то.
    const el = audioRef.current;
    let attached = null;
    const attach = () => {
      const audioPub = participant.getTrackPublication(LK.Track.Source.Microphone);
      if (audioPub?.track && audioPub.isSubscribed && el) {
        audioPub.track.attach(el);
        attached = audioPub.track;
      }
    };
    attach();
    participant.on('trackSubscribed', attach);
    participant.on('trackPublished', attach);
    return () => {
      participant.off('trackSubscribed', attach);
      participant.off('trackPublished', attach);
      // Без отвязки трек продолжал держать ссылку на удалённый из DOM
      // элемент, и за долгий звонок с перезаходами их копилось много.
      if (attached && el) { try { attached.detach(el); } catch { /* трек уже мёртв */ } }
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
// Пустой раздел: короткий заголовок, объяснение и ровно одно действие.
// Абзац серым текстом читался как «здесь ничего нет и не будет», а не как
// «начните отсюда»: человек не понимал, сломано это или просто пусто.
// Оповещение о звонке средствами системы: на Windows через мост настольного
// приложения, на Android через родной плагин. В браузере ничего этого нет, и
// вызовы просто ничего не делают.
function callPlugin() {
  return window.Capacitor?.Plugins?.CallNotifier || null;
}
function notifyIncoming(from) {
  window.comsDesktop?.incomingCall?.({ from });
  callPlugin()?.show({ from }).catch(() => { /* нет разрешения на уведомления */ });
}
function clearIncomingNotice() {
  window.comsDesktop?.callEnded?.();
  callPlugin()?.hide().catch(() => { /* уведомления и не было */ });
}

function EmptyState({ title, text, actionLabel, onAction }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      {text && <div className="empty-state-text">{text}</div>}
      {actionLabel && onAction && (
        <button className="primary-btn empty-state-btn" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

function ScreenShareTile({ participant, isLocal }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!participant) return;
    let attached = null;

    const attach = () => {
      const pub = participant.getTrackPublication(LK.Track.Source.ScreenShare);
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
function ParticipantTile({ participant, isLocal, isFrontCamera, small, localMuted, onToggleMute, backdrop, gridSpan, onMeta, onClick }) {
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
      const cameraPub = participant.getTrackPublication(LK.Track.Source.Camera);
      const micPub = participant.getTrackPublication(LK.Track.Source.Microphone);

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
    const pub = participant.getTrackPublication(LK.Track.Source.Camera);
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
      className={`participant-tile${small ? ' participant-tile--small' : ''}${isSpeaking ? ' participant-tile--speaking' : ''}${onClick ? ' participant-tile--tappable' : ''}`}
      style={{ ...(videoAspect ? { '--tile-aspect': videoAspect } : null), ...gridSpan }}
      onClick={onClick}
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
  // Пустое: человеку без аккаунта нечего подставлять, а чужое имя в поле
  // он не заметит и войдёт в звонок под ним
  const [userName, setUserName] = useState('');

  // ── Гостевой вход по ссылке (без аккаунта) ──
  // Пускаем только по полной ссылке-приглашению: нужен и номер комнаты, и ключ.
  const guestInvite = useRef({
    room: new URLSearchParams(window.location.search).get('room') || '',
    key: new URLSearchParams(window.location.search).get('key') || '',
  }).current;
  const hasGuestInvite = Boolean(guestInvite.room && guestInvite.key);
  const [guestMode, setGuestMode] = useState(false);   // вошли как гость
  const [showAuth, setShowAuth] = useState(false);     // человек сам нажал «Войти»
  const [guestDismissed, setGuestDismissed] = useState(false); // выбрали «войти в аккаунт»
  const [guestNameInput, setGuestNameInput] = useState('');
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState('');
  // Номер гостя нужен приёмной, чтобы «впустить» относилось именно к этому
  // человеку, и медиасерверу, чтобы отличать гостей друг от друга.
  //
  // Раньше клиент придумывал его сам. Из-за этого чужой номер, видный в списке
  // участников, можно было присвоить и выкидывать человека из звонка. Теперь
  // номер выдаёт и подписывает сервер, а мы только храним выданный.
  const guestIdRef = useRef((() => {
    try { return localStorage.getItem('coms.guestId') || ''; } catch { return ''; }
  })());
  const rememberGuestId = (id) => {
    if (!id || id === guestIdRef.current) return;
    guestIdRef.current = id;
    try { localStorage.setItem('coms.guestId', id); } catch { /* приватный режим */ }
  };

  // Токен комнаты подтверждает право быть здесь: его же спрашивают сокет и
  // отправка файлов, иначе в комнату мог зайти любой, кто знает название
  const roomTokenRef = useRef(null);

  const [joined, setJoined] = useState(false);
  const joinedRef = useRef(false);              // для обработчиков сокета
  const joinPayloadRef = useRef(null);          // чем повторно войти после реконнекта
  joinedRef.current = joined;
  const [status, setStatus] = useState('Готово к звонку');
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
  const chatOpenRef = useRef(false);   // обработчик сокета не видит свежее состояние
  // По той же причине: обработчик ставится один раз, а настройка меняется
  const chatPopupsRef = useRef(true);
  const myIdRef = useRef(null);
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
  // Всплывающие сообщения чата. По умолчанию включены: чат в звонке обычно
  // закрыт, и без всплытия сообщение замечают уже после разговора. Отключить
  // можно в настройках: кому-то это мешает во время показа экрана.
  const [chatPopups, setChatPopups] = useState(() => localStorage.getItem('chatPopups') !== 'false');
  const [chatToasts, setChatToasts] = useState([]);
  const toastTimerRef = useRef(null);
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
  // Обработчики сокета регистрируются один раз и не видят свежий call.
  // Им нужна актуальная копия: иначе решения принимаются по состоянию
  // первого рендера.
  const callRef = useRef(null);
  callRef.current = call;
  const [callNotice, setCallNotice] = useState('');   // «Отклонён», «Занят» и т.п.
  const [callLeft, setCallLeft] = useState(0);        // сколько секунд осталось звонить
  // Доступ к камере и микрофону отклонён: iOS не даёт спросить повторно,
  // вернуть можно только в настройках системы — объясняем это пользователю.
  const [mediaBlocked, setMediaBlocked] = useState(false);
  // Очередь стучащихся у владельца. Раньше здесь лежал один запрос, и когда
  // просились несколько человек, каждый следующий затирал предыдущего: те,
  // кого затёрло, ждали до таймаута, хотя владелец был на месте.
  const [knockQueue, setKnockQueue] = useState([]);       // [{ username, name, roomId }]
  const knockRequest = knockQueue[0] || null;
  const dropKnock = () => setKnockQueue(prev => prev.slice(1));
  const [knocking, setKnocking] = useState(false);        // мы ждём, когда впустят
  // Комната ожидания
  const [waitingForHost, setWaitingForHost] = useState(false);       // мы в приёмной
  const waitingRetryRef = useRef(null);                              // { slug, key } для повтора
  const waitTimeoutRef = useRef(null);                               // чтобы приёмная не висела вечно
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
    // Сначала выясняем, какой вход отвечает: оба пробуются одновременно, а не
    // по очереди. Раньше перебор шёл последовательно, и когда первый вход у
    // оператора молчал, запуск упирался в его полный таймаут — отсюда десять
    // секунд тишины на экране проверки.
    await pickOrigin();
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
      const resp = await apiFetch(`/rooms/history`, { headers: { Authorization: `Bearer ${token}` } });
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
      // Запуск записи идёт около пяти секунд: сервер убеждается, что она
      // реально пошла. Ждём дольше обычного и не повторяем на другом входе,
      // иначе поверх работающей записи запускается вторая.
      const resp = await apiFetch(`${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roomId: roomIdRef.current }),
      }, { timeout: 25000, retry: false });
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
      const resp = await apiFetch(`/recordings/status/${encodeURIComponent(rid)}`, {
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
      const resp = await apiFetch(`/recordings/my`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        setMyRecordings(data.recordings || []);
      }
    } catch {}
    finally { setRecordingsLoading(false); }
  }, []);

  // Итог последней встречи теперь на главном экране, поэтому записи нужны
  // сразу после входа, а не только при открытии раздела с записями.
  useEffect(() => { if (authUser) fetchMyRecordings(); }, [authUser, fetchMyRecordings]);

  useEffect(() => {
    if (isAccountPanelOpen && accountTab === 'recordings') fetchMyRecordings();
  }, [isAccountPanelOpen, accountTab, fetchMyRecordings]);

  // опрос статуса обработки (расшифровка или ИИ), пока идёт
  const pollTranscript = useCallback((recId, field = 'transcriptStatus') => {
    const token = localStorage.getItem('token');
    const iv = setInterval(async () => {
      try {
        const r = await apiFetch(`/recordings/${recId}/transcript`, { headers: { Authorization: `Bearer ${token}` } });
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
  // Расшифровку и итоги можно было только скачать файлом: то, ради чего
  // продукт и нужен, пряталось за кнопкой загрузки, и человек не видел
  // результата, пока не откроет его в другой программе.
  const [openRec, setOpenRec] = useState(null);   // id раскрытой записи
  const [recView, setRecView] = useState('summary'); // что показываем: итоги или расшифровка
  const [recSearch, setRecSearch] = useState('');

  const fmtTime = (sec) => {
    const m = Math.floor(sec / 60), ss = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };

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
      const resp = await apiFetch(`/recordings/${recId}/summary`, {
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
      setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  // скачать саммари файлом
  const downloadSummary = (rec) => {
    if (!rec.summary) return;
    const blob = new Blob(['﻿' + `Итоги звонка #${rec.roomId}\nДата: ${new Date(rec.startedAt).toLocaleString('ru-RU')}\n\n` + rec.summary], { type: 'text/plain;charset=utf-8' });
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
      const resp = await apiFetch(`/recordings/${recId}/enhance`, {
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
      setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите');
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
      const r = await apiFetch(`/auth/account/deletion-preview`, {
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
      const r = await apiFetch(`/auth/account/delete`, {
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
      setDelError('Нет связи с сервером. Проверьте интернет и повторите');
    } finally {
      setDelBusy(false);
    }
  };

  const restoreAccount = async () => {
    setDelBusy(true);
    try {
      const token = localStorage.getItem('token');
      const r = await apiFetch(`/auth/account/restore`, {
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
      const resp = await apiFetch(`/recordings/${recId}/link`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok || !d.url) {
        setProfileMsg(d.message || 'Не удалось получить ссылку на запись');
        setTimeout(() => setProfileMsg(''), 3500);
        return;
      }
      window.location.href = `${mediaOrigin()}${d.url}`;
    } catch {
      setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  const startTranscribe = async (recId) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await apiFetch(`/recordings/${recId}/transcribe`, {
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
      setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите');
      setTimeout(() => setProfileMsg(''), 3000);
    }
  };

  // ── Бизнес: компании ──
  const fetchCompanies = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setCompaniesLoading(true);
    try {
      const resp = await apiFetch(`/companies/my`, { headers: { Authorization: `Bearer ${token}` } });
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
      const resp = await apiFetch(`/companies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      });
      const d = await resp.json();
      if (resp.ok) { setNewCompanyName(''); setCompanies(prev => [{ ...d.company, myRole: 'owner' }, ...prev]); setProfileMsg('Компания создана'); }
      else setProfileMsg(d.message || 'Ошибка');
    } catch { setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите'); }
    setTimeout(() => setProfileMsg(''), 2500);
  };

  const inviteToCompany = async (slug) => {
    const uname = (companyInvite[slug] || '').trim();
    if (!uname) return;
    const token = localStorage.getItem('token');
    try {
      const resp = await apiFetch(`/companies/${slug}/invite`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: uname, role: 'member' }),
      });
      const d = await resp.json();
      if (resp.ok) { setCompanyInvite(p => ({ ...p, [slug]: '' })); fetchCompanies(); setProfileMsg(d.message); }
      else setProfileMsg(d.message || 'Ошибка');
    } catch { setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите'); }
    setTimeout(() => setProfileMsg(''), 2500);
  };

  const removeCompanyMember = async (slug, username) => {
    const token = localStorage.getItem('token');
    try {
      await apiFetch(`/companies/${slug}/members/${encodeURIComponent(username)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      fetchCompanies();
    } catch {}
  };

  const setCompanyAccent = async (slug, accent) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await apiFetch(`/companies/${slug}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ accent }),
      });
      if (resp.ok) setCompanies(prev => prev.map(c => c.slug === slug ? { ...c, accent } : c));
    } catch {}
  };

  const deleteCompany = async (slug) => {
    const token = localStorage.getItem('token');
    try {
      const resp = await apiFetch(`/companies/${slug}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
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
    const r = await apiFetch(`${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? r.json() : null;
  };
  const apiSend = async (path, method, body) => {
    const token = localStorage.getItem('token');
    const r = await apiFetch(`${path}`, {
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
      // Раньше ответ сервера не проверялся: при отказе (не владелец комнаты)
      // человек всё равно видел «удалён», а участник оставался в звонке.
      const resp = await apiFetch(`/rooms/moderate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roomId: roomIdRef.current, targetIdentity: identity, action: 'remove' }),
      });
      if (!resp.ok) {
        setStatus(resp.status === 403 ? 'Удалять участников может только владелец комнаты' : 'Не удалось удалить участника');
        return;
      }
      setStatus('Участник удалён из звонка');
    } catch { setStatus('Не удалось удалить участника'); }
  };

  // Мои комнаты (вкладка в аккаунте)
  const fetchMyRooms = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setMyRoomsLoading(true);
    try {
      const resp = await apiFetch(`/rooms/my`, { headers: { Authorization: `Bearer ${token}` } });
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
      const resp = await apiFetch(`/rooms/${encodeURIComponent(slug)}`, {
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
      const resp = await apiFetch(`/auth/profile`, {
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
      setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите');
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
        const resp = await apiFetch(`/auth/avatar`, {
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
        setProfileMsg('Нет связи с сервером. Проверьте интернет и повторите');
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
        const resp = await apiFetch(`/rooms/info/${encodeURIComponent(roomId.trim())}`, {
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

  // Комната без аккаунта: живёт 40 минут и вмещает 5 человек. Лимиты ставит
  // сервер и не снимает их потом, поэтому здесь только показываем их человеку.
  const [guestLimits, setGuestLimits] = useState(null);

  // Ошибка и успех выглядели одинаково: зелёная точка стояла всегда, что бы
  // ни случилось. Вид выводим из текста, чтобы не править полсотни мест, где
  // статус ставится, и чтобы новые сообщения тоже попадали в нужный вид.
  const statusKind = (text) => {
    const t = String(text || '').toLowerCase();
    if (/ошибка|не удалось|истекла|недоступ|вышло|прерв|отказ|нет доступа/.test(t)) return 'error';
    if (/ожида|осталось|заканчивается|слишком много|проверьте/.test(t)) return 'warn';
    return 'ok';
  };

  const createGuestRoom = async () => {
    try {
      const resp = await apiFetch(`/rooms/guest-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: userName.trim() ? `Звонок: ${userName.trim()}` : 'Быстрый звонок',
          guestId: guestIdRef.current,
        }),
      });
      if (resp.status === 429) { setStatus('Слишком много комнат подряд. Попробуйте позже'); return null; }
      if (!resp.ok) { setStatus('Не удалось создать комнату'); return null; }
      const { room, limits, guestId } = await resp.json();
      rememberGuestId(guestId);
      inviteKeyRef.current = room.inviteKey;
      setRoomId(room.slug);
      setGuestLimits({ ...limits, expiresAt: room.expiresAt });
      setRoomInfo({ exists: true, name: room.name, isPrivate: true, isOwner: true, hasAccess: true, members: [], inviteKey: room.inviteKey });
      setStatus(`Комната готова. Бесплатно: ${limits.minutes} минут, до ${limits.peers} человек`);
      return room;
    } catch {
      setStatus('Не удалось создать комнату');
      return null;
    }
  };

  const createPrivateRoom = async (opts = {}) => {
    // Без аккаунта маршрут другой: приватные комнаты заводит только аккаунт
    if (!authUser) return createGuestRoom();
    try {
      const token = localStorage.getItem('token');
      const resp = await apiFetch(`/rooms/create`, {
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
      const resp = await apiFetch(`/contacts`, { headers: { Authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = await resp.json();
        setContacts(data.contacts || []);
      }
    } catch {}
  }, []);

  useEffect(() => { if (authUser) fetchContacts(); }, [authUser, fetchContacts]);

  // Кнопки «Ответить» и «Отклонить» в системном уведомлении настольного
  // приложения. Нажатие приходит сюда, поэтому звонок можно принять, не
  // разворачивая окно: ровно так ведут себя обычные звонилки.
  useEffect(() => {
    const handle = (action) => {
      if (action === 'accept') acceptCallRef.current?.();
      else declineCallRef.current?.();
    };
    const offDesktop = window.comsDesktop?.onCallAction?.(handle);
    const plugin = callPlugin();
    const sub = plugin?.addListener?.('callAction', (e) => handle(e?.action));
    return () => {
      offDesktop?.();
      // подписка приходит обещанием, снимаем когда доедет
      Promise.resolve(sub).then(h => h?.remove?.()).catch(() => {});
    };
  }, []);

  // Медиадвижок тянем фоном сразу после первого экрана: к моменту входа в
  // звонок он обычно уже на месте, а первый экран его не ждёт.
  useEffect(() => { prefetchLiveKit(); }, []);

  // Сколько осталось бесплатной комнате. Считаем от срока, присланного
  // сервером, а не от своего таймера: вкладка могла спать, часы разойтись.
  const [guestLeftMs, setGuestLeftMs] = useState(null);
  const [guestEnded, setGuestEnded] = useState(false);
  useEffect(() => {
    if (!guestLimits?.expiresAt || !joined) { setGuestLeftMs(null); return; }
    const end = new Date(guestLimits.expiresAt).getTime();
    const tick = () => {
      const left = end - Date.now();
      setGuestLeftMs(left);
      if (left <= 0) {
        // Не выкидываем в пустоту: показываем понятный экран, откуда можно
        // начать заново одной кнопкой
        setGuestEnded(true);
        leaveCall();
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guestLimits, joined]);

  // Предупреждаем заранее, по разу на каждый рубеж
  const warnedRef = useRef({ five: false, one: false });
  useEffect(() => {
    if (guestLeftMs == null) { warnedRef.current = { five: false, one: false }; return; }
    const min = guestLeftMs / 60000;
    if (min <= 1 && !warnedRef.current.one) {
      warnedRef.current.one = true;
      setCallNotice('Бесплатное время заканчивается через минуту');
    } else if (min <= 5 && !warnedRef.current.five) {
      warnedRef.current.five = true;
      setCallNotice('Осталось 5 минут бесплатного времени');
    }
  }, [guestLeftMs]);

  // Глобальный поиск людей (с задержкой при вводе)
  useEffect(() => {
    const q = contactSearch.trim();
    if (q.length < 2) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const token = localStorage.getItem('token');
        const resp = await apiFetch(`/contacts/search?q=${encodeURIComponent(q)}`, {
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
      const resp = await apiFetch(`/contacts`, {
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
      await apiFetch(`/contacts/${encodeURIComponent(username)}`, {
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
      const resp = await apiFetch(`/rooms/call`, {
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
    // Отсчёт был чисто декоративным: если сервер перезапустился посреди
    // дозвона, его call-ended уже не придёт, и экран «Вызов... 0 с» висел
    // вечно. Через пять секунд после нуля закрываем сами.
    const stop = setTimeout(() => {
      setCall(null);
      setCallNotice('Не ответили');
    }, 50000);
    return () => { clearInterval(id); clearTimeout(stop); };
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

  const acceptCallRef = useRef(null);
  const declineCallRef = useRef(null);

  const acceptCall = async () => {
    const c = call;
    if (!c || c.role !== 'in') return;
    // В комнату входим не здесь, а по разрешению сервера (call-accept-ok).
    // Раньше клиент входил сразу, и при ответе с двух устройств оба
    // оказывались в комнате: отказ приходил уже после входа.
    socket.emit('call-accept', { callId: c.callId });
    clearIncomingNotice();
    // Обязательно выйти из текущего звонка: иначе микрофон остаётся в старой
    // комнате и прежние собеседники продолжают нас слышать.
    if (joined) await leaveCall();
    setCall({ ...c, phase: 'connecting' });
  };

  const declineCall = () => {
    if (call?.callId) socket.emit('call-decline', { callId: call.callId });
    setCall(null);
    clearIncomingNotice();
  };

  acceptCallRef.current = acceptCall;
  declineCallRef.current = declineCall;

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
        const resp = await apiFetch(`/rooms/info/${encodeURIComponent(slug)}`, {
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
      await apiFetch(`/rooms/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug: knockRequest.roomId, username: knockRequest.username }),
      });
      addAction(`✅ ${knockRequest.name || knockRequest.username} впущен в комнату`);
    } catch {}
    dropKnock();
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
      // Значок на кнопке чата показывал общее число сообщений и никогда не
      // гас: считаем именно непрочитанные, пока панель закрыта.
      if (!chatOpenRef.current) setChatUnread(n => n + 1);

      // Всплывающее сообщение внизу экрана. Показываем, только когда чат
      // закрыт: при открытом человек и так его видит, и всплытие дублировало
      // бы одно и то же. Свои сообщения не всплывают: их автор только что
      // отправил.
      if (!chatPopupsRef.current || chatOpenRef.current) return;
      if (message.userId && message.userId === myIdRef.current) return;
      // Показываем только последнее сообщение: стопка всплытий заслоняет
      // разговор, а прочесть успеваешь всё равно верхнее. Новое сообщение
      // заменяет предыдущее и заново запускает отсчёт.
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setChatToasts([{ ...message, id }]);
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setChatToasts([]), 7000);
    });

    socket.on('chat-edited', ({ id, text }) => {
      setMessages(prev => prev.map(m => (m.id === id ? { ...m, text, edited: true } : m)));
      // Всплытие тоже правим: иначе на экране висит старый текст
      setChatToasts(prev => prev.map(t => (t.id === id ? { ...t, text } : t)));
    });
    socket.on('chat-deleted', ({ id }) => {
      setMessages(prev => prev.filter(m => m.id !== id));
      setChatToasts(prev => prev.filter(t => t.id !== id));
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

    // Лимит был декоративным: одиннадцатый уже входил в звонок с камерой и
    // микрофоном, а надпись только меняла текст статуса. Теперь выводим.
    socket.on('room-full', () => {
      setCallNotice('В звонке уже 10 участников, больше комната не вмещает');
      leaveCallRef.current?.();
    });

    socket.on('call-incoming', (c) => {
      setCall({
        role: 'in', phase: 'ringing', callId: c.callId,
        peer: c.from, peerName: c.fromName || c.from,
        roomSlug: c.roomSlug, inviteKey: c.inviteKey,
      });
      // Звонок должен доходить, даже когда приложение свёрнуто. На Windows
      // окно поднимается поверх всех и мигает в панели задач, на Android
      // система показывает звонок поверх заблокированного экрана. В браузере
      // ни того, ни другого нет, там звонок виден только внутри вкладки.
      notifyIncoming(c.fromName || c.from);
    });
    socket.on('call-ringing', ({ callId }) => setCall(p => (p ? { ...p, callId } : p)));
    // Собеседник принял: входим в комнату. Проверка callRef обязательна —
    // человек мог нажать «Отменить» в ту же секунду, и без неё его затягивало
    // в разговор, от которого он только что отказался.
    socket.on('call-accepted', ({ callId, roomSlug, inviteKey }) => {
      const cur = callRef.current;
      if (!cur || cur.role !== 'out' || (cur.callId && callId && cur.callId !== callId)) return;
      setCall(p => (p ? { ...p, phase: 'connecting' } : p));
      inviteKeyRef.current = inviteKey;
      setRoomId(roomSlug);
      joinRoomWithRef.current?.(roomSlug, inviteKey, { direct: true });
    });
    // Сервер разрешил нам принять звонок — только теперь входим
    socket.on('call-accept-ok', ({ roomSlug, inviteKey }) => {
      inviteKeyRef.current = inviteKey;
      setRoomId(roomSlug);
      joinRoomWithRef.current?.(roomSlug, inviteKey, { direct: true });
    });
    socket.on('call-ended', ({ reason }) => {
      setCall(null);
      setCallNotice(CALL_END_TEXT[reason] || 'Звонок завершён');
      // Уведомление системы и мигание панели задач должны сняться, чем бы
      // звонок ни кончился: иначе окно остаётся липким поверх всех
      clearIncomingNotice();
    });
    socket.on('knock', (req) => setKnockQueue(prev =>
      prev.some(r => r.username === req.username && r.roomId === req.roomId) ? prev : [...prev, req]));

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
      clearTimeout(waitTimeoutRef.current);
      setWaitingForHost(false);
      // прямой вызов брал версию функции с первого рендера, без имени и токена
      if (r) { setStatus('Вас впустили — подключаемся…'); joinRoomWithRef.current?.(r.slug, r.key); }
    });
    socket.on('wait-denied', () => {
      clearTimeout(waitTimeoutRef.current);
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
      socket.off('call-accept-ok');
      socket.off('call-ended');
      socket.off('knock');
    };
  }, [addAction, showFloatingReaction]);

  // Сообщаем серверу, кто мы — для входящих звонков (и после переподключений)
  useEffect(() => {
    if (!authUser?.username) return;
    // Ник сервер достаёт из токена сам: назваться чужим именем нельзя
    const announce = () => socket.emit('presence', { token: localStorage.getItem('token') });
    announce();
    // Сервер не принял токен: сессия истекла, входящие звонки приходить
    // перестанут. Раньше это происходило беззвучно.
    const rejected = () => setCallNotice('Сессия истекла. Войдите в аккаунт заново, иначе звонки не будут доходить');
    socket.on('connect', announce);
    socket.on('presence-rejected', rejected);
    return () => { socket.off('connect', announce); socket.off('presence-rejected', rejected); };
  }, [authUser]);

  // Переподключение сокета — это новый сокет с пустым состоянием на сервере.
  // Раньше заново отправлялся только presence, а вход в комнату нет: у
  // человека после смены Wi-Fi на мобильный интернет молча отваливались чат
  // и реакции, а сервер переставал считать его занятым и пропускал к нему
  // новые звонки прямо посреди разговора.
  useEffect(() => {
    const rejoin = () => {
      const p = joinPayloadRef.current;
      if (p && joinedRef.current) socket.emit('join-room', p);
    };
    socket.on('connect', rejoin);
    return () => socket.off('connect', rejoin);
  }, []);

  // Сервер перестал пускать в комнату кого угодно по её названию. Отказ должен
  // быть виден словами, иначе чат и список участников просто молча не работают.
  useEffect(() => {
    const denied = () => setStatus('Нет доступа к этой комнате. Откройте звонок заново по ссылке');
    socket.on('room-denied', denied);
    return () => socket.off('room-denied', denied);
  }, []);

  // Persist and apply volumes
  useEffect(() => { localStorage.setItem('vol_master', masterVolume); }, [masterVolume]);
  useEffect(() => { localStorage.setItem('vol_applause', applauseVolume); }, [applauseVolume]);
  useEffect(() => { localStorage.setItem('vol_users', usersVolume); }, [usersVolume]);
  useEffect(() => { localStorage.setItem('autoCamera', autoEnableCamera); }, [autoEnableCamera]);
  useEffect(() => {
    localStorage.setItem('chatPopups', chatPopups);
    chatPopupsRef.current = chatPopups;
  }, [chatPopups]);
  useEffect(() => { myIdRef.current = authUser?.id || guestIdRef.current; }, [authUser]);

  // Apply applause/sound volumes
  useEffect(() => {
    const v = (applauseVolume / 100) * (masterVolume / 100);
    SOUNDS.forEach(s => {
      const a = soundRefs.current[s.id];
      if (a) a.volume = v;
    });
  }, [applauseVolume, masterVolume]);

  // Прокрутка чата вниз. Раньше зависела только от сообщений, поэтому панель,
  // открытая после прихода сообщений, показывала самые старые: её DOM
  // монтируется заново и приходит со scrollTop = 0.
  useEffect(() => {
    chatOpenRef.current = isChatOpen;
    if (!isChatOpen) return;
    setChatUnread(0);
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
    }
  }, [messages, isChatOpen]);

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
  // Пока связь восстанавливается, медиасервер временно очищает список
  // участников. Интерфейс честно показывал «вы один в комнате», хотя никто
  // никуда не ушёл: люди на важном звонке решали, что всех отключило.
  // Держим последний известный состав и показываем его, пока идёт
  // восстановление.
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  const lastRosterRef = useRef([]);

  const allParticipants = useMemo(() => {
    const room = livekitRoomRef.current;
    if (!room || !joined) return [];
    const live = [room.localParticipant, ...Array.from(room.remoteParticipants.values())];
    // Во время восстановления пустой список это не «все ушли», а «мы пока не
    // знаем». Показываем прежний состав: он почти наверняка вернётся целиком.
    if (reconnecting && live.length <= 1 && lastRosterRef.current.length > 1) {
      return lastRosterRef.current;
    }
    if (live.length > 1) lastRosterRef.current = live;
    return live;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, renderTick, reconnecting]);

  const joinRoom = () => joinRoomWith(roomId.trim(), inviteKeyRef.current);

  // Гость подтвердил имя — сразу заводим его в звонок, без промежуточного экрана.
  // userName к этому моменту уже проставлен (пустая строка = сервер даст «Гость N»).
  useEffect(() => {
    // Гостевой режим теперь бывает и без приглашения: человек просто открыл
    // приложение. Автовход выполняем только когда пришли по ссылке, иначе
    // дёргали бы вход в пустую комнату.
    if (!guestMode || !hasGuestInvite || joined || joiningRef.current) return;
    joinRoomWith(guestInvite.room, guestInvite.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guestMode]);

  // Обработчики сокета регистрируются один раз, поэтому свежую ссылку на
  // joinRoomWith держим в ref: иначе при ответе на звонок сработает версия
  // с первого рендера — с пустым именем и без авторизации.
  const joinRoomWithRef = useRef(null);
  const leaveCallRef = useRef(null);
  // Звонок контакту и комната по ссылке ведут себя по-разному, когда второй
  // участник уходит: из звонка выкидывает, в комнате остаёмся ждать людей.
  const directCallRef = useRef(false);

  const joinRoomWith = async (slug, key, opts = {}) => {
    // пустые поля — объясняем, а не молчим
    if (!slug) { setStatus('Впишите название комнаты'); return; }
    // гость мог нажать «Пропустить» — тогда имя присвоит сервер («Гость N»)
    if (!guestMode && !userName.trim()) { setStatus('Введите ваше имя'); return; }
    if (joined || joiningRef.current) return;
    // Только после проверок: событие call-accepted приходит на все вкладки
    // аккаунта, и вкладка, уже сидящая в обычной комнате, помечала себя как
    // звонок один на один. Её потом выкидывало при уходе любого участника.
    directCallRef.current = Boolean(opts.direct);
    if (slug !== roomId) setRoomId(slug);
    joiningRef.current = true;
    setStatus('Подключаемся к комнате…');

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
        // Маршрут выбирается по наличию аккаунта, а не по тому, пришёл ли
        // человек по ссылке. Раньше здесь стоял guestMode, который включался
        // только у пришедших по приглашению: тот, кто просто открыл приложение
        // и ввёл ID комнаты, уходил на маршрут для авторизованных с пустым
        // токеном и получал «недействительный токен».
        resp = !authUser
          ? await apiFetch(`/rooms/guest-token`, {
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
          : await apiFetch(`/rooms/token`, {
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
        // Ведущий может просто не открыть приложение. Раньше спиннер крутился
        // бесконечно, и человек не понимал, ждать ему или уходить.
        clearTimeout(waitTimeoutRef.current);
        waitTimeoutRef.current = setTimeout(() => {
          setWaitingForHost(false);
          waitingRetryRef.current = null;
          setStatus('Ведущий не ответил за две минуты. Попробуйте позже или свяжитесь с ним напрямую');
        }, 120000);
        socket.emit('wait-knock', {
          roomId: slug,
          name: userName.trim(),
          // у гостя нет аккаунта — представляемся временным id, его же проверит сервер
          userId: authUser?.id || guestIdRef.current,
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
        // Без аккаунта в чужую комнату пускает только полная ссылка. По одному
        // ID комнаты сервер откажет, и человеку надо объяснить, что просить у
        // того, кто его позвал, а не показывать служебный текст.
        if (resp.status === 403 && !authUser && !key) {
          setStatus('Для входа без аккаунта нужна полная ссылка-приглашение. Попросите прислать её целиком');
        } else if (resp.status === 410) {
          setStatus('Время бесплатной комнаты вышло. Попросите создать новую');
        } else if (resp.status === 409 && err.reason === 'full') {
          setStatus(err.message);
        } else {
          setStatus(`Ошибка: ${err.message}`);
        }
        return;
      }

      const { token: lkToken, wsUrl: wsFromServer, ice, guestId: issuedGuestId } = await resp.json();
      rememberGuestId(issuedGuestId);
      roomTokenRef.current = lkToken;

      // Сервер отдаёт адрес медиасервера жёстко прописанным, и это был третий
      // домен из трёх. Получалось, что запросы шли через рабочий вход, а сам
      // разговор всё равно уходил на адрес, который у оператора недоступен:
      // человек входил в приложение, но в звонок попасть не мог. Путь
      // /livekit есть на каждом входе, поэтому ведём разговор туда же, куда
      // ходит остальное.
      const wsUrl = (() => {
        try {
          const here = new URL(serverUrl());
          const given = new URL(wsFromServer);
          return `${here.protocol === 'https:' ? 'wss:' : 'ws:'}//${here.host}${given.pathname}`;
        } catch {
          return wsFromServer;   // адрес нестандартный — оставляем как прислали
        }
      })();

      // TURN-креды приходят вместе с токеном комнаты и живут несколько часов.
      // Постоянного пароля в бандле больше нет — иначе TURN мог использовать любой.
      const iceServers = Array.isArray(ice) && ice.length
        ? ice
        : [{ urls: 'stun:stun.l.google.com:19302' }];

      // Движок грузится отдельно от приложения, обычно он уже подтянут фоном.
      // Если сеть рвётся, ждём здесь: без него комнату не создать.
      try {
        await loadLiveKit();
      } catch {
        setStatus('Не удалось загрузить видеосвязь. Проверьте интернет и попробуйте снова');
        joiningRef.current = false;
        return;
      }

      const room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 640, height: 360, frameRate: 15 },
        },
        // Чистый звук: эхо, шумоподавление, ровная громкость.
        //
        // Собеседники жаловались, что слышат громкий стук по клавиатуре.
        // Причина в том, что обычное шумоподавление рассчитано на ровный фон
        // вроде кулера, а щелчок клавиши это короткий резкий звук, который оно
        // пропускает. Хуже того, авто-громкость в паузах между словами
        // поднимает усиление и делает этот стук ещё громче.
        //
        // voiceIsolation это отдельный режим: система оставляет голос и
        // убирает всё остальное, включая клавиатуру и посуду. Работает не
        // везде, поэтому это дополнение к обычному подавлению, а не замена.
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          voiceIsolation: true,
          channelCount: 1,
          sampleRate: 48000,
        },
        publishDefaults: {
          // Simulcast обязателен в групповых звонках. Без него мы публикуем
          // один слой 360p, и adaptiveStream не из чего выбирать: миниатюра
          // 74 пикселя в ленте получает ровно тот же поток, что и главное
          // видео на весь экран. На звонке вдесятером это девять полных
          // декодеров на телефоне и, как следствие, нагрев и разряд.
          simulcast: true,
          videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
          // Молчание не передаём вовсе: меньше трафика и, главное, в паузах
          // до собеседников не долетает фоновый шум комнаты
          dtx: true,
          // Защита от потерь пакетов: на неровной сети речь рассыпается
          // раньше картинки, и это раздражает сильнее подтормаживающего видео
          red: true,
          videoSimulcastLayers: [
            { width: 320, height: 180, encoding: { maxBitrate: 120_000, maxFramerate: 12 } },
          ],
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

      room.on(LK.RoomEvent.Connected, () => {
        joiningRef.current = false;
        setJoined(true);
        setCallStartedAt(Date.now());
        setStatus('Подключено');
        revealControls();
        // Разблокировать аудио (браузеры блокируют autoplay)
        room.startAudio().catch(() => {});
        forceUpdate();
      });

      room.on(LK.RoomEvent.Disconnected, () => {
        joiningRef.current = false;
        setJoined(false);
        setCallStartedAt(null);
        setCallSeconds(0);
        livekitRoomRef.current = null;
        // Обрыв медиа-соединения — тоже выход из комнаты. Без этого сокет
        // с сервером остаётся жив, сервер продолжает считать человека
        // занятым, и входящие звонки ему отбиваются как «занято».
        socket.emit('leave-room', roomIdRef.current);
        directCallRef.current = false;
        setMessages([]);
        setChatUnread(0);
        setWaitingList([]);
        setKnockQueue([]);
        setRecActive(false);
        setRecStartedBy(null);
        setIsSharingScreen(false);
        setIsScreenFullscreen(false);
        setSelfBig(false);
        setStatus('Связь прервана');
        forceUpdate();
      });
      // Пока LiveKit сам восстанавливает связь, картинка замирала молча
      room.on(LK.RoomEvent.Reconnecting, () => {
        reconnectingRef.current = true;
        setReconnecting(true);
        setStatus('Восстанавливаем связь…');
      });
      room.on(LK.RoomEvent.Reconnected, () => {
        reconnectingRef.current = false;
        setReconnecting(false);
        setStatus('Связь восстановлена');
        // После восстановления состав мог измениться по-настоящему:
        // перечитываем его заново, а не полагаемся на сохранённый
        forceUpdate();
      });

      room.on(LK.RoomEvent.ParticipantConnected, (p) => {
        setStatus(`${displayName(p)} подключился`);
        playChime(true);
        forceUpdate();
      });

      room.on(LK.RoomEvent.ParticipantDisconnected, (p) => {
        // Во время восстановления это не уход, а временная потеря списка:
        // сообщать и звенеть про каждого незачем
        if (!reconnectingRef.current) {
          setStatus(`${displayName(p)} отключился`);
          playChime(false);
        }
        forceUpdate();
        // Звонок один на один: собеседник ушёл — разговаривать больше не с кем,
        // держать человека в пустой комнате незачем. В комнате по ссылке
        // остаёмся: туда люди заходят и выходят по ходу встречи.
        // Во время восстановления связи медиасервер сообщает об отключении
        // всех участников, хотя никто не уходил. Раньше это завершало звонок
        // один на один: человек терял разговор из-за секундного провала сети.
        if (directCallRef.current && room.remoteParticipants.size === 0 && !reconnectingRef.current) {
          setCallNotice(`${displayName(p)} завершил звонок`);
          leaveCallRef.current?.();
        }
      });

      // подсветка говорящих + своё качество соединения
      room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
        // Запоминаем последнего говорившего не из числа своих: по нему режим
        // «главный + лента» выбирает, кого показать крупно.
        const s = (speakers || []).find(p => p !== room.localParticipant);
        if (s) setLastSpeakerId(s.identity);
        forceUpdate();
      });
      room.on(LK.RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant === room.localParticipant) {
          setConnQuality(
            quality === LK.ConnectionQuality.Excellent ? 'excellent'
            : quality === LK.ConnectionQuality.Good ? 'good' : 'poor');
        }
      });

      // Публикация и снятие публикации — то, по чему раскладка решает, есть
      // у человека камера или он уходит квадратиком вниз. Без этих двух
      // событий участник, включивший камеру позже всех, оставался внизу.
      room.on(LK.RoomEvent.TrackPublished, forceUpdate);
      room.on(LK.RoomEvent.TrackUnpublished, forceUpdate);
      room.on(LK.RoomEvent.TrackSubscribed, forceUpdate);
      room.on(LK.RoomEvent.TrackUnsubscribed, forceUpdate);
      room.on(LK.RoomEvent.LocalTrackPublished, forceUpdate);
      room.on(LK.RoomEvent.LocalTrackUnpublished, forceUpdate);
      room.on(LK.RoomEvent.TrackMuted, forceUpdate);
      room.on(LK.RoomEvent.TrackUnmuted, forceUpdate);

      // пока идёт запись — шлём серверу, кто говорит (для разметки транскрипта по никам)
      room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
        if (!recActiveRef.current) return;
        const s = speakers && speakers[0];
        if (s) socket.emit('rec-speaker', { roomId: roomIdRef.current, speaker: displayName(s) });
      });

      setStatus('Подключаемся...');
      // Повторяем не только на 503 (лимит узла LiveKit, ещё не истёкший
      // departure_timeout), но и на срыве самого соединения: на мобильном
      // интернете рукопожатие иногда не успевает, и раньше это была
      // окончательная ошибка с английским текстом вместо новой попытки.
      //
      // ⚠ Повтор обязан начинаться с полного разрыва. Раньше цикл просто звал
      // подключение заново тем же токеном, то есть с той же личностью. Если
      // попытка на самом деле дошла до сервера, а клиент не дождался ответа,
      // следующая выбивала предыдущую: медиасервер видел одну и ту же личность
      // дважды и рвал первую сессию. В логах это одиннадцать разрывов с
      // причиной «повторная личность», а на звонке выглядело так, что все
      // участники пропадали секунд на пятнадцать, потом ненадолго
      // возвращались, и так по кругу.
      //
      // Двух попыток достаточно: дальше в дело вступает собственное
      // восстановление медиасервера, и мешать ему своими подключениями значит
      // порождать те же дубли.
      let connectAttempts = 0;
      while (true) {
        try {
          await room.connect(wsUrl, lkToken, {
            websocketTimeout: 20000,
            peerConnectionTimeout: 20000,
          });
          break;
        } catch (connErr) {
          if (isRetriableConnect(connErr) && connectAttempts < 2) {
            connectAttempts++;
            setStatus('Соединение не установилось, пробуем снова…');
            // Сначала закрываем всё, что могло остаться от неудачной попытки,
            // и только потом пробуем заново
            try { await room.disconnect(true); } catch { /* нечего закрывать */ }
            await new Promise(r => setTimeout(r, 1500 * connectAttempts));
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

      const joinPayload = { roomId: slug, userName: userName.trim(), userId: authUser?.id, roomToken: lkToken };
      socket.emit('join-room', joinPayload);
      joinPayloadRef.current = joinPayload;
      checkRecordingStatus(slug);

    } catch (error) {
      console.error('joinRoom error:', error);
      // Без имени входа причину не сузить: одна и та же ошибка означает
      // разное в зависимости от того, через какой адрес шло соединение
      const host = (() => { try { return new URL(serverUrl()).hostname; } catch { return '?'; } })();
      setStatus(`Ошибка: ${humanConnectError(error)} · вход ${host}`);
      // комнату оставлять нельзя: следующая попытка входа наткнётся на
      // полуживой объект и оборвётся ещё на подключении
      const dead = livekitRoomRef.current;
      livekitRoomRef.current = null;
      if (dead) { try { dead.removeAllListeners(); await dead.disconnect(); } catch { /* уже мёртвая */ } }
      joiningRef.current = false;
      // Звонок принят, а войти не вышло. Сервер о звонке уже забыл и
      // call-ended не пришлёт, поэтому экран «Соединяем» висел бы вечно,
      // и следующий звонок молча блокировался проверкой на активный.
      setCall(null);
      setCallNotice('Не удалось войти в звонок. Попробуйте ещё раз');
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
    joinPayloadRef.current = null;
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
    directCallRef.current = false;
    // Всё, что относится к прошлой комнате, должно уйти вместе с ней:
    // иначе следующий вход начинался с чужими заглушёнными участниками,
    // открытым во весь экран показом и уже увеличенным своим окном.
    setMutedUsers(new Set());
    setChatUnread(0);
    setTileAspect({});
    setPinnedId(null);
    setSelfBig(false);
    setSelfPos(null);
    setIsScreenFullscreen(false);
    setWaitingList([]);
    // Заявки на вход привязаны к socketId и к конкретной комнате. Оставшись
    // от прошлой комнаты, они висели живыми кнопками: «Впустить» молча
    // ничего не делал, а стук из старой комнаты показывался поверх новой.
    setKnockQueue([]);
    forceUpdate();
  };
  // ссылка нужна обработчикам комнаты: они регистрируются раньше объявления
  leaveCallRef.current = leaveCall;

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
      const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
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
    const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
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

  // ── Вложения ──
  // Файл уходит на сервер до отправки сообщения: так человек видит, что он
  // дошёл, и может передумать. Пока идёт загрузка, вложение висит рядом с
  // полем ввода, а не улетает вместе с текстом вслепую.
  const [pending, setPending] = useState(null);   // { name, size, kind, url, progress }
  const fileInputRef = useRef(null);
  const MAX_UPLOAD = 15 * 1024 * 1024;

  const uploadFile = async (file) => {
    if (!file || !joined) return;
    if (file.size > MAX_UPLOAD) {
      setStatus('Файл больше 15 МБ');
      return;
    }
    // Показываем сразу, ещё до ответа сервера: иначе после выбора файла
    // несколько секунд ничего не происходит и кажется, что нажатие пропало
    setPending({ name: file.name, size: file.size, kind: file.type.startsWith('image/') ? 'image' : 'file', url: null, progress: 0 });
    try {
      const room = encodeURIComponent(roomIdRef.current || '');
      const name = encodeURIComponent(file.name || 'файл');
      const resp = await apiFetch(`/chat/upload?room=${room}&name=${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          // право положить файл именно в эту комнату
          'X-Room-Token': roomTokenRef.current || '',
        },
        body: file,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setStatus(data.message || 'Не удалось отправить файл');
        setPending(null);
        return;
      }
      setPending({ ...data, progress: 100 });
    } catch {
      setStatus('Не удалось отправить файл. Проверьте интернет');
      setPending(null);
    }
  };

  // Картинку можно просто вставить из буфера, как в переписке: искать файл на
  // диске ради снимка экрана неудобно
  const handlePaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    uploadFile(file);
  };

  const sendMessage = () => {
    const text = messageText.trim();
    // Отправить можно и один файл без подписи, и подпись без файла, но не
    // пустоту
    if ((!text && !pending?.url) || !joined) return;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const base = { roomId: roomIdRef.current, userName: userName.trim() || 'Участник', timestamp: stamp };

    // Вложение и текст уходят разными сообщениями. В одном пузыре они
    // верстались рядом, и подпись ломалась по букве: «при» на одной строке,
    // «вет» на другой. Отдельными сообщениями и выглядит понятнее, и удалить
    // можно по отдельности.
    if (pending?.url) {
      socket.emit('chat-message', {
        ...base,
        text: '',
        attachment: { url: pending.url, name: pending.name, size: pending.size, kind: pending.kind },
      });
    }
    if (text) socket.emit('chat-message', { ...base, text });
    setMessageText('');
    setPending(null);
  };

  // ── Правка и удаление своих сообщений ──
  // Право проверяет сервер: он помнит, кто что отправил. Здесь мы только
  // решаем, кому показать кнопки, и это решение ни на что не влияет с точки
  // зрения безопасности.
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  // ── Меню сообщения ──
  // Кнопки поверх пузыря наезжали на текст и мешали читать. Действия
  // спрятаны в меню: правой кнопкой на компьютере, долгим нажатием на
  // телефоне. Ровно так это работает в любой переписке, и объяснять не надо.
  const [msgMenu, setMsgMenu] = useState(null);   // { msg, x, y }
  const longPressRef = useRef(null);

  const openMsgMenu = (e, msg) => {
    e.preventDefault();
    e.stopPropagation();
    setMsgMenu({ msg, x: e.clientX, y: e.clientY });
  };
  const startLongPress = (e, msg) => {
    if (e.pointerType === 'mouse') return;   // мышь открывает правой кнопкой
    const { clientX: x, clientY: y } = e;
    longPressRef.current = setTimeout(() => {
      // Лёгкий отклик: на телефоне без него непонятно, что нажатие засчитано
      try { navigator.vibrate?.(12); } catch { /* не везде есть */ }
      setMsgMenu({ msg, x, y });
    }, 450);
  };
  const cancelLongPress = () => {
    clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };
  // Листание ленты не должно превращаться в долгое нажатие: палец лежит на
  // сообщении и во время прокрутки
  const maybeCancelOnMove = (e) => {
    if (!longPressRef.current) return;
    if (Math.abs(e.movementY) > 4 || Math.abs(e.movementX) > 4) cancelLongPress();
  };

  // Меню закрывается по любому действию снаружи и по прокрутке: висящее
  // меню поверх уехавшего сообщения выглядит поломкой
  useEffect(() => {
    if (!msgMenu) return;
    const close = () => setMsgMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [msgMenu]);

  const startEdit = (msg) => {
    setEditingId(msg.id);
    setEditText(msg.text || '');
  };
  const applyEdit = () => {
    const text = editText.trim();
    if (!text || !editingId) { setEditingId(null); return; }
    socket.emit('chat-edit', { roomId: roomIdRef.current, id: editingId, text });
    setEditingId(null);
    setEditText('');
  };
  const removeMessage = (msg) => {
    socket.emit('chat-delete', { roomId: roomIdRef.current, id: msg.id });
    // Ждём подтверждения сервера, а не убираем сразу: если право не подтвердят,
    // сообщение не должно исчезнуть только у автора и остаться у остальных
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

  // Размер окна зависит от пропорции камеры и меняется на лету, поэтому
  // перетаскивание берёт его из ref, а не из замыкания рендера.
  const selfSizeRef = useRef({ w: 88, h: SELF_LONG });
  const selfCorner = (r, size) => ({
    x: Math.max(PIP_MARGIN, r.width - size.w - PIP_MARGIN),
    y: Math.max(PIP_MARGIN, r.height - size.h - 150),
  });
  // Перетаскивание своего окна. Тап отличаем от перетаскивания по смещению:
  // сдвинули меньше пяти пикселей — считаем тапом и увеличиваем окно.
  const selfDragIdRef = useRef(null);
  const onSelfPointerDown = (e) => {
    if (selfBig) return;                       // увеличенное окно не таскаем
    // Второй палец на том же окне заводил вторую сессию перетаскивания:
    // обе писали в одну позицию из разных точек отсчёта, и окно дёргалось.
    if (selfDragIdRef.current !== null) return;
    e.stopPropagation();
    const el = stageRef.current;
    if (!el) return;
    selfDragIdRef.current = e.pointerId;
    const r = el.getBoundingClientRect();
    const size = selfSizeRef.current;
    const base = selfPos || selfCorner(r, size);
    const start = { x: e.clientX, y: e.clientY, ox: base.x, oy: base.y, moved: false };
    setSelfDragging(true);
    const clampX = v => Math.min(Math.max(PIP_MARGIN, v), Math.max(PIP_MARGIN, r.width - size.w - PIP_MARGIN));
    const clampY = v => Math.min(Math.max(PIP_MARGIN, v), Math.max(PIP_MARGIN, r.height - size.h - PIP_MARGIN));
    const move = (ev) => {
      if (ev.pointerId !== selfDragIdRef.current) return;
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) start.moved = true;
      setSelfPos({ x: clampX(start.ox + dx), y: clampY(start.oy + dy) });
    };
    // Системный жест (входящий звонок, свайп от края) шлёт pointercancel
    // вместо pointerup. Без него окно навсегда оставалось «в перетаскивании»,
    // без анимаций, а слушатели копились на window с каждым таким жестом.
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      selfDragIdRef.current = null;
      setSelfDragging(false);
    };
    const cancel = (ev) => { if (ev.pointerId === selfDragIdRef.current) finish(); };
    const up = (ev) => {
      if (ev.pointerId !== selfDragIdRef.current) return;
      finish();
      if (!start.moved) { setSelfBig(true); return; }
      // после отпускания прилипаем к ближайшему углу
      const lx = clampX(start.ox + (ev.clientX - start.x));
      const ly = clampY(start.oy + (ev.clientY - start.y));
      setSelfPos({
        x: lx < (r.width - size.w) / 2 ? PIP_MARGIN : Math.max(PIP_MARGIN, r.width - size.w - PIP_MARGIN),
        y: ly < (r.height - size.h) / 2 ? PIP_MARGIN : Math.max(PIP_MARGIN, r.height - size.h - PIP_MARGIN),
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
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

  // Лента камер при демонстрации прижата к низу, а панель кнопок висит
  // поверх неё: на телефоне лента уходила под кнопки и под полоску жестов.
  // Высота панели зависит от ориентации и от числа кнопок, поэтому меряем
  // её, а не подбираем число руками.
  const controlsRef = useRef(null);
  const [controlsH, setControlsH] = useState(0);
  useEffect(() => {
    const el = controlsRef.current;
    if (!el || !window.ResizeObserver) return;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      setControlsH(p => (p === h ? p : h));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('orientationchange', apply);
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', apply); };
  }, [joined]);

  const [pinnedId, setPinnedId] = useState(null);
  const [lastSpeakerId, setLastSpeakerId] = useState(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [selfBig, setSelfBig] = useState(false);   // своё видео увеличено втрое
  // Где живёт своя камера на телефоне: 'pip' — плавающее окно, 'grid' — сетка
  const [selfMode, setSelfMode] = useState(() => {
    try { return localStorage.getItem(SELF_MODE_KEY) === 'grid' ? 'grid' : 'pip'; } catch { return 'pip'; }
  });
  const switchSelfMode = (mode) => {
    setSelfMode(mode);
    setSelfBig(false);
    try { localStorage.setItem(SELF_MODE_KEY, mode); } catch { /* приватный режим */ }
  };
  // Закрепление снимаем и когда человек вышел, и когда он выключил камеру:
  // иначе главным молча становился кто-то другой, а плашка продолжала
  // показывать имя закреплённого.
  useEffect(() => {
    if (!pinnedId) return;
    const p = allParticipants.find(x => x.identity === pinnedId);
    const camOn = p && Boolean(p.getTrackPublication(LK.Track.Source.Camera)) && !p.getTrackPublication(LK.Track.Source.Camera).isMuted;
    if (!p || !camOn) setPinnedId(null);
  }, [allParticipants, pinnedId, renderTick]);

  // Пропорции потоков приходят от плиток: их можно узнать только измерив видео
  const [tileAspect, setTileAspect] = useState({});
  const onTileMeta = useCallback((id, aspect) => {
    if (!id || !aspect || !Number.isFinite(aspect)) return;
    setTileAspect(prev => {
      const old = prev[id];
      if (old === aspect) return prev;
      // adaptiveStream подбирает качество потока под размер плитки на экране,
      // и размеры видео от этого скачут. Реакция на каждую сотую замыкала
      // круг: пересчёт сетки → новый размер плитки → другой слой потока →
      // снова пересчёт. Со стороны это выглядело как рябь на всех камерах
      // сразу, стоило кому-то выключить свою. Поворот камеры меняет
      // пропорцию в разы, так что порог его не съест.
      if (old && Math.abs(old - aspect) / old < 0.08) return prev;
      return { ...prev, [id]: aspect };
    });
  }, []);

  const localP = livekitRoomRef.current?.localParticipant;
  const remotes = allParticipants.filter(p => p !== localP);
  // На компьютере своё видео всегда часть общей сетки: плавающего окна там
  // нет вовсе. На телефоне место своей камеры выбирает человек, и выбор
  // держится между звонками.
  const selfInGrid = !isTouchDevice || selfMode === 'grid';
  // Себя ставим в конец: когда своё видео уходит в плавающее окно и
  // возвращается, остальные не должны прыгать по сетке.
  const gridSource = selfInGrid && localP ? [...remotes, localP] : remotes;
  // Камера включена — это факт публикации у собеседника, и только он. Раньше
  // об этом сообщала сама плитка, и получался замкнутый круг: пока поток не
  // подписан, плитка говорила «камеры нет», её убирали из сетки, видеоэлемент
  // исчезал, adaptiveStream переставал подписывать поток — и человек навсегда
  // оставался квадратиком внизу, хотя камера у него работала.
  const hasCameraOn = (p) => {
    const pub = p.getTrackPublication(LK.Track.Source.Camera);
    return Boolean(pub) && !pub.isMuted;
  };
  // Выключенная камера уходит из сетки вниз маленьким квадратом: она не
  // должна отнимать место у тех, кого действительно видно
  const visible = gridSource.filter(hasCameraOn);
  const cameraOff = gridSource.filter(p => !hasCameraOn(p));

  // «Главный + лента» — только на телефоне и только когда людей много
  // Закрепление снимается эффектом, то есть уже после рендера. Если
  // закреплённый был единственным видимым и выключил камеру, в этом кадре
  // speakerMode ещё включён, а показывать некого: экран падал на undefined.
  const speakerMode = visible.length > 0
    && ((isTouchDevice && visible.length >= SPEAKER_FROM) || Boolean(pinnedId));
  // Крупно показываем закреплённого, иначе последнего говорившего. Раньше
  // тут был visible[0], то есть первый вошедший: он висел главным весь
  // звонок, даже если молчал, а говорящий сидел мелкой миниатюрой в ленте.
  const mainParticipant = speakerMode
    ? (visible.find(p => p.identity === pinnedId)
       || visible.find(p => p.identity === lastSpeakerId)
       || visible[0])
    : null;
  const stripParticipants = speakerMode ? visible.filter(p => p !== mainParticipant) : [];

  const offRowH = cameraOff.length ? 64 + TILE_GAP : 0;
  // Перебор раскладок стоит 2^(n-1) вариантов, а таймер звонка перерисовывает
  // весь экран раз в секунду. Без мемоизации при десяти участниках это 512
  // вариантов каждую секунду впустую: набор пропорций-то не менялся.
  const packKey = visible.map(p => (tileAspect[p.identity] || DEFAULT_ASPECT).toFixed(4)).join(',');
  const pack = useMemo(
    () => packRows(
      packKey ? packKey.split(',').map(Number) : [],
      stageSize.w,
      Math.max(stageSize.h - offRowH, 80),
    ),
    [packKey, stageSize.w, stageSize.h, offRowH],
  );

  // Find participant with active screen share
  // Все, кто прямо сейчас показывает экран. Их может быть больше одного:
  // раньше брался только первый, и второй показ было не посмотреть вовсе.
  const screenShares = useMemo(() => {
    return allParticipants.filter(p => {
      const pub = p.getTrackPublication(LK.Track.Source.ScreenShare);
      return pub?.track && (p === livekitRoomRef.current?.localParticipant || pub.isSubscribed) && !pub.isMuted;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParticipants, renderTick]);

  const screenSharePresenter = screenShares[0];

  // ── Что показывать крупно ──
  //
  // Правила, чтобы поведение было предсказуемым:
  //   1. Никто ничего не выбирал — крупно идёт показ экрана, если он есть.
  //      Начал показывать — у всех большим стал его экран, как и ожидается.
  //   2. Человек нажал на любую плитку — крупно становится она, и это
  //      перебивает правило 1: можно смотреть на лицо говорящего, пока рядом
  //      идёт показ.
  //   3. Нажатие на крупную плитку снимает выбор и возвращает к правилу 1.
  //   4. Выбранное пропало (человек вышел, показ выключили) — выбор
  //      сбрасывается, иначе экран остался бы пустым.
  //   5. Начался новый показ — выбор сбрасывается: новый показ важнее
  //      прежнего выбора, иначе человек не заметит, что ему что-то показывают.
  const [focus, setFocus] = useState(null);   // { identity, source } либо null

  // Правило 5: новый показ возвращает всех к нему
  const shareKey = screenShares.map(p => p.identity).join(',');
  const prevShareKey = useRef(shareKey);
  useEffect(() => {
    if (shareKey && shareKey !== prevShareKey.current) setFocus(null);
    prevShareKey.current = shareKey;
  }, [shareKey]);

  // Правило 4: выбранного больше нет
  useEffect(() => {
    if (!focus) return;
    const p = allParticipants.find(x => x.identity === focus.identity);
    const gone = !p || (focus.source === 'screen' && !screenShares.includes(p));
    if (gone) setFocus(null);
  }, [focus, allParticipants, screenShares]);

  // Крупная плитка и лента под ней
  const stage = useMemo(() => {
    if (!screenShares.length) return null;   // обычная сетка, не наш случай
    const byId = (id) => allParticipants.find(x => x.identity === id);
    const chosen = focus && byId(focus.identity)
      ? { participant: byId(focus.identity), source: focus.source }
      : { participant: screenShares[0], source: 'screen' };

    // В ленту идут все камеры плюс все показы экрана, кроме того, что наверху
    const strip = [];
    for (const p of screenShares) {
      if (!(chosen.source === 'screen' && p === chosen.participant)) {
        strip.push({ participant: p, source: 'screen' });
      }
    }
    for (const p of allParticipants) {
      if (chosen.source === 'camera' && p === chosen.participant) continue;
      // Своя камера уже висит плавающим окном поверх показа. В ленте она
      // давала второго себя на одном экране: человек видел себя дважды и не
      // понимал, который настоящий.
      if (!selfInGrid && p === localP) continue;
      strip.push({ participant: p, source: 'camera' });
    }
    return { big: chosen, strip };
  }, [screenShares, allParticipants, focus, selfInGrid, localP]);

  // ── Геометрия своего окна ──
  // Размер и положение считаются здесь, а не в CSS. Иначе свёрнутое окно
  // жило на right/bottom, увеличенное — на transform, и при закрытии оно
  // прыгало между системами координат: то самое дёрганье.
  const selfAspect = (localP && tileAspect[localP.identity]) || DEFAULT_ASPECT;
  const selfSize = selfAspect >= 1
    ? { w: SELF_LONG, h: Math.round(SELF_LONG / selfAspect) }
    : { w: Math.round(SELF_LONG * selfAspect), h: SELF_LONG };
  selfSizeRef.current = selfSize;

  // Увеличенное окно: втрое больше, но всегда с полями по краям и с местом
  // под панель кнопок снизу.
  const selfBigSize = (() => {
    const W = stageSize.w || 360, H = stageSize.h || 640;
    // Нижняя отсечка обязательна: во время поворота экрана ResizeObserver
    // успевает прислать почти нулевую ширину, и без неё размеры уходили в
    // минус, а окно схлопывалось в точку.
    let w = Math.max(80, Math.min(selfSize.w * SELF_ZOOM, W - 48));
    let h = w / selfAspect;
    const maxH = Math.max(120, H - 190);
    if (h > maxH) { h = maxH; w = h * selfAspect; }
    return { w: Math.round(w), h: Math.round(h) };
  })();

  const selfBox = selfBig
    ? {
        ...selfBigSize,
        x: Math.round(((stageSize.w || 360) - selfBigSize.w) / 2),
        y: Math.max(PIP_MARGIN, Math.round(((stageSize.h || 640) - selfBigSize.h) / 2 - 24)),
      }
    : {
        ...selfSize,
        ...(selfPos || selfCorner({ width: stageSize.w || 360, height: stageSize.h || 640 }, selfSize)),
      };

  // При повороте экрана сцена меняет размеры, и старые координаты уводили
  // окно за границу — оно просто пропадало из виду. Возвращаем его внутрь.
  useEffect(() => {
    if (!selfPos || !stageSize.w || !stageSize.h) return;
    const { w, h } = selfSizeRef.current;
    const x = Math.min(Math.max(PIP_MARGIN, selfPos.x), Math.max(PIP_MARGIN, stageSize.w - w - PIP_MARGIN));
    const y = Math.min(Math.max(PIP_MARGIN, selfPos.y), Math.max(PIP_MARGIN, stageSize.h - h - PIP_MARGIN));
    if (x !== selfPos.x || y !== selfPos.y) setSelfPos({ x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSize.w, stageSize.h, selfSize.w, selfSize.h]);

  // Экран был голым текстом без вёрстки: надпись прилипала к левому верхнему
  // углу и налезала на строку состояния телефона. Теперь та же заставка, что
  // и у загрузчика, чтобы переход между ними не был заметен.
  if (!authChecked) {
    return (
      <div className="boot-screen">
        <div className="boot-screen-mark">COMS</div>
        <div className="boot-screen-note">Проверяем вход…</div>
      </div>
    );
  }

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
        const r = await apiFetch(
          `/rooms/guest-info/${encodeURIComponent(guestInvite.room)}?key=${encodeURIComponent(guestInvite.key)}`,
        );
        const info = await r.json();
        // Комнаты может ещё не быть: она заведётся при входе первого человека.
        // Отказ только когда комната есть и она приватная.
        if (!info.guestAllowed) { setGuestError('Приватная комната: нужна полная ссылка. Попросите прислать её целиком'); return; }
        // Про лимит человек должен знать до входа, а не узнавать на сороковой
        // минуте: он не создавал никакой «бесплатной комнаты», он нажал ссылку
        if (info.isGuestRoom && info.expiresAt) {
          setGuestLimits({ minutes: 40, peers: info.maxPeers || 5, expiresAt: info.expiresAt });
        }
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
                Войти без имени
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

  // Стены логина больше нет. Приложение открыто всем: аккаунт добавляет
  // возможности, а не открывает дверь. Экран входа показывается только по
  // явному нажатию «Войти» и имеет кнопку возврата.
  if (!authUser && showAuth) {
    return (
      <AuthPage
        onLoginSuccess={(user) => {
          setAuthUser(user);
          setUserName(user.displayName || user.username || 'Иван');
          setRoomId(prev => prev || `${user.username}-${Math.floor(100 + Math.random() * 900)}`);
          setAuthError('');
          setShowAuth(false);
        }}
        onBack={() => setShowAuth(false)}
        authError={authError}
      />
    );
  }

  // Время бесплатной комнаты вышло. Человек мог просто нажать чужую ссылку и
  // никакой комнаты не создавать, поэтому объясняем, что произошло, и даём
  // продолжить одной кнопкой вместо того, чтобы молча выкинуть.
  if (guestEnded) {
    return (
      <div className="app-shell timeup-shell">
        <div className="timeup-card">
          <h1 className="timeup-title">Время вышло</h1>
          <p className="timeup-text">
            Бесплатная комната рассчитана на {guestLimits?.minutes || 40} минут.
            Можно продолжить разговор в новой комнате прямо сейчас.
          </p>
          <div className="timeup-actions">
            <button
              className="primary-btn"
              onClick={async () => {
                setGuestEnded(false);
                setGuestLimits(null);
                const room = await createGuestRoom();
                if (room) setStatus('Новая комната готова. Отправьте ссылку собеседникам');
              }}
            >
              Продолжить в новой комнате
            </button>
            <button className="ghost-btn" onClick={() => { setGuestEnded(false); setGuestLimits(null); }}>
              На главную
            </button>
          </div>
          {!authUser && (
            <p className="timeup-hint">
              В аккаунте комнаты без ограничения по времени, плюс контакты и запись разговоров.
              <button className="linklike" onClick={() => { setGuestEnded(false); setShowAuth(true); }}>Войти</button>
            </p>
          )}
        </div>
      </div>
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
            {/* Выход должен быть на любой фазе. Раньше в «Соединяем» кнопки не
                было вовсе, и человек оказывался заперт в карточке без выхода:
                оставалось только закрыть приложение. */}
            <button className="ctrl-round ctrl-round--danger dialing-cancel" onClick={cancelCall} aria-label="Отменить звонок">
              <Icon name="phoneOff" size={22} />
            </button>
          </div>
        </div>
      )}

      {/* Меню сообщения: правой кнопкой или долгим нажатием. Появляется у
          пальца, но не вылезает за край экрана. */}
      {msgMenu && createPortal((
        isTouchDevice ? (
          /* На телефоне указателя нет, и маленькое меню у пальца попадает под
             сам палец. Поэтому затемняем экран, поднимаем нажатое сообщение
             над затемнением и показываем крупные кнопки снизу. */
          <div className="msg-sheet-backdrop" onClick={() => setMsgMenu(null)}>
            <div className="msg-sheet-preview" onClick={e => e.stopPropagation()}>
              {msgMenu.msg.attachment?.kind === 'image' && (
                <img src={mediaUrl(msgMenu.msg.attachment.url)} alt="" />
              )}
              {msgMenu.msg.text && <span>{msgMenu.msg.text}</span>}
            </div>
            <div className="msg-sheet" onClick={e => e.stopPropagation()}>
              {msgMenu.msg.text && (
                <button onClick={() => { startEdit(msgMenu.msg); setMsgMenu(null); }}>Изменить</button>
              )}
              <button className="msg-menu-danger" onClick={() => { removeMessage(msgMenu.msg); setMsgMenu(null); }}>
                Удалить
              </button>
            </div>
            <button className="msg-sheet-cancel" onClick={() => setMsgMenu(null)}>Отмена</button>
          </div>
        ) : (
          <div
            className="msg-menu"
            style={{
              left: Math.min(msgMenu.x, window.innerWidth - 190),
              top: Math.min(msgMenu.y, window.innerHeight - 130),
            }}
            onPointerDown={e => e.stopPropagation()}
          >
            {msgMenu.msg.text && (
              <button onClick={() => { startEdit(msgMenu.msg); setMsgMenu(null); }}>Изменить</button>
            )}
            <button className="msg-menu-danger" onClick={() => { removeMessage(msgMenu.msg); setMsgMenu(null); }}>
              Удалить
            </button>
          </div>
        )
      ), document.body)}

      {/* Всплывающие сообщения чата: три секунды поверх всего, потом гаснут.
          Стоят над панелью кнопок, чтобы не перекрывать микрофон и сброс. */}
      {joined && chatToasts.length > 0 && (
        <div className="chat-toasts" style={{ bottom: (controlsVisible ? controlsH + 30 : 16) }}>
          {chatToasts.map(t => (
            <div className="chat-toast" key={t.id}>
              <span className="chat-toast-who">{t.userName}</span>
              <span className="chat-toast-text">{t.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Почему звонок не состоялся — иначе человек не понимает, что произошло */}
      {/* Плашку показываем только в звонке. На главном экране то же самое
          уже написано в строке состояния, и человек видел одну ошибку
          дважды на одном экране. */}
      {callNotice && joined && <div className="call-notice">{callNotice}</div>}

      {/* ── Кто-то стучится в приватную комнату (видит владелец в звонке) ── */}
      {knockRequest && roomInfo?.isOwner && (
        <div className="call-popup">
          <div className="call-popup-title">🚪 Запрос на вход</div>
          <div className="call-popup-from">{knockRequest.name || knockRequest.username} просится в комнату</div>
          <div className="call-popup-actions">
            <button className="primary-btn" onClick={approveKnock}>Впустить</button>
            <button className="ghost-btn" onClick={dropKnock}>Игнорировать</button>
          </div>
        </div>
      )}

      {/* Комната ожидания — экран гостя */}
      {waitingForHost && (
        <div className="modal-backdrop">
          <div className="waiting-card">
            <div className="waiting-spinner"><span className="spinner" /></div>
            <div className="waiting-title">Вы в комнате ожидания</div>
            {/* Про двухминутный предел человек узнавал только когда его
                выбрасывало. Предупреждаем заранее: ожидание с известным
                концом переносится совсем иначе, чем бесконечное. */}
            <div className="waiting-text">
              Ведущий скоро впустит вас в звонок.
              <br />
              Если он не ответит за две минуты, вернём вас на главный экран.
            </div>
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
                  ? <EmptyState title="Переговорок нет" text="Постоянная комната это ссылка, которая не меняется: её удобно закрепить в календаре." />
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
                    ? <EmptyState title="Отделов пока нет" text="Создайте структуру компании, потом назначайте в неё сотрудников." actionLabel="Создать первый отдел" onAction={() => setNewDepName(v => v || "Продажи")} />
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
                    {/* Прочерк означает «неизвестно», ноль означает «ничего не было». Пока
                        данные не пришли — прочерк, после загрузки — настоящий ноль:
                        раньше пустая компания выглядела как сломанная. */}
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics ? (adminAnalytics.summary?.employees ?? 0) : '—'}</div><div className="admin-stat-label">Сотрудников</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics ? (adminAnalytics.summary?.activeThisWeek ?? 0) : '—'}</div><div className="admin-stat-label">Активны за неделю</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics ? (adminAnalytics.summary?.totalMinutes ?? 0) : '—'}</div><div className="admin-stat-label">Минут суммарно</div></div>
                    <div className="admin-stat"><div className="admin-stat-num">{adminAnalytics ? (adminAnalytics.summary?.avgMinutes ?? 0) : '—'}</div><div className="admin-stat-label">Минут в среднем</div></div>
                  </div>
                  {(!adminAnalytics || adminAnalytics.rows.length === 0)
                    ? <EmptyState title="Пока нечего показывать" text="Статистика появится после первых звонков в комнатах компании." />
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
                  ? <EmptyState title="Записей нет" text="Запись включается кнопкой во время звонка и доступна, когда все участники вошли в свои аккаунты." />
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
                  ? <EmptyState title="Журнал пуст" text="Здесь появятся действия сотрудников: кто кого добавил, кто менял комнаты и роли." />
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
                {/* Переключатель режима лежал внутри «Бизнеса» и «Сотрудника»:
                    чтобы сменить режим, надо было сначала попасть в раздел,
                    который этим режимом и открывается. Здесь он доступен всегда. */}
                <div className="mode-pick">
                  <div className="mode-pick-title">Режим работы</div>
                  <div className="mode-pick-sub">Обычный: личные звонки. Бизнес: управление компанией. Сотрудник: рабочий кабинет.</div>
                  {modeSelector}
                </div>

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
                  ? <div className="skeleton-list" aria-label="Загружаем"><span /><span /><span /></div>
                  : myRecordings.length === 0
                    ? <EmptyState title="Записей нет" text="Нажмите «Запись» во время звонка. После него здесь появятся расшифровка и краткое содержание." />
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
                                      {/* Открыть прямо здесь, а не скачивать: ради этого
                                          продукт и выбирают, и это должно быть первым
                                          действием, а не спрятанным в файле */}
                                      <button
                                        className="primary-btn room-card-btn"
                                        onClick={() => {
                                          setOpenRec(openRec === rec.id ? null : rec.id);
                                          setRecView(rec.summary ? 'summary' : 'text');
                                          setRecSearch('');
                                        }}
                                      >
                                        <Icon name="notes" size={14} /> {openRec === rec.id ? 'Свернуть' : 'Читать'}
                                      </button>
                                      <button className="ghost-btn room-card-btn" onClick={() => downloadTranscript(rec, false)}>
                                        <Icon name="download" size={14} /> Текст
                                      </button>
                                      {rec.aiStatus === 'done' && Array.isArray(rec.transcriptAi) ? (
                                        <button className="ghost-btn room-card-btn" onClick={() => downloadTranscript(rec, true)}>
                                          <Icon name="download" size={14} /> Причёсанный текст
                                        </button>
                                      ) : rec.aiStatus !== 'processing' && (
                                        <button className="ghost-btn room-card-btn" onClick={() => enhanceTranscript(rec.id)}>
                                          <Icon name="sparkles" size={14} /> {rec.aiStatus === 'failed' ? 'Причесать заново' : 'Причесать текст'}
                                        </button>
                                      )}
                                      {rec.summaryStatus === 'done' && rec.summary ? (
                                        <button className="ghost-btn room-card-btn" onClick={() => downloadSummary(rec)}>
                                          <Icon name="download" size={14} /> Итоги
                                        </button>
                                      ) : rec.summaryStatus !== 'processing' && (
                                        <button className="ghost-btn room-card-btn" onClick={() => requestSummary(rec.id)}>
                                          <Icon name="notes" size={14} /> {rec.summaryStatus === 'failed' ? 'Собрать итоги заново' : 'Краткие итоги'}
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                              {/* Чтение прямо в приложении: итоги встречи и полная
                                  расшифровка с поиском по сказанному. Раньше это
                                  существовало только в скачанном файле. */}
                              {openRec === rec.id && (
                                <div className="rec-reader">
                                  <div className="rec-reader-tabs">
                                    <button
                                      className={`rec-reader-tab${recView === 'summary' ? ' rec-reader-tab--active' : ''}`}
                                      onClick={() => setRecView('summary')}
                                      disabled={!rec.summary}
                                      title={rec.summary ? undefined : 'Итоги ещё не собраны'}
                                    >Итоги</button>
                                    <button
                                      className={`rec-reader-tab${recView === 'text' ? ' rec-reader-tab--active' : ''}`}
                                      onClick={() => setRecView('text')}
                                    >Расшифровка</button>
                                  </div>

                                  {recView === 'summary' && (
                                    rec.summary
                                      ? <div className="rec-summary">{rec.summary}</div>
                                      : <EmptyState
                                          title="Итоги ещё не собраны"
                                          text="Нажмите «Краткие итоги» выше: ИИ прочитает расшифровку и выделит главное."
                                        />
                                  )}

                                  {recView === 'text' && (() => {
                                    const segs = (rec.aiStatus === 'done' && Array.isArray(rec.transcriptAi) && rec.transcriptAi.length)
                                      ? rec.transcriptAi
                                      : rec.transcript;
                                    const q = recSearch.trim().toLowerCase();
                                    const shown = q ? segs.filter(x => String(x.text || '').toLowerCase().includes(q)) : segs;
                                    return (
                                      <>
                                        <input
                                          className="rec-search"
                                          value={recSearch}
                                          onChange={e => setRecSearch(e.target.value)}
                                          placeholder="Найти по сказанному"
                                        />
                                        {q && (
                                          <div className="rec-found">
                                            {shown.length === 0
                                              ? 'Ничего не нашлось'
                                              : `Нашлось: ${shown.length} из ${segs.length}`}
                                          </div>
                                        )}
                                        <div className="rec-lines">
                                          {shown.map((seg, i) => (
                                            <div className="rec-line" key={i}>
                                              <span className="rec-line-time">{fmtTime(seg.start)}</span>
                                              <span className="rec-line-who">{seg.speaker || 'Говорящий'}</span>
                                              <span className="rec-line-text">{seg.text}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </>
                                    );
                                  })()}
                                </div>
                              )}

                              {rec.transcriptStatus === 'processing' && (
                                <div className="transcript-status">
                                  <span className="spinner" /> Расшифровка речи… обычно 1–2 минуты на минуту записи
                                </div>
                              )}
                              {rec.aiStatus === 'processing' && (
                                <div className="transcript-status">
                                  <span className="spinner" /> Приводим текст в порядок: убираем ошибки распознавания…
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
                                    : rec.aiStatus === 'failed' ? 'ИИ-обработка не удалась' : 'Итоги не удалось'}
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
                  ? <div className="skeleton-list" aria-label="Загружаем"><span /><span /><span /></div>
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
                  ? <div className="skeleton-list" aria-label="Загружаем"><span /><span /><span /></div>
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
                    onContextMenu={isOwn && msg.id ? (e) => openMsgMenu(e, msg) : undefined}
                    onPointerDown={isOwn && msg.id ? (e) => startLongPress(e, msg) : undefined}
                    onPointerUp={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onPointerMove={maybeCancelOnMove}
                  >
                    {startsGroup && !isOwn && <div className="msg-author">{msg.userName}</div>}
                    <div className="msg-bubble">
                      {/* Картинка идёт над текстом и служит ему заголовком:
                          подпись читается после того, что подписывают.
                          Прочие файлы показываем строкой со ссылкой. */}
                      {msg.attachment?.kind === 'image' && (
                        <a className="msg-image" href={mediaUrl(msg.attachment.url)} target="_blank" rel="noopener">
                          <img src={mediaUrl(msg.attachment.url)} alt={msg.attachment.name || ''} loading="lazy" />
                        </a>
                      )}
                      {msg.attachment && msg.attachment.kind !== 'image' && (
                        <a className="msg-file" href={mediaUrl(msg.attachment.url)} target="_blank" rel="noopener" download={msg.attachment.name}>
                          <Icon name="link" size={15} />
                          <span className="msg-file-name">{msg.attachment.name}</span>
                          <span className="msg-file-size">{((msg.attachment.size || 0) / 1024 / 1024).toFixed(1)} МБ</span>
                        </a>
                      )}
                      {editingId === msg.id ? (
                        <div className="msg-edit">
                          <input
                            className="msg-edit-input"
                            value={editText}
                            autoFocus
                            onChange={e => setEditText(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); applyEdit(); }
                              if (e.key === 'Escape') { setEditingId(null); }
                            }}
                          />
                          <div className="msg-edit-hint">Enter сохранит, Esc отменит</div>
                        </div>
                      ) : (
                        msg.text && <span className="msg-text">{renderMessageText(msg.text)}</span>
                      )}
                      <span className="msg-time">
                        {msg.edited && <span className="msg-edited">изменено</span>}
                        {msg.timestamp}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
          {/* Выбранное вложение висит над полем ввода до отправки: человек
              видит, что файл дошёл, и может передумать */}
          {pending && (
            <div className="chat-pending">
              {pending.kind === 'image' && pending.url
                ? <img className="chat-pending-thumb" src={mediaUrl(pending.url)} alt="" />
                : <span className="chat-pending-icon"><Icon name="link" size={16} /></span>}
              <div className="chat-pending-info">
                <div className="chat-pending-name">{pending.name}</div>
                <div className="chat-pending-meta">
                  {pending.url
                    ? `${(pending.size / 1024 / 1024).toFixed(1)} МБ`
                    : 'Загружаем…'}
                </div>
              </div>
              {!pending.url && <span className="chat-pending-spinner" aria-hidden="true" />}
              <button className="chat-pending-x" onClick={() => setPending(null)} aria-label="Убрать вложение">
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          <div className="chat-input-row">
            <input
              ref={fileInputRef}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rtf,.md"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; uploadFile(f); }}
            />
            <button
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!joined || Boolean(pending)}
              aria-label="Прикрепить файл"
              title="Прикрепить файл, до 15 МБ"
            >
              <Icon name="link" size={20} />
            </button>
            <input
              className="chat-input"
              value={messageText}
              onChange={e => setMessageText(e.target.value)}
              onKeyDown={handleMessageKeyDown}
              onPaste={handlePaste}
              placeholder="Сообщение"
              disabled={!joined}
            />
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={!joined || (!messageText.trim() && !pending?.url)}
              aria-label="Отправить"
            >
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
                <Switch checked={chatPopups} onChange={setChatPopups} label="Показывать сообщения чата поверх звонка" />
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
              <div className={`status-badge status-badge--${statusKind(status)}`}>{status}</div>
              <button className="ghost-btn theme-toggle-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} aria-label="Сменить тему">{theme === 'dark' ? '☀' : '☾'}</button>
              {/* у гостя нет аккаунта — показываем только выход из звонка */}
              {guestMode ? (
                <button className="ghost-btn logout-btn" onClick={() => { if (joined) leaveCall(); window.location.href = BASE; }}>
                  Выйти
                </button>
              ) : authUser ? (
                <>
                  <button className="ghost-btn account-toggle-btn" onClick={() => setIsAccountPanelOpen(p => !p)}><Icon name="menu" size={16} /> Аккаунт</button>
                  <button className="ghost-btn logout-btn" onClick={() => {
                    localStorage.removeItem('token');
                    setAuthUser(null);
                    if (joined) leaveCall();
                  }}>Выйти</button>
                </>
              ) : (
                // Без аккаунта выходить неоткуда: вместо «Выйти» зовём внутрь,
                // и это единственное место, откуда открывается экран входа
                <button className="primary-btn header-login-btn" onClick={() => setShowAuth(true)}>
                  Войти
                </button>
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
              <label>Название комнаты</label>
              <input value={roomId} onChange={e => setRoomId(e.target.value)} placeholder="например, planerka" />
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
                  <button className="ghost-btn" onClick={createPrivateRoom}>
                    <Icon name="lock" size={16} /> {authUser ? 'Создать приватную комнату' : 'Создать комнату'}
                  </button>
                  <button className="ghost-btn" onClick={copyRoomLink}>{copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</button>
                  {/* Кнопки, которые без аккаунта всё равно откажут, не
                      показываем: человек решит, что сломалось, и будет жать
                      снова. Вместо них честное приглашение войти. */}
                  {authUser ? (
                    <button className={`ghost-btn${isContactsOpen ? ' active' : ''}`} onClick={() => setIsContactsOpen(p => !p)}>
                      <Icon name="users" size={16} /> Контакты{contacts.length > 0 ? ` (${contacts.length})` : ''}
                    </button>
                  ) : (
                    <button className="ghost-btn" onClick={() => setShowAuth(true)}>
                      <Icon name="users" size={16} /> Войти, чтобы открыть контакты
                    </button>
                  )}
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
          className={`call-fullscreen${controlsVisible ? '' : ' controls-hidden'}${reconnecting ? ' call-fullscreen--reconnecting' : ''}`}
          onMouseMove={isTouchDevice ? undefined : onDesktopMouseMove}
        >
          {/* Top bar (overlay, авто-скрытие) */}
          <div className="call-topbar" onClick={e => e.stopPropagation()}>
            <div className="call-topbar-left">
              <div className="brand" style={{ fontSize: 18 }}>COMS</div>
              <div className="call-room-badge">{roomId}</div>
              {/* Пока связь восстанавливается, человек должен видеть, что дело
                  в сети, а не в том, что все ушли. Без этого он гадает,
                  продолжать говорить или перезванивать. */}
              {reconnecting && (
                <div className="reconnect-chip">Связь пропала, восстанавливаем…</div>
              )}
              {/* Оставшееся время видно всегда: обрыв на сороковой минуте без
                  предупреждения человек воспринимает как поломку */}
              {guestLeftMs != null && guestLeftMs > 0 && (
                <div className={`guest-left${guestLeftMs <= 5 * 60000 ? ' guest-left--soon' : ''}`}>
                  осталось {Math.floor(guestLeftMs / 60000)}:{String(Math.floor((guestLeftMs % 60000) / 1000)).padStart(2, '0')}
                </div>
              )}
              <button className="call-link-btn" title="Скопировать ссылку на звонок" onClick={() => { copyRoomLink(); setStatus('Ссылка скопирована'); }}>
                <Icon name="link" size={14} />
              </button>
              <div className="call-timer">{formattedCallTime}</div>
              {connQuality !== 'excellent' && (
                <div className={`conn-badge conn-badge--${connQuality}`} title="Качество вашего соединения">
                  {connQuality === 'good' ? 'сеть: хорошо' : 'сеть: слабо'}
                </div>
              )}
              {recActive && (
                <div className="rec-indicator" title={`Запись включил ${recStartedBy}`}>
                  <span className="rec-dot" /> REC
                </div>
              )}
            </div>
            <div className="call-topbar-right">
              {status !== 'Подключено' && <div className={`status-badge status-badge--${statusKind(status)}`}>{status}</div>}
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
          <div ref={stageRef} className={`video-stage${isScreenFullscreen ? ' video-stage--fs' : ''}${selfBig ? ' video-stage--selfbig' : ''}`} onClick={isTouchDevice ? onStageTap : undefined}>
            {stage ? (
              <div className="presenter-layout">
                {/* Крупно идёт либо показ экрана, либо то, что человек выбрал
                    сам. Нажатие по крупному снимает выбор и возвращает к
                    показу: так из любого состояния есть путь назад. */}
                <button
                  className="stage-big"
                  onClick={(e) => { e.stopPropagation(); setFocus(null); }}
                  aria-label={focus ? 'Вернуться к показу экрана' : 'Показ экрана'}
                  disabled={!focus}
                >
                  {stage.big.source === 'screen' ? (
                    <ScreenShareTile
                      participant={stage.big.participant}
                      isLocal={stage.big.participant === livekitRoomRef.current?.localParticipant}
                    />
                  ) : (
                    <ParticipantTile
                      participant={stage.big.participant}
                      isLocal={stage.big.participant === localP}
                      isFrontCamera={isFrontCamera}
                      onMeta={onTileMeta}
                    />
                  )}
                  {focus && (
                    <span className="stage-back-chip">
                      <Icon name="close" size={13} /> Вернуться к показу
                    </span>
                  )}
                </button>
                <button
                  className="screen-fullscreen-btn"
                  title={isScreenFullscreen ? 'Свернуть' : 'На весь экран'}
                  onClick={() => setIsScreenFullscreen(v => !v)}
                >
                  <Icon name={isScreenFullscreen ? 'collapse' : 'expand'} size={18} />
                </button>

                {/* Те же круглые кнопки, что и в обычной панели звонка.
                    Раньше здесь был отдельный набор со своими формами,
                    подписями и цветами: он выглядел из другого приложения,
                    а иконки вообще рисовались системным синим, потому что
                    кнопка не задавала цвет текста. */}
                {isScreenFullscreen && (
                  <div className="fs-controls">
                    <button className={`ctrl-round ${isMuted ? 'ctrl-round--off' : ''}`} onClick={toggleMute} title={isMuted ? 'Включить микрофон' : 'Выключить микрофон'} aria-label={isMuted ? 'Включить микрофон' : 'Выключить микрофон'}>
                      <Icon name={isMuted ? 'micOff' : 'mic'} size={22} />
                    </button>
                    <button className={`ctrl-round ${isCameraOff ? 'ctrl-round--off' : ''}`} onClick={toggleCamera} title={isCameraOff ? 'Включить камеру' : 'Выключить камеру'} aria-label={isCameraOff ? 'Включить камеру' : 'Выключить камеру'}>
                      <Icon name={isCameraOff ? 'cameraOff' : 'camera'} size={22} />
                    </button>
                    <button className="ctrl-round" onClick={() => setIsSoundsPanelOpen(p => !p)} title="Звуки" aria-label="Звуки">
                      <Icon name="music" size={22} />
                    </button>
                    <button className={`ctrl-round ${isChatOpen ? 'ctrl-round--active' : ''}`} onClick={() => setIsChatOpen(p => !p)} title="Чат" aria-label="Чат">
                      <Icon name="chat" size={22} />
                    </button>
                    <button className="ctrl-round ctrl-round--danger" onClick={() => { setIsScreenFullscreen(false); leaveCall(); }} title="Завершить звонок" aria-label="Завершить звонок">
                      <Icon name="phoneOff" size={22} />
                    </button>
                  </div>
                )}
                {!isScreenFullscreen && (
                  <div
                    className="camera-strip"
                    /* отступ считаем в стилях элемента: панель кнопок бывает
                       и в один ряд, и в два, её высота известна только после
                       замера */
                    style={{ marginBottom: controlsVisible ? controlsH + 30 : 12 }}
                  >
                    {/* Нажатие по любой плитке в ленте поднимает её наверх:
                        и камеру, и чужой показ экрана. */}
                    {stage.strip.map(item => (
                      <button
                        key={`${item.source}:${item.participant.identity}`}
                        className="strip-pick"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocus({ identity: item.participant.identity, source: item.source });
                        }}
                        aria-label={`Показать крупно: ${displayName(item.participant)}${item.source === 'screen' ? ', экран' : ''}`}
                      >
                        {item.source === 'screen' ? (
                          <ScreenShareTile
                            participant={item.participant}
                            isLocal={item.participant === livekitRoomRef.current?.localParticipant}
                          />
                        ) : (
                          <ParticipantTile
                            participant={item.participant}
                            isLocal={item.participant === livekitRoomRef.current?.localParticipant}
                            isFrontCamera={isFrontCamera}
                            small
                          />
                        )}
                        {item.source === 'screen' && <span className="strip-badge">экран</span>}
                      </button>
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
                    isLocal={mainParticipant === localP}
                    isFrontCamera={isFrontCamera}
                    localMuted={mainParticipant !== localP && mutedUsers.has(mainParticipant.identity)}
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
                  {stripParticipants.map(p => {
                    // По своей миниатюре тап увеличивает окно, а не закрепляет:
                    // закреплять самого себя главным незачем
                    const isSelf = p === localP;
                    return (
                      <button
                        key={p.identity}
                        className="speaker-thumb"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isSelf) setSelfBig(true); else setPinnedId(p.identity);
                        }}
                        aria-label={isSelf ? 'Увеличить своё видео' : `Показать крупно: ${displayName(p)}`}
                      >
                        <ParticipantTile participant={p} isLocal={isSelf} isFrontCamera={isFrontCamera} onMeta={onTileMeta} />
                      </button>
                    );
                  })}
                  {/* Выключенные камеры не должны пропадать и здесь: раньше
                      в этом режиме человек исчезал с экрана целиком */}
                  {cameraOff.map(p => (
                    <div className="off-chip off-chip--strip" key={p.identity} title={displayName(p)}>
                      <span className="off-chip-letter">{(displayName(p) || '?')[0].toUpperCase()}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* Рядная раскладка без обрезки: плитка принимает пропорцию
                 потока, ряд заполняет ширину, неполный ряд центрируется. */
              <div className="tile-rows">
                {/* Один в звонке. Раньше это был просто чёрный экран, и
                    человек не понимал, ждать ему или всё сломалось. */}
                {visible.length === 0 && (
                  <div className="stage-empty">
                    {cameraOff.length === 0 ? (
                      <>
                        <div className="stage-empty-title">Пока вы здесь один</div>
                        <div className="stage-empty-text">Отправьте ссылку тем, кого ждёте. Звонок уже идёт, входить заново не нужно.</div>
                        <button
                          className="stage-empty-btn"
                          onClick={(e) => { e.stopPropagation(); copyRoomLink(); setStatus('Ссылка скопирована'); }}
                        >
                          <Icon name="link" size={16} /> Скопировать ссылку
                        </button>
                      </>
                    ) : (
                      /* Люди есть, но камер не видно. Раньше тут была чёрная
                         пустота, и звонок выглядел зависшим. */
                      <>
                        <div className="stage-empty-title">Камеры выключены</div>
                        <div className="stage-empty-text">
                          {/* себя считаем отдельно: на компьютере своё видео
                              тоже часть сетки и попадает в cameraOff */}
                          {remotes.length === 0
                            ? 'Ваша камера выключена. Включите её кнопкой снизу'
                            : remotes.length === 1
                              ? 'Собеседник вас слышит'
                              : `В звонке ${remotes.length + 1}, все с выключенными камерами`}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {pack && pack.rows.map((row, ri) => (
                  <div className="tile-row" key={ri} style={{ height: Math.floor(pack.heights[ri]) }}>
                    {row.map(idx => {
                      const p = visible[idx];
                      const h = pack.heights[ri];
                      const a = tileAspect[p.identity] || DEFAULT_ASPECT;
                      const isSelf = p === localP;
                      return (
                        <ParticipantTile
                          key={p.identity}
                          participant={p}
                          isLocal={isSelf}
                          isFrontCamera={isFrontCamera}
                          localMuted={!isSelf && mutedUsers.has(p.identity)}
                          onToggleMute={() => toggleUserMute(p.identity)}
                          onMeta={onTileMeta}
                          // Тап по своей плитке увеличивает её: там же лежит
                          // кнопка возврата в плавающее окно
                          onClick={isSelf && isTouchDevice
                            ? (e) => { e.stopPropagation(); setSelfBig(true); }
                            : undefined}
                          gridSpan={{ width: Math.floor(a * h), height: Math.floor(h), flex: '0 0 auto' }}
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

            {/* Своё видео. На телефоне по умолчанию плавающее окно, на компе
                оно всегда в общей сетке. Размер и положение задаются числами,
                поэтому открытие и закрытие идут одной и той же анимацией. */}
            {localP && (!selfInGrid || selfBig) && (
              <>
                {selfBig && <div className="self-scrim" onClick={(e) => { e.stopPropagation(); setSelfBig(false); }} />}
                <div
                  className={`self-pip${selfBig ? ' self-pip--big' : ''}${selfDragging ? ' self-pip--drag' : ''}${selfInGrid ? ' self-pip--enter' : ''}`}
                  style={{ left: selfBox.x, top: selfBox.y, width: selfBox.w, height: selfBox.h }}
                  onPointerDown={selfInGrid ? undefined : onSelfPointerDown}
                  onClick={(e) => { e.stopPropagation(); if (selfBig) setSelfBig(false); }}
                >
                  <ParticipantTile participant={localP} isLocal isFrontCamera={isFrontCamera} onMeta={onTileMeta} />
                  {/* Переключение места своей камеры — только на телефоне: на
                      компьютере плавающего окна нет как такового. Кнопка
                      живёт внутри окна: снаружи она уезжала под панель
                      кнопок, а на низких экранах и вовсе за край. */}
                  {selfBig && isTouchDevice && (
                    <button
                      className="self-mode-btn"
                      onClick={(e) => { e.stopPropagation(); switchSelfMode(selfInGrid ? 'pip' : 'grid'); }}
                    >
                      <Icon name={selfInGrid ? 'collapse' : 'users'} size={16} />
                      {selfInGrid ? 'Плавающее окно' : 'Добавить в сетку'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Controls bar — иконки, overlay, авто-скрытие */}
          <div ref={controlsRef} className="controls-bar" onClick={e => { e.stopPropagation(); revealControls(); }}>
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
              {chatUnread > 0 && <span className="ctrl-badge">{chatUnread}</span>}
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
