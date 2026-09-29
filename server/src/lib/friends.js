// Дружба между аккаунтами: заявка, согласие, имя контакта.
//
// Раньше контакт был односторонним: добавил человека — и звонишь ему, его
// согласия никто не спрашивал. Теперь связь двусторонняя и живёт одной
// строкой на пару людей. Строка хранит, кто позвал, согласился ли второй и
// как каждая сторона подписала другую у себя в контактах.
//
// Таблицы нет в Prisma-схеме — как и у VoipPushToken с UserBlock. В боевой
// базе есть таблицы вне схемы, поэтому `prisma db push` там запускать нельзя:
// он попытался бы их удалить. Таблица заводится здесь, идемпотентно, при
// старте сервера.
const prisma = require('./prisma');
const ukey = require('./username');

// Пара людей даёт один ключ независимо от того, кто позвал: иначе встречные
// заявки создавали бы две строки на одну дружбу.
const pairKey = (a, b) => [ukey(a), ukey(b)].sort().join('|');

async function ensureSchema() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FriendLink" (
      "pairKey"        TEXT PRIMARY KEY,
      "requester"      TEXT NOT NULL,
      "addressee"      TEXT NOT NULL,
      "status"         TEXT NOT NULL DEFAULT 'pending',
      "requesterAlias" TEXT,
      "addresseeAlias" TEXT,
      "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
      "respondedAt"    TIMESTAMPTZ
    )`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "FriendLink_requester_idx" ON "FriendLink" (lower("requester"))`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "FriendLink_addressee_idx" ON "FriendLink" (lower("addressee"))`);
  // Чьи старые односторонние контакты уже переложены в дружбу. Сами старые
  // строки не трогаем: удалять данные при переезде незачем.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FriendMigration" (
      "ownerId" TEXT PRIMARY KEY,
      "at"      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Пары, которые кто-то из двоих удалил или чью заявку отклонил. Нужна ради
  // переезда: без неё старый односторонний контакт второй стороны, ещё не
  // переложенный, при первом же открытии её контактов воскрешал только что
  // удалённую связь новой заявкой.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FriendRemoved" (
      "pairKey" TEXT PRIMARY KEY,
      "at"      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function getLink(a, b) {
  const rows = await prisma.$queryRaw`
    SELECT * FROM "FriendLink" WHERE "pairKey" = ${pairKey(a, b)} LIMIT 1`;
  return rows[0] || null;
}

async function areFriends(a, b) {
  const link = await getLink(a, b);
  return Boolean(link && link.status === 'accepted');
}

// Как `owner` подписал `other` у себя. У каждой стороны своё имя для другой.
function aliasFromLink(link, owner) {
  if (!link) return null;
  return ukey(link.requester) === ukey(owner) ? link.requesterAlias : link.addresseeAlias;
}
async function aliasOf(owner, other) {
  return aliasFromLink(await getLink(owner, other), owner);
}

// Всё, что касается человека: друзья, его заявки и заявки к нему.
async function listFor(username) {
  const me = ukey(username);
  const rows = await prisma.$queryRaw`
    SELECT * FROM "FriendLink"
    WHERE lower("requester") = ${me} OR lower("addressee") = ${me}
    ORDER BY "createdAt" ASC`;
  const friends = [], outgoing = [], incoming = [];
  for (const r of rows) {
    const iAsked = ukey(r.requester) === me;
    const other = iAsked ? r.addressee : r.requester;
    const alias = iAsked ? r.requesterAlias : r.addresseeAlias;
    if (r.status === 'accepted') friends.push({ username: other, alias: alias || null });
    else if (iAsked) outgoing.push({ username: other, createdAt: r.createdAt });
    else incoming.push({ username: other, createdAt: r.createdAt });
  }
  return { friends, outgoing, incoming };
}

// Заявка. Если встречная уже ждёт — это согласие, а не вторая заявка:
// двое, позвавшие друг друга, сразу друзья.
async function request(from, to) {
  const link = await getLink(from, to);
  if (!link) {
    await prisma.$executeRaw`
      INSERT INTO "FriendLink" ("pairKey", "requester", "addressee", "status")
      VALUES (${pairKey(from, to)}, ${from}, ${to}, 'pending')
      ON CONFLICT ("pairKey") DO NOTHING`;
    return 'requested';
  }
  if (link.status === 'accepted') return 'friends';
  if (ukey(link.addressee) === ukey(from)) {
    await accept(from, to);
    return 'friends';
  }
  return 'requested';   // уже звали, повтор ничего не меняет
}

// Принять может только тот, кого позвали. Иначе звавший сам себе «соглашался».
// Заодно выправляем написание: звавший мог вписать ник как угодно («vmozark»
// при настоящем VMOZARK), а у согласившегося ник точно настоящий — он из его
// собственного токена.
async function accept(me, other) {
  const n = await prisma.$executeRaw`
    UPDATE "FriendLink" SET "status" = 'accepted', "respondedAt" = now(), "addressee" = ${me}
    WHERE "pairKey" = ${pairKey(me, other)} AND "status" = 'pending'
      AND lower("addressee") = ${ukey(me)}`;
  return n > 0;
}

// Отказ, отмена своей заявки и удаление из друзей — одно и то же действие:
// связи между двумя людьми больше нет.
async function remove(me, other) {
  const key = pairKey(me, other);
  const n = await prisma.$executeRaw`
    DELETE FROM "FriendLink" WHERE "pairKey" = ${key}`;
  await prisma.$executeRaw`
    INSERT INTO "FriendRemoved" ("pairKey") VALUES (${key})
    ON CONFLICT ("pairKey") DO UPDATE SET "at" = now()`;
  return n > 0;
}

// Имя контакта. Меняет только свою сторону: как меня подписал собеседник,
// мне не видно и не мне решать.
async function rename(me, other, alias) {
  const clean = String(alias || '').trim().slice(0, 60) || null;
  const link = await getLink(me, other);
  if (!link || link.status !== 'accepted') return false;
  if (ukey(link.requester) === ukey(me)) {
    await prisma.$executeRaw`
      UPDATE "FriendLink" SET "requesterAlias" = ${clean} WHERE "pairKey" = ${link.pairKey}`;
  } else {
    await prisma.$executeRaw`
      UPDATE "FriendLink" SET "addresseeAlias" = ${clean} WHERE "pairKey" = ${link.pairKey}`;
  }
  return true;
}

// ── Переезд старых односторонних контактов ──
// Правило: если двое добавили друг друга, они сразу друзья — звонки у них
// не пропадают. Если добавил только один, его контакт становится отправленной
// заявкой, и второй увидит её в «Уведомлениях». Порядок обработки неважен:
// вторая сторона пары находит заявку первой и превращает её в дружбу.
async function migrateLegacyFor(ownerId, username) {
  if (!ownerId || !username) return;
  const done = await prisma.$queryRaw`
    SELECT 1 FROM "FriendMigration" WHERE "ownerId" = ${String(ownerId)} LIMIT 1`;
  if (done.length) return;
  const legacy = await prisma.contact.findMany({ where: { ownerId: String(ownerId) } });
  for (const c of legacy) {
    if (!c.contactUsername || ukey(c.contactUsername) === ukey(username)) continue;
    // Пару уже удаляли или отклоняли — старый контакт её не воскрешает.
    // Заявку руками после этого отправить можно: request() запрет не читает.
    const removed = await prisma.$queryRaw`
      SELECT 1 FROM "FriendRemoved" WHERE "pairKey" = ${pairKey(username, c.contactUsername)} LIMIT 1`;
    if (removed.length) continue;
    await request(username, c.contactUsername);
  }
  await prisma.$executeRaw`
    INSERT INTO "FriendMigration" ("ownerId") VALUES (${String(ownerId)})
    ON CONFLICT ("ownerId") DO NOTHING`;
}

// Разом для всех, чьё имя удаётся узнать по уже накопленным данным: у
// Contact есть только id владельца, а имя живёт в другой базе. Зато id и
// имя вместе лежат в истории звонков и в комнатах — этого хватает почти на
// всех. Остальных переложит первый же запрос их списка контактов.
async function migrateLegacyAll() {
  const owners = await prisma.$queryRaw`
    SELECT DISTINCT c."ownerId" AS id,
      COALESCE(
        (SELECT s."userName" FROM "CallSession" s
          WHERE s."userId" = c."ownerId" AND s."userName" IS NOT NULL LIMIT 1),
        (SELECT r."ownerName" FROM "Room" r WHERE r."ownerId" = c."ownerId" LIMIT 1)
      ) AS username
    FROM "Contact" c
    WHERE NOT EXISTS (SELECT 1 FROM "FriendMigration" m WHERE m."ownerId" = c."ownerId")`;
  let moved = 0;
  for (const o of owners) {
    if (!o.username) continue;
    await migrateLegacyFor(o.id, o.username);
    moved += 1;
  }
  return { owners: owners.length, moved };
}

// Звонок только друзьям — правило включается переключателем. Выпущенная
// версия приложения (1.0) о заявках ничего не знает: принять заявку ей
// негде, и при включённом правиле у всех, кто на ней, пропали бы звонки.
// Включать, когда версия с заявками выйдет в App Store.
const friendsRequired = () => process.env.FRIENDS_REQUIRED === '1';

module.exports = {
  ensureSchema, pairKey, getLink, areFriends, aliasOf, aliasFromLink, listFor,
  request, accept, remove, rename, migrateLegacyFor, migrateLegacyAll, friendsRequired,
};
