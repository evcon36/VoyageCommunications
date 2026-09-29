const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const ukey = require('../lib/username');
const friends = require('../lib/friends');

const ACCOUNTS_API = process.env.ACCOUNTS_API || 'http://127.0.0.1:3005';
const router = express.Router();

// Сообщаем обоим, что их связь изменилась: у второго должна загореться
// заявка или обновиться список, не дожидаясь, пока он сам его перезапросит.
function notify(...usernames) {
  for (const u of usernames) global.emitToUser?.(u, 'friends-changed', {});
}

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
// Друзья, свои неотвеченные заявки и заявки ко мне. Поле contacts — старый
// формат для выпущенной версии 1.0: она ждёт [{contactUsername}] и ничего
// не знает о заявках. Ей отдаём друзей и отправленные заявки — ровно то, что
// раньше было её списком.
router.get('/', authMiddleware, async (req, res) => {
  try {
    await friends.migrateLegacyFor(req.user.id, req.user.username);
    const { friends: list, outgoing, incoming } = await friends.listFor(req.user.username);
    const contacts = [
      ...list.map((f) => ({ contactUsername: f.username, alias: f.alias, status: 'friend' })),
      ...outgoing.map((o) => ({ contactUsername: o.username, alias: null, status: 'outgoing' })),
    ];
    return res.json({ friends: list, outgoing, incoming, contacts });
  } catch (e) {
    console.error('CONTACTS GET ERROR:', e);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// Настоящее написание имени и заодно проверка, что такой человек есть.
// Раньше контакт сохранялся ровно так, как его вписали: строчное «vmozark»
// при настоящем VMOZARK выглядело в списке нормально, а звонок по нему
// обрывался ещё до начала. Спрашиваем точным /user-exists — нечёткий
// /search-users с лимитом в десять строк для проверки не годится: точное
// совпадение могло не попасть в выдачу. Если accounts-api недоступен,
// сохраняем как ввели: сравнение всё равно идёт без оглядки на регистр.
async function canonicalUsername(uname, authorization) {
  try {
    const r = await fetch(`${ACCOUNTS_API}/user-exists?username=${encodeURIComponent(uname)}`, {
      headers: { Authorization: authorization || '' },
    });
    if (!r.ok) return { name: uname, checked: false };
    const data = await r.json().catch(() => ({}));
    if (!data.exists) return { name: null, checked: true };
    return { name: data.user?.username || uname, checked: true };
  } catch {
    return { name: uname, checked: false };
  }
}

// ── POST /contacts { username } ── заявка в друзья
// Этим же маршрутом «добавляет контакт» выпущенная версия 1.0 — для неё
// добавление теперь тоже заявка. Если встречная заявка уже ждёт, это
// согласие, и оба сразу друзья.
router.post('/', authMiddleware, async (req, res) => {
  try {
    const typed = String((req.body || {}).username || '').trim();
    if (!typed) return res.status(400).json({ message: 'username обязателен' });
    if (ukey(typed) === ukey(req.user.username))
      return res.status(400).json({ message: 'Нельзя добавить себя' });
    const { name, checked } = await canonicalUsername(typed, req.headers.authorization);
    if (checked && !name) return res.status(404).json({ message: 'Пользователь не найден' });
    const status = await friends.request(req.user.username, name);
    notify(req.user.username, name);
    // contact — поле для 1.0, она ждёт его в ответе
    return res.status(201).json({ status, contact: { contactUsername: name } });
  } catch (e) {
    console.error('CONTACTS ADD ERROR:', e);
    return res.status(500).json({ message: 'Ошибка добавления' });
  }
});

// ── POST /contacts/accept { username } ── принять заявку
router.post('/accept', authMiddleware, async (req, res) => {
  try {
    const other = String((req.body || {}).username || '').trim();
    if (!other) return res.status(400).json({ message: 'username обязателен' });
    const ok = await friends.accept(req.user.username, other);
    if (!ok) return res.status(404).json({ message: 'Заявки нет' });
    notify(req.user.username, other);
    return res.json({ status: 'friends' });
  } catch (e) {
    console.error('CONTACTS ACCEPT ERROR:', e);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── POST /contacts/decline { username } ── отклонить заявку
router.post('/decline', authMiddleware, async (req, res) => {
  try {
    const other = String((req.body || {}).username || '').trim();
    const link = await friends.getLink(req.user.username, other);
    // Отклонить можно только заявку к себе. Свою — отменяют через DELETE,
    // а дружбу этим маршрутом не рвут.
    if (!link || link.status !== 'pending' || ukey(link.addressee) !== ukey(req.user.username)) {
      return res.status(404).json({ message: 'Заявки нет' });
    }
    await friends.remove(req.user.username, other);
    notify(req.user.username, other);
    return res.json({ status: 'declined' });
  } catch (e) {
    console.error('CONTACTS DECLINE ERROR:', e);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── PATCH /contacts/alias { username, alias } ── своё имя для контакта
router.patch('/alias', authMiddleware, async (req, res) => {
  try {
    const { username, alias } = req.body || {};
    const ok = await friends.rename(req.user.username, String(username || ''), alias);
    if (!ok) return res.status(404).json({ message: 'Переименовать можно только друга' });
    notify(req.user.username);
    return res.json({ ok: true });
  } catch (e) {
    console.error('CONTACTS ALIAS ERROR:', e);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── DELETE /contacts/:username ── удалить из друзей или отменить свою заявку
router.delete('/:username', authMiddleware, async (req, res) => {
  try {
    await friends.remove(req.user.username, req.params.username);
    notify(req.user.username, req.params.username);
    return res.json({ message: 'Удалён' });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

module.exports = router;
