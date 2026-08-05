const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');
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

// Сверить «активные» записи с реальным egress; на завершении сохранить таймлайн
async function syncActiveRecordings() {
  const active = await prisma.recording.findMany({ where: { status: 'active' } });
  if (!active.length) return;
  for (const rec of active) {
    try {
      const infos = await egress.listEgress({ egressId: rec.egressId });
      const info = infos && infos[0];
      if (!info) continue;
      const s = Number(info.status); // 3=COMPLETE 4=FAILED 5=ABORTED
      if (s >= 3) {
        const speakerLog = recTimeline.endRec(rec.id);
        await prisma.recording.update({
          where: { id: rec.id },
          data: { status: s === 3 ? 'done' : 'failed', endedAt: new Date(), speakerLog },
        });
      }
    } catch (e) { console.error('REC SYNC:', e.message); }
  }
}

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

    // Записывать можно только разговор между людьми с аккаунтами. Голос и лицо
    // это биометрия: человек без аккаунта ничего не подписывал и о записи
    // договориться с ним негде. Плашка «идёт запись» такой договорённостью не
    // является, поэтому при госте в комнате запись недоступна никому.
    try {
      const parts = await roomSvc.listParticipants(roomId);
      const guest = (parts || []).find(p => String(p.identity || '').startsWith('guest#'));
      if (guest) {
        return res.status(403).json({
          message: 'В комнате есть участник без аккаунта. Запись доступна, когда все вошли в свои аккаунты',
          reason: 'guest-present',
          guestName: guest.name || null,
        });
      }
    } catch (e) {
      // состав комнаты неизвестен — значит поручиться, что гостей нет, нельзя
      console.error('REC GUEST CHECK ERROR:', e.message);
      return res.status(503).json({ message: 'Не удалось проверить состав комнаты. Попробуйте ещё раз' });
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

    // Chrome в egress иногда не стартует (слабый CPU) — проверяем через 5с,
    // что запись реально пошла, иначе честно сообщаем об ошибке
    await new Promise(r => setTimeout(r, 5000));
    try {
      const infos = await egress.listEgress({ egressId: info.egressId });
      const st = Number(infos?.[0]?.status ?? 0);
      if (st >= 4) { // FAILED/ABORTED
        recTimeline.endRec(rec.id);
        await prisma.recording.update({ where: { id: rec.id }, data: { status: 'failed', endedAt: new Date() } });
        return res.status(500).json({ message: 'Запись не запустилась — попробуйте ещё раз' });
      }
    } catch {}
    return res.status(201).json({ recording: rec });
  } catch (e) {
    console.error('REC START ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось начать запись' });
  }
});

// ── Остановить запись ──
router.post('/stop', authMiddleware, async (req, res) => {
  const { roomId } = req.body || {};
  const rec = await prisma.recording.findFirst({ where: { roomId, status: 'active' } });
  if (!rec) return res.status(404).json({ message: 'Активной записи нет' });

  try {
    await egress.stopEgress(rec.egressId);
    const speakerLog = recTimeline.endRec(rec.id);
    const updated = await prisma.recording.update({
      where: { id: rec.id },
      data: { status: 'done', endedAt: new Date(), speakerLog },
    });
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
    if (rec.transcriptStatus === 'processing') return res.status(409).json({ message: 'Уже обрабатывается' });
    if (transcribeBusy) return res.status(429).json({ message: 'Сервер занят другой расшифровкой, попробуйте позже' });

    await prisma.recording.update({ where: { id: rec.id }, data: { transcriptStatus: 'processing' } });
    res.status(202).json({ message: 'Транскрибация запущена' });

    // фоновая обработка
    transcribeBusy = true;
    const filePath = `${RECORDINGS_DIR}/${rec.fileName}`;
    const child = spawn(WHISPER_PY, [TRANSCRIBE_PY, filePath], { env: { ...process.env, WHISPER_MODEL: 'small' } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
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
      }
    });
  } catch (e) {
    console.error('TRANSCRIBE ERROR:', e.message);
    transcribeBusy = false;
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
