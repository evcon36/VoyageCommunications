// Voyage unified accounts service — single source of truth for all products.
// Auth methods: telegram, email+password, username(nickname)+password.
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const { registerVpnRoutes } = require('./vpn')
const { registerProfileRoutes } = require('./profile')
const twofa = require('./twofa')
const channels = require('./channels')

const app = express()
app.set('trust proxy', 1)
const ALLOWED_ORIGINS = [
  'https://voyage-community.ru', 'https://www.voyage-community.ru', 'https://app.voyage-community.ru',
  'https://communications.voyage-community.ru', 'https://travel.voyage-community.ru',
  'https://money.voyage-community.ru', 'https://os.voyage-community.ru',
  'https://tutorboard.voyage-community.ru', 'https://voyage-coms.ru', 'https://www.voyage-coms.ru',
]
// Allow no-origin (server-to-server, curl, Telegram webview) + our own domains only.
app.use(cors({ origin: (o, cb) => cb(null, !o || ALLOWED_ORIGINS.includes(o)), credentials: true }))
app.use(express.json({ limit: "1mb" }))

// ── lightweight in-memory rate limiter (per IP+route); behind nginx → X-Real-IP ──
const _rl = new Map()
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim()
    const key = req.path + '|' + ip
    const now = Date.now()
    let e = _rl.get(key)
    if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + windowMs }; _rl.set(key, e) }
    e.count++
    if (e.count > max) return res.status(429).json({ message: 'Слишком много попыток — подождите минуту' })
    next()
  }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of _rl) if (v.resetAt < now) _rl.delete(k) }, 60000).unref()

// reject Telegram payloads older than 24h (replay protection)
const MAX_AUTH_AGE = 86400
function freshAuthDate(ts) { const n = Number(ts); return n > 0 && (Date.now() / 1000 - n) <= MAX_AUTH_AGE }

const pool = new Pool({
  user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME,
  password: process.env.DB_PASS, port: Number(process.env.DB_PORT) || 5432,
})
const JWT_SECRET = process.env.JWT_SECRET
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
// Multiple product bots may authenticate against this shared account service
// (e.g. voyage_community_bot + voyage_travel_app_bot). Login is accepted if the
// payload validates against ANY configured bot token.
const BOT_TOKENS = [BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN_2, process.env.TELEGRAM_BOT_TOKEN_3].filter(Boolean)
const ENFORCE_2FA = String(process.env.ENFORCE_2FA||'').toLowerCase()==='true'

// ── validation ──
const USERNAME_RE = /^[a-zA-Zа-яА-Я0-9_]{3,20}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const okPass = p => typeof p === 'string' && p.length >= 6 && p.length <= 100

// Генерация уникального ника из локальной части почты (для аккаунтов без username)
async function generateUsername(pool, email) {
  let base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (base.length < 3) base = ('user' + base)
  base = base.slice(0, 16) || 'user'
  for (let i = 0; i < 60; i++) {
    const cand = i === 0 ? base : (base + i)
    const { rowCount } = await pool.query('SELECT 1 FROM accounts WHERE lower(username) = lower($1)', [cand])
    if (!rowCount) return cand
  }
  return (base + crypto.randomBytes(2).toString('hex')).slice(0, 20)
}

const PUBLIC_COLS = `id, display_name, username, email, telegram_id, telegram_username,
  visit_card, voco_balance, member_no, is_paid, created_at`

function sign(a) {
  return jwt.sign({ sub: String(a.id), username: a.username, telegram_id: a.telegram_id },
    JWT_SECRET, { expiresIn: '30d' })
}
// Сколько дней аккаунт можно вернуть, прежде чем данные сотрут физически.
const DELETION_GRACE_DAYS = 30

function shape(r) {
  return {
    id: r.id, display_name: r.display_name, username: r.username, email: r.email,
    telegram_id: r.telegram_id, telegram_username: r.telegram_username,
    visit_card: r.visit_card, voco_balance: r.voco_balance, member_no: r.member_no, avatar_url: r.avatar_url,
    is_paid: r.is_paid, created_at: r.created_at,
    auth_methods: [r.password_hash ? 'password' : null, r.telegram_id ? 'telegram' : null].filter(Boolean),
    // аккаунт помечен на удаление — остальные сервисы Voyage тоже должны это видеть
    deletion_requested_at: r.deletion_requested_at || null,
    purge_at: r.deletion_requested_at
      ? new Date(new Date(r.deletion_requested_at).getTime() + DELETION_GRACE_DAYS * 864e5).toISOString()
      : null,
  }
}
function visitCard(n) { return `VYG-2026-${String(n).padStart(3, '0')}` }

// assign member_no + visit_card to a freshly created row that lacks them
async function assignMembership(id) {
  const { rows } = await pool.query(
    `UPDATE accounts SET member_no = nextval('account_member_seq') WHERE id=$1 AND member_no IS NULL RETURNING member_no`, [id])
  if (rows[0]) await pool.query('UPDATE accounts SET visit_card=$1 WHERE id=$2', [visitCard(rows[0].member_no), id])
}

function auth(req, res, next) {
  const h = req.headers.authorization
  if (!h) return res.status(401).json({ message: 'Нет токена' })
  try {
    const p = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET)
    if (p.twofa_pending) return res.status(401).json({ message: 'Требуется 2FA' })
    req.acc = p; next()
  } catch { res.status(401).json({ message: 'Недействительный токен' }) }
}
const pendingSign = twofa.pendingSignFactory(JWT_SECRET)

// ── POST /register ── { email?, username?, password, display_name? }
app.post('/register', rateLimit(5, 60000), async (req, res) => {
  try {
    let { email, username, password, display_name } = req.body || {}
    if (!okPass(password)) return res.status(400).json({ message: 'Пароль: минимум 6 символов' })
    email = email ? String(email).trim().toLowerCase() : null
    username = username ? String(username).trim() : null
    if (!email && !username) return res.status(400).json({ message: 'Укажите почту или никнейм' })
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ message: 'Некорректная почта' })
    if (username && !USERNAME_RE.test(username)) return res.status(400).json({ message: 'Никнейм: 3–20 символов, буквы/цифры/_' })

    if (username) {
      const ex = await pool.query('SELECT 1 FROM accounts WHERE lower(username)=lower($1)', [username])
      if (ex.rowCount) return res.status(409).json({ message: 'Такой никнейм уже занят' })
    }
    if (email) {
      const ex = await pool.query('SELECT 1 FROM accounts WHERE lower(email)=lower($1)', [email])
      if (ex.rowCount) return res.status(409).json({ message: 'Эта почта уже зарегистрирована' })
    }
    const hash = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      `INSERT INTO accounts (display_name, username, email, password_hash, last_seen, onboarded)
       VALUES ($1,$2,$3,$4, now(), false) RETURNING *`,
      [display_name || username || email, username, email, hash])
    await assignMembership(rows[0].id)
    const acc = (await pool.query(`SELECT * FROM accounts WHERE id=$1`, [rows[0].id])).rows[0]
    res.status(201).json({ token: sign(acc), user: shape(acc) })
  } catch (e) { console.error('REGISTER', e.message); res.status(500).json({ message: 'Ошибка сервера' }) }
})

// ── POST /login ── { identifier, password }  (identifier = email or username)
app.post('/login', rateLimit(10, 60000), async (req, res) => {
  try {
    const { identifier, password, device_token } = req.body || {}
    if (!identifier || !password) return res.status(400).json({ message: 'Введите логин и пароль' })
    const { rows } = await pool.query(
      `SELECT * FROM accounts WHERE lower(username)=lower($1) OR lower(email)=lower($1) LIMIT 1`, [String(identifier).trim()])
    const acc = rows[0]
    if (!acc || !acc.password_hash) return res.status(401).json({ message: 'Неверный логин или пароль' })
    if (acc.locked_until && new Date(acc.locked_until) > new Date())
      return res.status(429).json({ message: 'Слишком много попыток — аккаунт временно заблокирован, попробуйте позже' })
    if (!(await bcrypt.compare(password, acc.password_hash))) {
      const fails = (acc.failed_logins || 0) + 1
      if (fails >= twofa.LOCK_THRESHOLD) {
        await pool.query(`UPDATE accounts SET failed_logins=0, locked_until=now()+($1||' minutes')::interval WHERE id=$2`, [String(twofa.LOCK_MINUTES), acc.id])
        twofa.logEvent(pool, acc.id, 'lockout', req)
      } else {
        await pool.query('UPDATE accounts SET failed_logins=$1 WHERE id=$2', [fails, acc.id])
      }
      twofa.logEvent(pool, acc.id, 'login_fail', req)
      return res.status(401).json({ message: 'Неверный логин или пароль' })
    }
    await pool.query('UPDATE accounts SET failed_logins=0, locked_until=NULL, last_seen=now() WHERE id=$1', [acc.id])
    // Автогенерация никнейма при первом входе для аккаунтов без ника (регистрация только по почте).
    // Без username аккаунт не находится и его нельзя позвать в COMS (там всё завязано на ник).
    if (!acc.username || acc.username.trim() === '') {
      const generated = await generateUsername(pool, acc.email)
      await pool.query('UPDATE accounts SET username=$1 WHERE id=$2', [generated, acc.id])
      acc.username = generated
      twofa.logEvent(pool, acc.id, 'username_autogen', req)
    }
    if (twofa.is2faEnabled(acc) && !(await twofa.isDeviceTrusted(pool, acc.id, device_token))) {
      twofa.logEvent(pool, acc.id, 'login_2fa_required', req)
      return res.json({ twofa_required: true, methods: twofa.enrolledMethods(acc), pending: pendingSign(acc.id) })
    }
    twofa.logEvent(pool, acc.id, 'login_ok', req)
    res.json({ token: sign(acc), user: shape(acc) })
  } catch (e) { console.error('LOGIN', e.message); res.status(500).json({ message: 'Ошибка сервера' }) }
})

// ── Telegram: verify Login Widget payload or WebApp initData ──
function checkTelegramWidget(data) {
  if (!BOT_TOKENS.length) return null
  const { hash, ...rest } = data
  const str = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n')
  for (const tok of BOT_TOKENS) {
    const secret = crypto.createHash('sha256').update(tok).digest()
    const hmac = crypto.createHmac('sha256', secret).update(str).digest('hex')
    if (hmac === hash) return freshAuthDate(rest.auth_date) ? rest : null
  }
  return null
}
function checkTelegramInitData(initData) {
  if (!BOT_TOKENS.length) return null
  const p = new URLSearchParams(initData)
  const hash = p.get('hash'); p.delete('hash')
  const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')
  for (const tok of BOT_TOKENS) {
    const secret = crypto.createHmac('sha256', 'WebAppData').update(tok).digest()
    const hmac = crypto.createHmac('sha256', secret).update(str).digest('hex')
    if (hmac === hash) { if (!freshAuthDate(p.get('auth_date'))) return null; try { return JSON.parse(p.get('user')) } catch { return null } }
  }
  return null
}

async function upsertTelegramAcc(tg) {
  const ex = await pool.query('SELECT * FROM accounts WHERE telegram_id=$1', [tg.id])
  let acc
  if (ex.rows[0]) {
    acc = (await pool.query(
      `UPDATE accounts SET last_seen=now(), display_name=COALESCE(display_name,$2),
         telegram_username=$3 WHERE telegram_id=$1 RETURNING *`,
      [tg.id, [tg.first_name, tg.last_name].filter(Boolean).join(' ') || null, tg.username || null])).rows[0]
  } else {
    acc = (await pool.query(
      `INSERT INTO accounts (display_name, telegram_id, telegram_username, last_seen, onboarded)
       VALUES ($1,$2,$3, now(), false) RETURNING *`,
      [[tg.first_name, tg.last_name].filter(Boolean).join(' ') || null, tg.id, tg.username || null])).rows[0]
    await assignMembership(acc.id)
    acc = (await pool.query('SELECT * FROM accounts WHERE id=$1', [acc.id])).rows[0]
  }
  return acc
}
async function upsertTelegram(tg, res) {
  const acc = await upsertTelegramAcc(tg)
  res.json({ token: sign(acc), user: shape(acc) })
}

// ── POST /telegram ── { initData }  OR  { id, first_name, ..., hash } (widget)
app.post('/telegram', rateLimit(20, 60000), async (req, res) => {
  try {
    if (!BOT_TOKENS.length) return res.status(503).json({ message: 'Telegram-вход временно недоступен' })
    const body = req.body || {}
    let tg = null
    if (body.initData) tg = checkTelegramInitData(body.initData)
    else if (body.hash && body.id) tg = checkTelegramWidget(body)
    if (!tg || !tg.id) return res.status(401).json({ message: 'Проверка Telegram не пройдена' })
    await upsertTelegram({ id: Number(tg.id), first_name: tg.first_name, last_name: tg.last_name, username: tg.username }, res)
  } catch (e) { console.error('TG', e.message); res.status(500).json({ message: 'Ошибка сервера' }) }
})

// ── Native-app Telegram login: deep-link + one-time nonce via @voyage_community_bot ──
// Приложение начинает вход, открывает t.me/...?start=login_<nonce>; бот дёргает
// /telegram/login/complete (по ключу TG_LOGIN_KEY); приложение опрашивает /poll.
const tgLoginPending = new Map()               // nonce -> { status, token?, user?, exp }
const TG_LOGIN_TTL = 5 * 60 * 1000
function tgLoginGC() { const now = Date.now(); for (const [k, v] of tgLoginPending) if (v.exp < now) tgLoginPending.delete(k) }

app.post('/telegram/login/start', rateLimit(30, 60000), (req, res) => {
  tgLoginGC()
  const nonce = crypto.randomBytes(16).toString('hex')
  tgLoginPending.set(nonce, { status: 'pending', exp: Date.now() + TG_LOGIN_TTL })
  res.json({ nonce, bot: 'voyage_community_bot', deep_link: `https://t.me/voyage_community_bot?start=login_${nonce}` })
})

app.post('/telegram/login/complete', async (req, res) => {
  try {
    if (!process.env.TG_LOGIN_KEY || req.get('X-Login-Key') !== process.env.TG_LOGIN_KEY)
      return res.status(401).json({ message: 'unauthorized' })
    const { nonce, telegram_id, first_name, last_name, username } = req.body || {}
    const rec = tgLoginPending.get(String(nonce || ''))
    if (!rec || rec.exp < Date.now()) return res.status(404).json({ message: 'nonce expired' })
    if (!telegram_id) return res.status(400).json({ message: 'no telegram_id' })
    const acc = await upsertTelegramAcc({ id: Number(telegram_id), first_name, last_name, username })
    rec.status = 'ready'; rec.token = sign(acc); rec.user = shape(acc)
    res.json({ ok: true })
  } catch (e) { console.error('tg-login-complete', e.message); res.status(500).json({ message: 'error' }) }
})

app.get('/telegram/login/poll', (req, res) => {
  const nonce = String(req.query.nonce || '')
  const rec = tgLoginPending.get(nonce)
  if (!rec || rec.exp < Date.now()) return res.status(404).json({ status: 'expired' })
  if (rec.status === 'ready') { tgLoginPending.delete(nonce); return res.json({ status: 'ready', token: rec.token, user: rec.user }) }
  res.json({ status: 'pending' })
})

// ── GET /me ──
app.get('/me', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE id=$1`, [req.acc.sub])
  if (!rows[0]) return res.status(404).json({ message: 'Аккаунт не найден' })
  const u = shape(rows[0])
  u.must_enroll = ENFORCE_2FA && !rows[0].twofa_enrolled
  u.must_onboard = !rows[0].onboarded
  res.json({ user: u })
})

// ── Удаление аккаунта (требование App Store, Guideline 5.1.1(v)) ──
// Удаляем не сразу: 30 дней аккаунт можно вернуть входом. По истечении срока
// cron-скрипт purge-deleted-accounts.js стирает данные физически.

// ── POST /account/delete ──
app.post('/account/delete', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM accounts WHERE id=$1`, [req.acc.sub])
    const acc = rows[0]
    if (!acc) return res.status(404).json({ message: 'Аккаунт не найден' })
    if (acc.deletion_requested_at) {
      return res.json({ ok: true, already: true, purge_at: shape(acc).purge_at })
    }
    await pool.query(`UPDATE accounts SET deletion_requested_at = now() WHERE id=$1`, [acc.id])
    // выкидываем все запомненные устройства — вход должен требовать подтверждения
    await pool.query(`DELETE FROM trusted_devices WHERE account_id=$1`, [acc.id])

    const purgeAt = new Date(Date.now() + DELETION_GRACE_DAYS * 864e5).toISOString()
    console.log('ACCOUNT DELETE requested', acc.id, acc.username, '→', purgeAt)
    res.json({ ok: true, purge_at: purgeAt, grace_days: DELETION_GRACE_DAYS })
  } catch (e) {
    console.error('ACCOUNT DELETE', e.message)
    res.status(500).json({ message: 'Не удалось запросить удаление' })
  }
})

// ── POST /account/restore ── отмена удаления в течение отсрочки
app.post('/account/restore', auth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE accounts SET deletion_requested_at = NULL WHERE id=$1 AND deletion_requested_at IS NOT NULL`,
      [req.acc.sub])
    if (!rowCount) return res.status(400).json({ message: 'Удаление не было запрошено' })
    console.log('ACCOUNT DELETE cancelled', req.acc.sub)
    res.json({ ok: true })
  } catch (e) {
    console.error('ACCOUNT RESTORE', e.message)
    res.status(500).json({ message: 'Не удалось отменить удаление' })
  }
})

// ── GET /account/deletion-preview ── что именно исчезнет (показываем перед подтверждением)
app.get('/account/deletion-preview', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT vpn_plan, vpn_expires_at FROM accounts WHERE id=$1`, [req.acc.sub])
    const acc = rows[0] || {}
    res.json({
      grace_days: DELETION_GRACE_DAYS,
      vpn_active: Boolean(acc.vpn_plan) && (!acc.vpn_expires_at || new Date(acc.vpn_expires_at) > new Date()),
      vpn_expires_at: acc.vpn_expires_at || null,
    })
  } catch (e) {
    res.status(500).json({ message: 'Ошибка' })
  }
})

app.get('/health', (_, res) => res.json({ status: 'ok', bot_token: !!BOT_TOKEN }))

registerProfileRoutes(app, pool, auth, { botToken: BOT_TOKEN, usernameRe: USERNAME_RE })

registerVpnRoutes(app, pool, auth, {
  wgUrl: process.env.WG_EASY_URL,
  wgPass: process.env.WG_EASY_PASSWORD,
  ykShop: process.env.YUKASSA_SHOP_ID,
  ykSecret: process.env.YUKASSA_SECRET_KEY,
  returnUrl: process.env.VPN_RETURN_URL,
})

twofa.registerTwofaRoutes(app, pool, auth, { sign, shape, JWT_SECRET, rateLimit })
channels.registerChannelRoutes(app, pool, auth, {
  resendKey: process.env.RESEND_API_KEY,
  resendFrom: process.env.RESEND_FROM,
  botToken: BOT_TOKEN,
  socksProxy: process.env.SOCKS_PROXY || 'socks5://5.44.47.104:1080',
  JWT_SECRET, rateLimit,
}, twofa)

const PORT = process.env.PORT || 3005
app.listen(PORT, '127.0.0.1', () => console.log('accounts-api on', PORT))
