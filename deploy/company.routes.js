const express = require('express');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth.middleware');
const prisma = require('../lib/prisma');

const ACCOUNTS_API = process.env.ACCOUNTS_API || 'http://127.0.0.1:3005';

const router = express.Router();

function makeSlug(name) {
  const base = String(name || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'co';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

// роль пользователя в компании
async function roleOf(companyId, username) {
  const m = await prisma.companyMember.findUnique({
    where: { companyId_username: { companyId, username } },
  });
  return m?.role || null;
}

// ── Создать компанию ──
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    const clean = String(name || '').trim();
    if (clean.length < 2 || clean.length > 60) return res.status(400).json({ message: 'Название: 2–60 символов' });
    const company = await prisma.company.create({
      data: {
        slug: makeSlug(clean),
        name: clean,
        ownerId: req.user.id,
        ownerName: req.user.username,
        members: { create: { username: req.user.username, role: 'owner' } },
      },
      include: { members: true },
    });
    return res.status(201).json({ company });
  } catch (e) {
    console.error('COMPANY CREATE:', e.message);
    return res.status(500).json({ message: 'Не удалось создать компанию' });
  }
});

// ── Мои компании (где я участник) ──
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const memberships = await prisma.companyMember.findMany({
      where: { username: req.user.username },
      include: { company: { include: { members: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const companies = memberships.map(m => ({ ...m.company, myRole: m.role }));
    for (const c of companies) c.members = await enrichAvatars(c.members || [], req.headers.authorization);
    return res.json({ companies });
  } catch (e) {
    console.error('COMPANY MY:', e.message);
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── Инфо о компании (участники) ──
router.get('/:slug', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({
      where: { slug: req.params.slug },
      include: {
        members: { orderBy: { createdAt: 'asc' }, include: { department: { select: { id: true, name: true } } } },
        departments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = company.members.find(m => m.username === req.user.username)?.role;
    if (!myRole) return res.status(403).json({ message: 'Нет доступа' });
    company.members = await enrichAvatars(company.members, req.headers.authorization);
    return res.json({ company: { ...company, myRole } });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── Пригласить участника (owner/admin) ──
router.post('/:slug/invite', authMiddleware, async (req, res) => {
  try {
    const { username, role } = req.body || {};
    const uname = String(username || '').trim();
    if (!uname) return res.status(400).json({ message: 'Укажите ник' });
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Только владелец или админ' });

    // Ник обязан существовать в общей базе аккаунтов Voyage — иначе в компанию
    // попадали произвольные строки (были «сотрудники» d, r, qwerf3qgf).
    let canonical;
    try {
      const r = await fetch(`${ACCOUNTS_API}/user-exists?username=${encodeURIComponent(uname)}`, {
        headers: { Authorization: req.headers.authorization || '' },
      });
      const info = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ message: 'Не удалось проверить аккаунт' });
      if (!info.exists) return res.status(404).json({ message: `Аккаунт «${uname}» не найден` });
      canonical = info.user?.username || uname; // берём написание ника как в базе
    } catch (e) {
      console.error('INVITE LOOKUP:', e.message);
      return res.status(502).json({ message: 'Не удалось проверить аккаунт' });
    }

    // upsert по владельцу понизил бы его роль — запрещаем
    if (canonical.toLowerCase() === String(company.ownerName || '').toLowerCase())
      return res.status(400).json({ message: 'Владелец уже в компании' });

    const newRole = role === 'admin' ? 'admin' : 'member';
    const member = await prisma.companyMember.upsert({
      where: { companyId_username: { companyId: company.id, username: canonical } },
      update: { role: newRole },
      create: { companyId: company.id, username: canonical, role: newRole },
    });
    await audit(company.id, req.user.username, 'member_added', `${canonical} (${newRole})`);
    return res.json({ member, message: `${canonical} добавлен` });
  } catch (e) {
    console.error('COMPANY INVITE:', e.message);
    return res.status(500).json({ message: 'Не удалось добавить' });
  }
});

// ── Убрать участника (owner/admin; владельца убрать нельзя) ──
router.delete('/:slug/members/:username', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const target = req.params.username;
    if (target === company.ownerName) return res.status(400).json({ message: 'Нельзя убрать владельца' });
    await prisma.companyMember.deleteMany({ where: { companyId: company.id, username: target } });
    await audit(company.id, req.user.username, 'member_removed', target);
    return res.json({ message: 'Участник удалён' });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// журнал действий
async function audit(companyId, actor, action, detail) {
  try { await prisma.companyAudit.create({ data: { companyId, actor, action, detail: detail || null } }); } catch {}
}

// Обогащаем список {username,...} аватарками из accounts-api (для списков сотрудников)
async function enrichAvatars(items, authHeader) {
  const names = [...new Set(items.map(i => i.username).filter(Boolean))];
  if (!names.length) return items;
  try {
    const r = await fetch(`${ACCOUNTS_API}/avatars?usernames=${encodeURIComponent(names.join(','))}`, {
      headers: { Authorization: authHeader || '' },
    });
    if (!r.ok) return items.map(i => ({ ...i, avatarUrl: null }));
    const { avatars } = await r.json();
    return items.map(i => ({ ...i, avatarUrl: avatars?.[String(i.username).toLowerCase()]?.avatarUrl || null }));
  } catch { return items.map(i => ({ ...i, avatarUrl: null })); }
}

// ── Настройки компании: название, цвет, политики (owner/admin) ──
router.patch('/:slug', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const b = req.body || {};
    const data = {};
    if (typeof b.name === 'string' && b.name.trim().length >= 2) data.name = b.name.trim().slice(0, 60);
    if (typeof b.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.accent)) data.accent = b.accent;
    if (typeof b.defaultWaitingRoom === 'boolean') data.defaultWaitingRoom = b.defaultWaitingRoom;
    if (typeof b.defaultMuteOnJoin === 'boolean') data.defaultMuteOnJoin = b.defaultMuteOnJoin;
    if (['owner', 'admin', 'anyone'].includes(b.recordPolicy)) data.recordPolicy = b.recordPolicy;
    if (['admin', 'anyone'].includes(b.whoCanCreateRooms)) data.whoCanCreateRooms = b.whoCanCreateRooms;
    if (typeof b.guestAccess === 'boolean') data.guestAccess = b.guestAccess;
    const updated = await prisma.company.update({ where: { id: company.id }, data });
    await audit(company.id, req.user.username, 'settings_changed', Object.keys(data).join(', '));
    return res.json({ company: updated });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── Сменить роль участника (owner меняет админов; владельца не трогаем) ──
router.patch('/:slug/members/:username', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner') return res.status(403).json({ message: 'Роли меняет только владелец' });
    const target = req.params.username;
    if (target === company.ownerName) return res.status(400).json({ message: 'Роль владельца неизменна' });
    const newRole = req.body.role === 'admin' ? 'admin' : 'member';
    await prisma.companyMember.update({
      where: { companyId_username: { companyId: company.id, username: target } },
      data: { role: newRole },
    });
    await audit(company.id, req.user.username, 'role_changed', `${target} → ${newRole}`);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

// ── Комнаты компании (постоянные переговорки со ссылками) ──
router.get('/:slug/rooms', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    if (!(await roleOf(company.id, req.user.username))) return res.status(403).json({ message: 'Нет доступа' });
    const rooms = await prisma.room.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'desc' } });
    return res.json({ rooms });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

router.post('/:slug/rooms', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (!myRole) return res.status(403).json({ message: 'Нет доступа' });
    if (company.whoCanCreateRooms === 'admin' && myRole === 'member')
      return res.status(403).json({ message: 'Создавать комнаты могут только админы' });
    const crypto = require('crypto');
    const slug = `voy-${crypto.randomBytes(3).toString('hex')}`;
    const room = await prisma.room.create({
      data: {
        slug,
        name: String(req.body.name || 'Переговорка').slice(0, 60),
        ownerId: req.user.id,
        ownerName: req.user.username,
        isPrivate: true,
        waitingRoom: req.body.waitingRoom ?? company.defaultWaitingRoom,
        muteOnJoin: req.body.muteOnJoin ?? company.defaultMuteOnJoin,
        companyId: company.id,
        inviteKey: crypto.randomBytes(8).toString('base64url'),
      },
    });
    await audit(company.id, req.user.username, 'room_created', room.name);
    return res.status(201).json({ room });
  } catch (e) { console.error('CO ROOM:', e.message); return res.status(500).json({ message: 'Ошибка' }); }
});

router.delete('/:slug/rooms/:roomSlug', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    await prisma.room.deleteMany({ where: { slug: req.params.roomSlug, companyId: company.id } });
    await audit(company.id, req.user.username, 'room_deleted', req.params.roomSlug);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Статистика компании ──
router.get('/:slug/stats', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug }, include: { members: true } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    if (!(await roleOf(company.id, req.user.username))) return res.status(403).json({ message: 'Нет доступа' });
    const rooms = await prisma.room.findMany({ where: { companyId: company.id }, select: { slug: true } });
    const slugs = rooms.map(r => r.slug);
    const [sessions, recordings] = await Promise.all([
      slugs.length ? prisma.callSession.findMany({ where: { roomId: { in: slugs } }, select: { duration: true } }) : [],
      slugs.length ? prisma.recording.count({ where: { roomId: { in: slugs } } }) : 0,
    ]);
    const totalMinutes = Math.round(sessions.reduce((a, s) => a + (s.duration || 0), 0) / 60);
    return res.json({
      members: company.members.length,
      rooms: slugs.length,
      meetings: sessions.length,
      totalMinutes,
      recordings,
    });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Записи компании ──
router.get('/:slug/recordings', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const rooms = await prisma.room.findMany({ where: { companyId: company.id }, select: { slug: true } });
    const slugs = rooms.map(r => r.slug);
    const recs = slugs.length
      ? await prisma.recording.findMany({ where: { roomId: { in: slugs } }, orderBy: { startedAt: 'desc' }, take: 100 })
      : [];
    return res.json({ recordings: recs.map(({ speakerLog, ...r }) => r) });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Запланированные встречи ──
router.get('/:slug/meetings', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    if (!(await roleOf(company.id, req.user.username))) return res.status(403).json({ message: 'Нет доступа' });
    // будущие + недавние (за последний час)
    const meetings = await prisma.meeting.findMany({
      where: { companyId: company.id, scheduledAt: { gte: new Date(Date.now() - 3600 * 1000) } },
      orderBy: { scheduledAt: 'asc' }, take: 50,
    });
    return res.json({ meetings });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

router.post('/:slug/meetings', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (!myRole) return res.status(403).json({ message: 'Нет доступа' });
    const title = String(req.body.title || '').trim();
    const scheduledAt = new Date(req.body.scheduledAt);
    if (title.length < 2) return res.status(400).json({ message: 'Укажите название встречи' });
    if (isNaN(scheduledAt.getTime())) return res.status(400).json({ message: 'Укажите дату и время' });
    // персональная комната встречи
    const slug = `voy-${crypto.randomBytes(3).toString('hex')}`;
    const inviteKey = crypto.randomBytes(8).toString('base64url');
    await prisma.room.create({
      data: { slug, name: title.slice(0, 60), ownerId: req.user.id, ownerName: req.user.username,
        isPrivate: true, waitingRoom: company.defaultWaitingRoom, muteOnJoin: company.defaultMuteOnJoin,
        companyId: company.id, inviteKey },
    });
    const meeting = await prisma.meeting.create({
      data: { companyId: company.id, title: title.slice(0, 80), roomSlug: slug, inviteKey, scheduledAt, createdBy: req.user.username },
    });
    await audit(company.id, req.user.username, 'meeting_scheduled', title);
    return res.status(201).json({ meeting });
  } catch (e) { console.error('MEETING:', e.message); return res.status(500).json({ message: 'Ошибка' }); }
});

router.delete('/:slug/meetings/:id', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (!myRole) return res.status(403).json({ message: 'Нет доступа' });
    await prisma.meeting.deleteMany({ where: { id: req.params.id, companyId: company.id } });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Ближайшие встречи всех моих компаний (для главного экрана) ──
router.get('/meetings/upcoming', authMiddleware, async (req, res) => {
  try {
    const memberships = await prisma.companyMember.findMany({ where: { username: req.user.username }, select: { companyId: true } });
    const ids = memberships.map(m => m.companyId);
    if (!ids.length) return res.json({ meetings: [] });
    const meetings = await prisma.meeting.findMany({
      where: { companyId: { in: ids }, scheduledAt: { gte: new Date(Date.now() - 3600 * 1000) } },
      orderBy: { scheduledAt: 'asc' }, take: 10,
    });
    return res.json({ meetings });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Журнал действий ──
router.get('/:slug/audit', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const log = await prisma.companyAudit.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'desc' }, take: 60 });
    return res.json({ log });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Отделы: список ──
router.get('/:slug/departments', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    if (!(await roleOf(company.id, req.user.username))) return res.status(403).json({ message: 'Нет доступа' });
    const departments = await prisma.department.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return res.json({ departments: departments.map(d => ({ id: d.id, name: d.name, head: d.head, count: d._count.members })) });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Отделы: создать (owner/admin) ──
router.post('/:slug/departments', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const name = String(req.body.name || '').trim();
    if (name.length < 2) return res.status(400).json({ message: 'Название отдела: 2+ символа' });
    const dep = await prisma.department.create({ data: { companyId: company.id, name: name.slice(0, 40), head: req.body.head || null } });
    await audit(company.id, req.user.username, 'department_created', dep.name);
    return res.status(201).json({ department: dep });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Отделы: переименовать / назначить руководителя (owner/admin) ──
router.patch('/:slug/departments/:id', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const data = {};
    if (typeof req.body.name === 'string' && req.body.name.trim().length >= 2) data.name = req.body.name.trim().slice(0, 40);
    if (typeof req.body.head === 'string') data.head = req.body.head.trim() || null;
    await prisma.department.updateMany({ where: { id: req.params.id, companyId: company.id }, data });
    await audit(company.id, req.user.username, 'department_updated', data.name || req.params.id);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Отделы: удалить (owner/admin) ──
router.delete('/:slug/departments/:id', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    await prisma.department.deleteMany({ where: { id: req.params.id, companyId: company.id } });
    await audit(company.id, req.user.username, 'department_deleted', req.params.id);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Профиль сотрудника: должность + отдел (owner/admin) ──
router.patch('/:slug/members/:username/profile', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });
    const data = {};
    if (typeof req.body.title === 'string') data.title = req.body.title.trim().slice(0, 60) || null;
    if ('departmentId' in req.body) {
      const depId = req.body.departmentId || null;
      if (depId) {
        const dep = await prisma.department.findFirst({ where: { id: depId, companyId: company.id } });
        if (!dep) return res.status(400).json({ message: 'Отдел не найден' });
      }
      data.departmentId = depId;
    }
    await prisma.companyMember.update({
      where: { companyId_username: { companyId: company.id, username: req.params.username } },
      data,
    });
    await audit(company.id, req.user.username, 'member_profile', `${req.params.username}: ${data.title ?? ''}`);
    return res.json({ ok: true });
  } catch (e) { console.error('MEMBER PROFILE:', e.message); return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Мой профиль в компании + личная активность (доступно любому участнику) ──
router.get('/:slug/me', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({
      where: { slug: req.params.slug },
      include: { members: { where: { username: req.user.username }, include: { department: { select: { id: true, name: true } } } } },
    });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const me = company.members[0];
    if (!me) return res.status(403).json({ message: 'Нет доступа' });

    const rooms = await prisma.room.findMany({ where: { companyId: company.id }, select: { slug: true } });
    const slugs = rooms.map(r => r.slug);
    const sessions = slugs.length
      ? await prisma.callSession.findMany({ where: { roomId: { in: slugs }, userName: req.user.username }, select: { duration: true, joinedAt: true } })
      : [];
    const seconds = sessions.reduce((a, s) => a + (s.duration || 0), 0);
    const last = sessions.reduce((a, s) => (!a || s.joinedAt > a ? s.joinedAt : a), null);
    return res.json({
      me: { username: me.username, role: me.role, title: me.title || null, department: me.department?.name || null, departmentId: me.departmentId || null },
      activity: { meetings: sessions.length, minutes: Math.round(seconds / 60), lastActive: last },
    });
  } catch (e) { console.error('COMPANY ME:', e.message); return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Аналитика по сотрудникам (учёт активности) ──
router.get('/:slug/analytics', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({
      where: { slug: req.params.slug },
      include: { members: { include: { department: { select: { name: true } } } } },
    });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    const myRole = await roleOf(company.id, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ message: 'Нет прав' });

    const rooms = await prisma.room.findMany({ where: { companyId: company.id }, select: { slug: true } });
    const slugs = rooms.map(r => r.slug);
    const sessions = slugs.length
      ? await prisma.callSession.findMany({
          where: { roomId: { in: slugs }, userName: { not: null } },
          select: { userName: true, duration: true, joinedAt: true },
        })
      : [];

    // агрегируем по нику
    const byUser = new Map();
    for (const s of sessions) {
      const key = s.userName;
      if (!byUser.has(key)) byUser.set(key, { meetings: 0, seconds: 0, last: null });
      const a = byUser.get(key);
      a.meetings += 1;
      a.seconds += s.duration || 0;
      if (!a.last || s.joinedAt > a.last) a.last = s.joinedAt;
    }

    const now = Date.now();
    const rows = company.members.map(m => {
      const a = byUser.get(m.username) || { meetings: 0, seconds: 0, last: null };
      return {
        username: m.username,
        role: m.role,
        title: m.title || null,
        department: m.department?.name || null,
        meetings: a.meetings,
        minutes: Math.round(a.seconds / 60),
        lastActive: a.last,
        active7d: a.last ? (now - new Date(a.last).getTime()) < 7 * 864e5 : false,
      };
    }).sort((x, y) => y.minutes - x.minutes);

    const enrichedRows = await enrichAvatars(rows, req.headers.authorization);
    const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
    return res.json({
      rows: enrichedRows,
      summary: {
        employees: rows.length,
        activeThisWeek: rows.filter(r => r.active7d).length,
        totalMinutes,
        avgMinutes: rows.length ? Math.round(totalMinutes / rows.length) : 0,
      },
    });
  } catch (e) { console.error('ANALYTICS:', e.message); return res.status(500).json({ message: 'Ошибка' }); }
});

// ── Удалить компанию (только владелец) ──
router.delete('/:slug', authMiddleware, async (req, res) => {
  try {
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ message: 'Компания не найдена' });
    if (company.ownerId !== req.user.id) return res.status(403).json({ message: 'Только владелец' });
    await prisma.company.delete({ where: { id: company.id } });
    return res.json({ message: 'Компания удалена' });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка' });
  }
});

module.exports = router;
