// Вложения в чат звонка: картинки и файлы до 15 МБ.
//
// Принимаем поток байтов, а имя и тип берём из запроса: так не нужна
// отдельная библиотека разбора форм, а поведение проще и предсказуемее.
//
// Имя файла с клиента никогда не используется для записи на диск: там могут
// быть и переходы по каталогам, и расширения, которые сервер попробует
// выполнить. Имя сохраняем только как подпись для показа, а на диск кладём
// под случайным именем с расширением из белого списка.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const router = express.Router();

const ROOT = '/var/www/voyage/uploads/chat';
const MAX_BYTES = 15 * 1024 * 1024;

// Что вообще можно присылать. Всё остальное отклоняем: список разрешённого
// надёжнее списка запрещённого, забыть опасное расширение легко.
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic']);
const DOC = new Set(['pdf', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rtf', 'md']);

// Тип определяем по содержимому, а не по присланному заголовку: подпись
// «это картинка» ничего не стоит, а первые байты подделать сложнее.
function sniff(buf) {
  if (buf.length < 12) return null;
  const hex = buf.slice(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (hex.startsWith('47494638')) return 'gif';
  if (hex.startsWith('52494646') && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (hex.startsWith('25504446')) return 'pdf';
  if (hex.startsWith('504b0304')) return 'zip';   // сюда же docx, xlsx, pptx
  return null;
}

// Отдельная защита от заваливания диска: десять файлов в минуту с адреса
const recent = new Map();
function allowed(ip) {
  const now = Date.now();
  const fresh = (recent.get(ip) || []).filter(t => now - t < 60_000);
  if (fresh.length >= 10) { recent.set(ip, fresh); return false; }
  fresh.push(now);
  recent.set(ip, fresh);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of recent) {
    const fresh = times.filter(t => now - t < 60_000);
    if (fresh.length) recent.set(ip, fresh); else recent.delete(ip);
  }
}, 60_000).unref();

// Право положить файл в комнату.
//
// Раньше этот адрес не спрашивал вообще ничего: любой человек из интернета мог
// класть файлы до 15 МБ на наш диск и получать на них постоянную ссылку с
// нашего домена. Это и место на диске, и чужие файлы под нашим именем, что для
// домена, за которым и так присматривают, отдельно плохо.
//
// Доказательством служит токен медиасервера: он подписан нашим ключом, внутри
// несёт название комнаты и живёт четыре часа. У всех, кто в звонке, он уже есть.
function roomTokenOk(roomId, token) {
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!secret || !token) return false;
  try {
    const claims = jwt.verify(String(token), secret);
    return claims?.video?.roomJoin === true && claims?.video?.room === roomId;
  } catch {
    return false;
  }
}

router.post('/upload',
  express.raw({ type: '*/*', limit: MAX_BYTES }),
  async (req, res) => {
    try {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!allowed(ip)) {
        return res.status(429).json({ message: 'Слишком много файлов подряд. Подождите минуту' });
      }

      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ message: 'Файл пустой' });
      }
      if (buf.length > MAX_BYTES) {
        return res.status(413).json({ message: 'Файл больше 15 МБ' });
      }

      // Точки из имени убираем вовсе: переход по каталогам они не дают, но
      // порождают папки вида «....etc», в которых потом не разобраться
      const room = String(req.query.room || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
      if (!room) return res.status(400).json({ message: 'Не указана комната' });

      const pass = req.get('X-Room-Token') || '';
      if (!roomTokenOk(room, pass)) {
        return res.status(403).json({ message: 'Файлы можно отправлять только из своего звонка' });
      }

      const rawName = String(req.query.name || 'файл').slice(0, 120);
      // Расширение берём из имени, но доверяем ему только после сверки с
      // содержимым: присланное имя это подпись, а не источник правды
      const claimed = (rawName.split('.').pop() || '').toLowerCase();
      const real = sniff(buf);

      let ext = null;
      if (real && IMAGE.has(real)) ext = real;
      else if (real === 'pdf') ext = 'pdf';
      else if (real === 'zip' && DOC.has(claimed)) ext = claimed;  // docx и подобные
      else if (!real && DOC.has(claimed)) ext = claimed;           // txt, csv, md без подписи
      if (!ext) {
        return res.status(415).json({ message: 'Такой тип файла отправить нельзя' });
      }

      const dir = path.join(ROOT, room);
      await fs.promises.mkdir(dir, { recursive: true });
      const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      await fs.promises.writeFile(path.join(dir, stored), buf, { mode: 0o644 });

      return res.status(201).json({
        url: `/uploads/chat/${room}/${stored}`,
        name: rawName,
        size: buf.length,
        kind: IMAGE.has(ext) ? 'image' : 'file',
      });
    } catch (e) {
      if (e.type === 'entity.too.large') {
        return res.status(413).json({ message: 'Файл больше 15 МБ' });
      }
      console.error('CHAT UPLOAD ERROR:', e.message);
      return res.status(500).json({ message: 'Не удалось загрузить файл' });
    }
  });

module.exports = router;
