const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');

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

// ── POST /contacts { username } ──
router.post('/', authMiddleware, async (req, res) => {
  try {
    const uname = String((req.body || {}).username || '').trim();
    if (!uname) return res.status(400).json({ message: 'username обязателен' });
    if (uname.toLowerCase() === String(req.user.username || '').toLowerCase())
      return res.status(400).json({ message: 'Нельзя добавить себя' });
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
    await prisma.contact.deleteMany({
      where: { ownerId: req.user.id, contactUsername: req.params.username },
    });
    return res.json({ message: 'Удалён' });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

module.exports = router;
