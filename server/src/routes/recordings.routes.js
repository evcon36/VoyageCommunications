const express = require('express');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { EgressClient, EncodedFileType, RoomServiceClient } = require('livekit-server-sdk');
const authMiddleware = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');
const recTimeline = require('../lib/recTimeline');

const router = express.Router();

const egress = new EgressClient(
  'http://127.0.0.1:7880',
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

// нужен, чтобы перед стартом записи узнать состав комнаты
const roomSvc = new RoomServiceClient(
  'http://127.0.0.1:7880',
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

const RECORDINGS_DIR = '/var/www/voyage/recordings';
const TRANSCRIBE_PY = '/opt/transcribe.py';
const WHISPER_PY = '/opt/whisper-venv/bin/python';

// только одна транскрибация одновременно (слабый сервер)
let transcribeBusy = false;

// LiveKit забыл egress: после перезапуска он не помнит даже завершённые.
const isEgressGone = (e) => /does not exist|not found/i.test(String(e?.message || e));

// Egress больше нет, а запись у нас всё ещё «идёт». Раньше её опрашивали
// вечно: сотни строк «egress does not exist» в журнале, и, хуже того, в этой
// комнате нельзя было начать новую запись — /start отвечал «Запись уже идёт».
// Сам egress о судьбе файла уже не расскажет, поэтому смотрим на файл: целый
// mp4 (ffprobe читает длительность) — запись состоялась, просто мы не застали
// её конец; битый или пустой — не состоялась. Помечать «неудачной» вслепую
// нельзя: так пропала бы настоящая запись, конец которой мы проспали.
function probeDuration(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 20000 }, (err, out) => {
        const d = parseFloat(String(out || '').trim());
        resolve(!err && Number.isFinite(d) && d > 0 ? d : 0);
      });
  });
}
async function settleLostRecording(rec) {
  const file = rec.fileName ? `${RECORDINGS_DIR}/${rec.fileName}` : null;
  let ok = false, endedAt = new Date();
  if (file && fs.existsSync(file)) {
    ok = (await probeDuration(file)) > 0;
    try { endedAt = fs.statSync(file).mtime; } catch {}
  }
  const speakerLog = recTimeline.endRec(rec.id);
  await prisma.recording.update({
    where: { id: rec.id },
    data: { status: ok ? 'done' : 'failed', endedAt, ...(speakerLog ? { speakerLog } : {}) },
  });
  console.log(`REC SYNC: egress ${rec.egressId} пропал, запись ${rec.id} → ${ok ? 'done' : 'failed'}`);
  if (ok) pumpTranscribeQueue();
}

// Сверить «активные» записи с реальным egress; на завершении сохранить таймлайн
async function syncActiveRecordings() {
  const active = await prisma.recording.findMany({ where: { status: 'active' } });
  if (!active.length) return;
  for (const rec of active) {
    // Свежую запись не трогаем: egress мог ещё не появиться в списке
    const young = Date.now() - new Date(rec.startedAt).getTime() < 60000;
    try {
      const infos = await egress.listEgress({ egressId: rec.egressId });
      const info = infos && infos[0];
      if (!info) { if (!young) await settleLostRecording(rec); continue; }
      const s = Number(info.status); // 3=COMPLETE 4=FAILED 5=ABORTED
      if (s >= 3) {
        const speakerLog = recTimeline.endRec(rec.id);
        await prisma.recording.update({
          where: { id: rec.id },
          data: { status: s === 3 ? 'done' : 'failed', endedAt: new Date(), speakerLog },
        });
        pumpTranscribeQueue();
      }
    } catch (e) {
      if (isEgressGone(e) && !young) {
        await settleLostRecording(rec).catch(err => console.error('REC SYNC SETTLE:', err.message));
      } else {
        console.error('REC SYNC:', e.message);
      }
    }
  }
}

// ── Очередь расшифровки ──
// Сервер — два ядра. Запись звонка (egress, программное кодирование 720p)
// держит 55–65% всё время звонка, а whisper брал оба ядра почти целиком.
// Расшифровку, запущенную во время записываемого звонка, egress не
// переживал: «REC START ERROR: no response from servers», рывки в записи.
// Поэтому:
//   1) пока идёт хоть одна запись, расшифровка не начинается, а ждёт в
//      очереди (transcriptStatus = 'queued') и стартует сама после звонка;
//   2) whisper идёт с низшим приоритетом (nice 19, ionice idle) и в один
//      поток — если запись начнётся посреди расшифровки, уступит он.
async function recordingInProgress() {
  try {
    const list = await egress.listEgress({ active: true });
    return (list || []).length > 0;
  } catch (e) {
    // LiveKit недоступен — значит, и записывать сейчас нечего
    console.error('TRANSCRIBE EGRESS CHECK:', e.message);
    return false;
  }
}

let pumping = false;
async function pumpTranscribeQueue() {
  if (pumping || transcribeBusy) return;
  pumping = true;
  try {
    const next = await prisma.recording.findFirst({
      where: { transcriptStatus: 'queued' },
      orderBy: { startedAt: 'asc' },
    });
    if (!next) return;
    if (await recordingInProgress()) return;   // подождём следующего круга
    await runTranscribe(next);
  } catch (e) {
    console.error('TRANSCRIBE QUEUE:', e.message);
  } finally {
    pumping = false;
  }
}

// Ждём только смены статуса; сам whisper работает в фоне
async function runTranscribe(rec) {
  transcribeBusy = true;
  const filePath = `${RECORDINGS_DIR}/${rec.fileName}`;
  await prisma.recording.update({ where: { id: rec.id }, data: { transcriptStatus: 'processing' } }).catch(() => {});
  const child = spawn('nice', ['-n', '19', 'ionice', '-c3', WHISPER_PY, TRANSCRIBE_PY, filePath], {
    env: { ...process.env, WHISPER_MODEL: 'small', WHISPER_THREADS: '1' },
  });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('error', async (e) => {
    transcribeBusy = false;
    console.error('TRANSCRIBE SPAWN:', e.message);
    await prisma.recording.update({ where: { id: rec.id }, data: { transcriptStatus: 'failed' } }).catch(() => {});
    pumpTranscribeQueue();
  });
  child.on('close', async (code) => {
    transcribeBusy = false;
    try {
      if (code !== 0) {
        console.error('TRANSCRIBE FAIL:', err.slice(-500));
        await prisma.recording.update({ where: { id: rec.id }, data: { transcriptStatus: 'failed' } });
        return;
      }
      const parsed = JSON.parse(out);
      const recStartMs = new Date(rec.startedAt).getTime();
      const withSpeakers = assignSpeakers(parsed.segments || [], rec.speakerLog, recStartMs);
      await prisma.recording.update({
        where: { id: rec.id },
        data: { transcript: withSpeakers, transcriptStatus: 'done' },
      });
    } catch (e) {
      console.error('TRANSCRIBE PARSE ERROR:', e.message);
      await prisma.recording.update({ where: { id: rec.id }, data: { transcriptStatus: 'failed' } }).catch(() => {});
    } finally {
      pumpTranscribeQueue();
    }
  });
}

// Перезапуск сервера убивает whisper на полдороге, и запись навсегда
// оставалась «в обработке» без кнопки повтора. Возвращаем такие в очередь.
setTimeout(async () => {
  try {
    const n = await prisma.recording.updateMany({
      where: { transcriptStatus: 'processing' },
      data: { transcriptStatus: 'queued' },
    });
    if (n.count) console.log(`TRANSCRIBE: ${n.count} прерванных расшифровок вернули в очередь`);
  } catch (e) { console.error('TRANSCRIBE RESUME:', e.message); }
  pumpTranscribeQueue();
}, 5000);
// Очередь ждёт конца записи. Конец ловим и сами (остановка, опустевшая
// комната, сверка), но страхуемся кругом раз в полминуты.
setInterval(() => { syncActiveRecordings().catch(() => {}).finally(pumpTranscribeQueue); }, 30000).unref?.();

// ── Начать запись ──
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.body || {};
    if (!roomId) return res.status(400).json({ message: 'roomId обязателен' });

    const existing = await prisma.recording.findFirst({ where: { roomId, status: 'active' } });
    if (existing) return res.status(409).json({ message: 'Запись уже идёт' });

    // политика записи компании: owner | admin | anyone
    const room = await prisma.room.findUnique({ where: { slug: roomId } });
    if (room?.companyId) {
      const company = await prisma.company.findUnique({ where: { id: room.companyId } });
      if (company && company.recordPolicy !== 'anyone') {
        const member = await prisma.companyMember.findUnique({
          where: { companyId_username: { companyId: company.id, username: req.user.username } },
        });
        const role = member?.role;
        const allowed = company.recordPolicy === 'owner' ? role === 'owner' : (role === 'owner' || role === 'admin');
        if (!allowed) return res.status(403).json({ message: 'Запись разрешена только ' + (company.recordPolicy === 'owner' ? 'владельцу компании' : 'админам') });
      }
    }

    // Раньше запись блокировалась, если в комнате был хоть один человек без
    // аккаунта. На важном разговоре это стоило владельцу всей записи: он
    // позвал людей по ссылке, а записать уже не смог.
    //
    // Теперь записывает любой участник с аккаунтом. Взамен всем участникам
    // уходит явное предупреждение с именем того, кто включил запись, и до
    // остановки висит несмахиваемая метка: договорённость строится на том,
    // что человек знает и может выйти, а не на том, что мы ему запретили.
    let guestsPresent = [];
    try {
      const parts = await roomSvc.listParticipants(roomId);
      guestsPresent = (parts || [])
        .filter(p => String(p.identity || '').startsWith('guest#'))
        .map(p => p.name || 'Гость');
    } catch (e) {
      // Состав комнаты неизвестен: раньше это было поводом отказать целиком.
      // Запись важнее точного списка, поэтому просто пишем в журнал.
      console.error('REC GUEST CHECK:', e.message);
    }

    const fileName = `rec-${roomId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp4`;
    const info = await egress.startRoomCompositeEgress(roomId, {
      file: { fileType: EncodedFileType.MP4, filepath: `/out/${fileName}` },
    }, {
      layout: 'grid',
      encodingOptions: { width: 1280, height: 720, framerate: 24, videoBitrate: 2500, audioBitrate: 128, audioFrequency: 48000 },
    });

    const rec = await prisma.recording.create({
      data: { egressId: info.egressId, roomId, startedBy: req.user.username, fileName },
    });
    recTimeline.startRec(roomId, rec.id);

    // Явное предупреждение всем в комнате: кто включил и есть ли среди
    // участников люди без аккаунта. Гость ничего не подписывал, поэтому он
    // как минимум должен знать и успеть выйти.
    try {
      global.io?.to(roomId).emit('recording-warning', {
        by: req.user.username,
        guests: guestsPresent,
      });
    } catch (e) { console.error('REC WARN:', e.message); }

    // Отвечаем сразу. Раньше здесь ждали пять секунд, чтобы убедиться, что
    // запись пошла, и держали ответ всё это время. Клиент успевал сдаться по
    // таймауту и повторить запрос на другом входе, а запись к тому моменту
    // уже работала: вторая запускалась поверх первой, и человек видел ошибку
    // при работающей записи.
    //
    // Проверка осталась, но идёт в стороне: если запись не поднялась, комната
    // узнает об этом отдельным сообщением.
    setTimeout(async () => {
      try {
        const infos = await egress.listEgress({ egressId: info.egressId });
        const st = Number(infos?.[0]?.status ?? 0);
        if (st < 4) return;   // FAILED и ABORTED начинаются с четырёх
        recTimeline.endRec(rec.id);
        await prisma.recording.update({
          where: { id: rec.id },
          data: { status: 'failed', endedAt: new Date() },
        });
        global.io?.to(roomId).emit('recording-state', { active: false, by: req.user.username });
        global.io?.to(roomId).emit('recording-failed', { message: 'Запись не запустилась' });
      } catch (e) { console.error('REC VERIFY:', e.message); }
    }, 5000);

    // Метку записи ставим сразу всем в комнате: раньше это делал клиент,
    // который её включил, и при обрыве его сообщения остальные не знали,
    // что идёт запись
    global.io?.to(roomId).emit('recording-state', { active: true, by: req.user.username });

    return res.status(201).json({ recording: rec });
  } catch (e) {
    console.error('REC START ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось начать запись' });
  }
});

// Остановка записи как отдельное действие: её зовёт не только кнопка, но и
// сервер, когда комната опустела. Без этого запись, которую забыли выключить
// перед тем как сбросить звонок, продолжалась ещё и в пустой комнате — до
// empty_timeout, то есть пять минут тишины в файле.
async function stopActiveRecording(roomId) {
  const rec = await prisma.recording.findFirst({ where: { roomId, status: 'active' } });
  if (!rec) return null;
  try {
    await egress.stopEgress(rec.egressId);
  } catch (e) {
    // egress уже нет — останавливать нечего, решаем судьбу записи по файлу
    if (!isEgressGone(e)) throw e;
    await settleLostRecording(rec);
    return prisma.recording.findUnique({ where: { id: rec.id } });
  }
  const speakerLog = recTimeline.endRec(rec.id);
  const done = await prisma.recording.update({
    where: { id: rec.id },
    data: { status: 'done', endedAt: new Date(), speakerLog },
  });
  // файл дописывается ещё несколько секунд после остановки
  setTimeout(pumpTranscribeQueue, 15000);
  return done;
}

// Комната опустела — снимаем запись, если её забыли выключить. Ошибку сюда
// не пробрасываем: это уборка за ушедшими, падать из-за неё некому.
async function stopRecordingOnEmptyRoom(roomId) {
  try {
    const stopped = await stopActiveRecording(roomId);
    if (!stopped) return;
    console.log(`REC AUTO-STOP: комната ${roomId} опустела, запись остановлена`);
    global.io?.to(roomId).emit('recording-state', { active: false, by: null });
  } catch (e) {
    console.error('REC AUTO-STOP ERROR:', e.message);
  }
}

// ── Остановить запись ──
router.post('/stop', authMiddleware, async (req, res) => {
  const { roomId } = req.body || {};
  const rec = await prisma.recording.findFirst({ where: { roomId, status: 'active' } });
  if (!rec) return res.status(404).json({ message: 'Активной записи нет' });

  try {
    const updated = await stopActiveRecording(roomId);
    return res.json({ recording: updated });
  } catch (e) {
    console.error('REC STOP ERROR:', e.message);
    // egress уже завершился сам (упал или комната опустела) — фиксируем реальный статус
    try {
      const infos = await egress.listEgress({ egressId: rec.egressId });
      const st = Number(infos?.[0]?.status ?? 0);
      if (st >= 3) {
        const speakerLog = recTimeline.endRec(rec.id);
        const updated = await prisma.recording.update({
          where: { id: rec.id },
          data: { status: st === 3 ? 'done' : 'failed', endedAt: new Date(), speakerLog },
        });
        return res.json({
          recording: updated,
          message: st === 3 ? undefined : 'Запись прервалась ранее из-за ошибки — файл не сохранён',
        });
      }
    } catch (e2) { console.error('REC STOP SYNC:', e2.message); }
    return res.status(500).json({ message: 'Не удалось остановить запись' });
  }
});

// ── Статус записи в комнате ──
router.get('/status/:roomId', authMiddleware, async (req, res) => {
  await syncActiveRecordings();
  const rec = await prisma.recording.findFirst({
    where: { roomId: req.params.roomId, status: 'active' },
  });
  return res.json({ active: Boolean(rec), startedBy: rec?.startedBy || null });
});

// ── Мои записи ──
router.get('/my', authMiddleware, async (req, res) => {
  try {
    await syncActiveRecordings();
    const recs = await prisma.recording.findMany({
      where: { startedBy: req.user.username },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    // служебные поля наружу не отдаём
    return res.json({ recordings: recs.map(({ speakerLog, ...r }) => r) });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// Разметка сегментов транскрипта по говорящим через таймлайн active-speaker.
// segment.start/end — секунды от начала аудио (≈ начала записи).
function assignSpeakers(segments, speakerLog, recStartMs) {
  if (!Array.isArray(speakerLog) || !speakerLog.length) return segments;
  // строим интервалы: speaker[i] активен от t[i] до t[i+1]
  const intervals = speakerLog.map((e, i) => ({
    from: e.t - recStartMs,
    to: (speakerLog[i + 1]?.t ?? Infinity) - recStartMs,
    speaker: e.speaker,
  }));
  return segments.map(seg => {
    const segFrom = seg.start * 1000, segTo = seg.end * 1000;
    // какой говорящий покрывает больше всего времени сегмента
    const overlap = {};
    for (const iv of intervals) {
      const o = Math.max(0, Math.min(segTo, iv.to) - Math.max(segFrom, iv.from));
      if (o > 0) overlap[iv.speaker] = (overlap[iv.speaker] || 0) + o;
    }
    let best = null, bestVal = 0;
    for (const [sp, v] of Object.entries(overlap)) if (v > bestVal) { best = sp; bestVal = v; }
    return { ...seg, speaker: best || seg.speaker || null };
  });
}

// ── Подписанная ссылка на файл записи ──
// nginx больше не отдаёт /recfiles/ всем подряд: там стоит secure_link.
// Ссылку с коротким сроком жизни выдаём только тем, у кого есть доступ,
// поэтому утёкший URL перестаёт работать через несколько минут.
const REC_LINK_SECRET = process.env.REC_LINK_SECRET || '';
const REC_LINK_TTL = 300;

function signRecordingUrl(fileName, ttl = REC_LINK_TTL) {
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const uri = `/recfiles/${fileName}`;
  // строка должна совпадать с secure_link_md5 в конфиге nginx
  const md5 = crypto.createHash('md5')
    .update(`${expires}${uri} ${REC_LINK_SECRET}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { url: `${uri}?md5=${md5}&e=${expires}`, expires };
}

// доступ: автор записи либо владелец/админ компании, которой принадлежит комната
async function canAccessRecording(rec, username) {
  if (rec.startedBy === username) return true;
  const room = await prisma.room.findUnique({ where: { slug: rec.roomId } });
  if (!room?.companyId) return false;
  const member = await prisma.companyMember.findUnique({
    where: { companyId_username: { companyId: room.companyId, username } },
  });
  return member?.role === 'owner' || member?.role === 'admin';
}

router.get('/:id/link', authMiddleware, async (req, res) => {
  try {
    if (!REC_LINK_SECRET) return res.status(500).json({ message: 'REC_LINK_SECRET не настроен' });
    const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
    if (!rec || !rec.fileName) return res.status(404).json({ message: 'Запись не найдена' });
    if (!(await canAccessRecording(rec, req.user.username))) return res.status(403).json({ message: 'Нет доступа' });
    return res.json(signRecordingUrl(rec.fileName));
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Запустить транскрибацию (вручную) ──
router.post('/:id/transcribe', authMiddleware, async (req, res) => {
  try {
    const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
    if (!rec) return res.status(404).json({ message: 'Запись не найдена' });
    if (rec.startedBy !== req.user.username) return res.status(403).json({ message: 'Нет доступа' });
    if (rec.status !== 'done' || !rec.fileName) return res.status(400).json({ message: 'Запись ещё не готова' });
    if (rec.transcriptStatus === 'processing' || rec.transcriptStatus === 'queued') {
      return res.status(409).json({ message: 'Уже обрабатывается' });
    }

    // Всё уходит через очередь: она сама ждёт конца идущих записей и
    // свободного whisper. Отвечаем, началась ли расшифровка сразу или ждёт.
    await prisma.recording.update({ where: { id: rec.id }, data: { transcriptStatus: 'queued' } });
    const waitsForCall = await recordingInProgress();
    const waitsForOther = transcribeBusy;
    await pumpTranscribeQueue();
    const fresh = await prisma.recording.findUnique({ where: { id: rec.id }, select: { transcriptStatus: true } });
    const status = fresh?.transcriptStatus === 'processing' ? 'processing' : 'queued';
    return res.status(202).json({
      status,
      message: status === 'processing' ? 'Транскрибация запущена'
        : waitsForCall ? 'Идёт запись звонка, расшифровка начнётся после неё'
        : waitsForOther ? 'Сначала закончится другая расшифровка'
        : 'Расшифровка в очереди',
    });
  } catch (e) {
    console.error('TRANSCRIBE ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка транскрибации' });
  }
});

// ── Получить транскрипт ──
router.get('/:id/transcript', authMiddleware, async (req, res) => {
  const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
  if (!rec) return res.status(404).json({ message: 'Не найдено' });
  if (rec.startedBy !== req.user.username) return res.status(403).json({ message: 'Нет доступа' });
  return res.json({ status: rec.transcriptStatus, aiStatus: rec.aiStatus, transcript: rec.transcript || null, transcriptAi: rec.transcriptAi || null, summary: rec.summary || null, summaryStatus: rec.summaryStatus });
});

// ── ИИ-улучшение транскрипта (DeepSeek): чинит ошибки распознавания по контексту ──
router.post('/:id/enhance', authMiddleware, async (req, res) => {
  try {
    const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
    if (!rec) return res.status(404).json({ message: 'Не найдено' });
    if (rec.startedBy !== req.user.username) return res.status(403).json({ message: 'Нет доступа' });
    if (rec.transcriptStatus !== 'done' || !Array.isArray(rec.transcript) || !rec.transcript.length)
      return res.status(400).json({ message: 'Сначала сделайте расшифровку' });
    if (rec.aiStatus === 'processing') return res.status(409).json({ message: 'ИИ уже обрабатывает' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ message: 'ИИ не настроен' });

    await prisma.recording.update({ where: { id: rec.id }, data: { aiStatus: 'processing' } });
    res.status(202).json({ message: 'ИИ-обработка запущена' });

    // фон: отправляем сегменты в DeepSeek, мерджим исправления
    (async () => {
      try {
        const segs = rec.transcript.map((s, i) => ({ i, speaker: s.speaker, text: s.text }));
        const resp = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            temperature: 1.0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'Ты корректор автоматических транскриптов русских разговоров (Whisper). ' +
                  'Исправь ошибки распознавания: бессмысленные слова и галлюцинации замени на наиболее вероятные реально сказанные, опираясь на контекст всего разговора. ' +
                  'Сохраняй разговорный стиль, НЕ добавляй новых фраз, НЕ меняй смысл, НЕ объединяй и НЕ удаляй сегменты. ' +
                  'Верни строго JSON: {"segments":[{"i":<номер>,"text":"<исправленный текст>"}]} — только для сегментов, которые ты изменил.',
              },
              { role: 'user', content: JSON.stringify({ segments: segs }) },
            ],
          }),
        });
        if (!resp.ok) throw new Error('DeepSeek HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
        const data = await resp.json();
        const fixed = JSON.parse(data.choices[0].message.content);
        const fixMap = new Map((fixed.segments || []).map(f => [f.i, f.text]));
        const enhanced = rec.transcript.map((s, i) => fixMap.has(i) ? { ...s, text: fixMap.get(i) } : s);
        // оригинал (transcript) не трогаем — ИИ-версия в отдельном поле
        await prisma.recording.update({
          where: { id: rec.id },
          data: { transcriptAi: enhanced, aiStatus: 'done' },
        });
      } catch (e) {
        console.error('AI ENHANCE ERROR:', e.message);
        await prisma.recording.update({ where: { id: rec.id }, data: { aiStatus: 'failed' } }).catch(() => {});
      }
    })();
  } catch (e) {
    console.error('ENHANCE ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка ИИ-обработки' });
  }
});

// ── ИИ-саммари звонка (DeepSeek): краткое резюме, решения, задачи ──
router.post('/:id/summary', authMiddleware, async (req, res) => {
  try {
    const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
    if (!rec) return res.status(404).json({ message: 'Не найдено' });
    if (rec.startedBy !== req.user.username) return res.status(403).json({ message: 'Нет доступа' });
    if (rec.transcriptStatus !== 'done' || !Array.isArray(rec.transcript) || !rec.transcript.length)
      return res.status(400).json({ message: 'Сначала сделайте расшифровку' });
    if (rec.summaryStatus === 'processing') return res.status(409).json({ message: 'Саммари уже готовится' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ message: 'ИИ не настроен' });

    await prisma.recording.update({ where: { id: rec.id }, data: { summaryStatus: 'processing' } });
    res.status(202).json({ message: 'Саммари готовится' });

    (async () => {
      try {
        // берём улучшенную версию, если есть
        const src = Array.isArray(rec.transcriptAi) && rec.transcriptAi.length ? rec.transcriptAi : rec.transcript;
        const dialog = src.map(s => `${s.speaker || 'Говорящий'}: ${s.text}`).join('\n');
        const resp = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            temperature: 1.0,
            messages: [
              {
                role: 'system',
                content: 'Ты делаешь краткие саммари звонков на русском. По транскрипту составь: ' +
                  '1) «О чём говорили» — 2-4 предложения; 2) «Ключевые моменты» — маркированный список; ' +
                  '3) «Решения и договорённости» — список (если были); 4) «Задачи» — кто и что должен сделать (если были). ' +
                  'Пиши сжато, без воды. Если разговор бытовой/шуточный — так и скажи, не выдумывай деловых решений.',
              },
              { role: 'user', content: dialog.slice(0, 60000) },
            ],
          }),
        });
        if (!resp.ok) throw new Error('DeepSeek HTTP ' + resp.status);
        const data = await resp.json();
        const summary = data.choices[0].message.content.trim();
        await prisma.recording.update({ where: { id: rec.id }, data: { summary, summaryStatus: 'done' } });
      } catch (e) {
        console.error('AI SUMMARY ERROR:', e.message);
        await prisma.recording.update({ where: { id: rec.id }, data: { summaryStatus: 'failed' } }).catch(() => {});
      }
    })();
  } catch (e) {
    console.error('SUMMARY ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

module.exports = router;
module.exports.stopRecordingOnEmptyRoom = stopRecordingOnEmptyRoom;
