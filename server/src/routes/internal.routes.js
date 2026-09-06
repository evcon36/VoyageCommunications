const express = require('express');
const fs = require('fs');
const path = require('path');
const prisma = require('../lib/prisma');

const router = express.Router();

const RECORDINGS_DIR = '/var/www/voyage/recordings';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

// Роуты для служебных вызовов с этой же машины (accounts-api, cron).
// Наружу не проксируются nginx'ом, плюс требуют общий секрет.
function internalOnly(req, res, next) {
  if (!INTERNAL_SECRET) return res.status(500).json({ message: 'INTERNAL_SECRET не настроен' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
    return res.status(403).json({ message: 'Нет доступа' });
  }
  const ip = (req.ip || '').replace('::ffff:', '');
  if (ip !== '127.0.0.1' && ip !== '::1') return res.status(403).json({ message: 'Только с localhost' });
  next();
}

// Удаляет файл записи с диска. Имя всегда простое (rec-<room>-<ts>-<hex>.mp4),
// но путь всё равно проверяем — на случай мусора в базе.
function removeRecordingFile(fileName) {
  if (!fileName) return false;
  const full = path.join(RECORDINGS_DIR, path.basename(fileName));
  if (!full.startsWith(RECORDINGS_DIR)) return false;
  try {
    fs.unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

// ── POST /internal/purge-user ──
// Стирает все данные COMS, принадлежащие пользователю. Вызывается
// cron-скриптом очистки, когда истекла 30-дневная отсрочка удаления аккаунта.
router.post('/purge-user', internalOnly, async (req, res) => {
  const { accountId, username } = req.body || {};
  if (!accountId && !username) {
    return res.status(400).json({ message: 'нужен accountId или username' });
  }
  const uid = accountId ? String(accountId) : null;
  const uname = username ? String(username) : null;

  try {
    const stats = { companies: 0, rooms: 0, recordings: 0, files: 0, sessions: 0, contacts: 0, memberships: 0, meetings: 0 };

    // Комнаты, которые надо снести: собственные плюс принадлежащие компаниям пользователя.
    const ownedCompanies = uid
      ? await prisma.company.findMany({ where: { ownerId: uid }, select: { id: true } })
      : [];
    const companyIds = ownedCompanies.map((c) => c.id);

    const rooms = await prisma.room.findMany({
      where: {
        OR: [
          ...(uid ? [{ ownerId: uid }] : []),
          ...(companyIds.length ? [{ companyId: { in: companyIds } }] : []),
        ],
      },
      select: { slug: true },
    });
    const roomSlugs = rooms.map((r) => r.slug);

    // Записи: и по комнатам пользователя, и запущенные им в чужих комнатах.
    const recordings = await prisma.recording.findMany({
      where: {
        OR: [
          ...(roomSlugs.length ? [{ roomId: { in: roomSlugs } }] : []),
          ...(uname ? [{ startedBy: uname }] : []),
        ],
      },
      select: { id: true, fileName: true },
    });

    // Файлы удаляем до записей в базе: если упадём, останется след в БД,
    // по которому можно доубрать. Обратный порядок оставил бы файлы-сироты.
    for (const rec of recordings) {
      if (removeRecordingFile(rec.fileName)) stats.files++;
    }

    await prisma.$transaction(async (tx) => {
      if (recordings.length) {
        const r = await tx.recording.deleteMany({ where: { id: { in: recordings.map((x) => x.id) } } });
        stats.recordings = r.count;
      }
      if (roomSlugs.length) {
        stats.sessions += (await tx.callSession.deleteMany({ where: { roomId: { in: roomSlugs } } })).count;
        stats.rooms = (await tx.room.deleteMany({ where: { slug: { in: roomSlugs } } })).count;
      }
      if (companyIds.length) {
        await tx.companyAudit.deleteMany({ where: { companyId: { in: companyIds } } });
        stats.meetings += (await tx.meeting.deleteMany({ where: { companyId: { in: companyIds } } })).count;
        // участники и отделы уходят каскадом вместе с компанией
        stats.companies = (await tx.company.deleteMany({ where: { id: { in: companyIds } } })).count;
      }
      if (uid) {
        stats.sessions += (await tx.callSession.deleteMany({ where: { userId: uid } })).count;
        stats.contacts += (await tx.contact.deleteMany({ where: { ownerId: uid } })).count;
      }
      if (uname) {
        // контакты в обе стороны: пользователь исчезает и из чужих списков
        stats.contacts += (await tx.contact.deleteMany({ where: { contactUsername: uname } })).count;
        stats.memberships = (await tx.companyMember.deleteMany({ where: { username: uname } })).count;
        stats.meetings += (await tx.meeting.deleteMany({ where: { createdBy: uname } })).count;
        await tx.companyAudit.deleteMany({ where: { actor: uname } });
        await tx.user.deleteMany({ where: { username: uname } });
      }
    });

    console.log('PURGE USER', uname || uid, JSON.stringify(stats));
    return res.json({ ok: true, stats });
  } catch (e) {
    console.error('PURGE USER ERROR', e.message);
    return res.status(500).json({ message: 'Ошибка очистки', error: e.message });
  }
});

module.exports = router;
