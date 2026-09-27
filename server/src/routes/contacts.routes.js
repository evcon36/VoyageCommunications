const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');
const ukey = require('../lib/username');

const ACCOUNTS_API = process.env.ACCOUNTS_API || 'http://127.0.0.1:3005';
const router = express.Router();

// ── GET /contacts/search?q= ── глобальный поиск (прокси в accounts-api).
// Должен идти до '/:username', иначе перехватится другим маршрутом.
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const r = await fetch(`${ACCOUNTS_API}/search-users?q=${encodeURIComponent(req.query.q || '')}`, {
      headers: { Authorization: req.headers.authorization || '' },
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка поиска' });
  }
});

// ── GET /contacts ──
router.get('/', authMiddleware, async (req, res) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: { ownerId: req.user.id },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ contacts });
  } catch (e) {
    console.error('CONTACTS GET ERROR:', e);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// Настоящее написание имени. Контакт раньше сохранялся ровно так, как его
// вписали, и никто не проверял, что такой человек вообще есть. Записанный
// строчными «vmozark» при настоящем VMOZARK выглядел в списке нормально, но
// звонок по нему обрывался ещё до начала: presence и VoIP-токен лежат под
// настоящим написанием. Теперь спрашиваем у accounts-api и храним то, что
// он ответил. Если поиск недоступен — сохраняем как ввели: сравнение всё
// равно идёт без оглядки на регистр (см. lib/username.js), просто в списке
// будет чужое написание.
async function canonicalUsername(uname, authorization) {
  try {
    const r = await fetch(`${ACCOUNTS_API}/search-users?q=${encodeURIComponent(uname)}`, {
      headers: { Authorization: authorization || '' },
    });
    if (!r.ok) return { name: uname, checked: false };
    const data = await r.json().catch(() => ({}));
    const hit = (data.users || []).find((u) => ukey(u.username) === ukey(uname));
    return hit ? { name: hit.username, checked: true } : { name: null, checked: true };
  } catch {
    return { name: uname, checked: false };
  }
}

// ── POST /contacts { username } ──
router.post('/', authMiddleware, async (req, res) => {
  try {
    const typed = String((req.body || {}).username || '').trim();
    if (!typed) return res.status(400).json({ message: 'username обязателен' });
    if (ukey(typed) === ukey(req.user.username))
      return res.status(400).json({ message: 'Нельзя добавить себя' });
    const { name, checked } = await canonicalUsername(typed, req.headers.authorization);
    if (checked && !name) return res.status(404).json({ message: 'Пользователь не найден' });
    const uname = name;
    const contact = await prisma.contact.upsert({
      where: { ownerId_contactUsername: { ownerId: req.user.id, contactUsername: uname } },
      create: { ownerId: req.user.id, contactUsername: uname },
      update: {},
    });
    return res.status(201).json({ contact });
  } catch (e) {
    console.error('CONTACTS ADD ERROR:', e);
    return res.status(500).json({ message: 'Ошибка добавления' });
  }
});

// ── DELETE /contacts/:username ──
router.delete('/:username', authMiddleware, async (req, res) => {
  try {
    // Регистр здесь тоже не должен мешать: в списке может лежать старое
    // написание, а клиент прислать настоящее.
    const rows = await prisma.contact.findMany({ where: { ownerId: req.user.id } });
    const ids = rows.filter((c) => ukey(c.contactUsername) === ukey(req.params.username)).map((c) => c.id);
    if (ids.length) await prisma.contact.deleteMany({ where: { id: { in: ids } } });
    return res.json({ message: 'Удалён' });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

module.exports = router;
