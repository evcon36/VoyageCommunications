// Communications auth — delegates to the unified accounts-api (common DB, shared JWT).
const ACCOUNTS_API = process.env.ACCOUNTS_API || 'http://127.0.0.1:3005';

async function forward(path, payload) {
  const r = await fetch(ACCOUNTS_API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

// прокси с авторизацией пользователя (метод/тело как есть)
async function forwardAuthed(req, path, method) {
  const r = await fetch(ACCOUNTS_API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: req.headers.authorization || '',
    },
    body: method === 'GET' ? undefined : JSON.stringify(req.body || {}),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function shapeUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    avatarUrl: u.avatar_url || null,
    email: u.email || null,
    telegramLinked: Boolean(u.telegram_id),
    telegramUsername: u.telegram_username || null,
    walletAddress: u.wallet_address || null,
    vocoBalance: u.voco_balance || 0,
    createdAt: u.created_at,
    // аккаунт помечен на удаление — клиент показывает экран восстановления
    deletionRequestedAt: u.deletion_requested_at || null,
    purgeAt: u.purge_at || null,
  };
}

async function register(req, res) {
  try {
    const { username, email, password } = req.body || {};
    const { status, ok, data } = await forward('/register', { username, email, password });
    if (!ok) return res.status(status).json(data);
    return res.status(201).json({
      message: 'Аккаунт успешно создан',
      token: data.token,
      user: shapeUser(data.user),
    });
  } catch (e) {
    console.error('REGISTER PROXY ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка сервера при регистрации' });
  }
}

async function login(req, res) {
  try {
    const { username, password, device_token } = req.body || {};
    const { status, ok, data } = await forward('/login', { identifier: username, password, device_token });
    if (!ok) return res.status(status).json(data);
    // Аккаунт с 2FA: accounts-api отдаёт twofa_required (200, БЕЗ user). Не зовём shapeUser —
    // прокидываем клиенту, чтобы он показал шаг ввода кода.
    if (data.twofa_required) {
      return res.status(200).json({ twofa_required: true, methods: data.methods || [], pending: data.pending });
    }
    return res.status(200).json({
      message: 'Вход выполнен успешно',
      token: data.token,
      user: shapeUser(data.user),
    });
  } catch (e) {
    console.error('LOGIN PROXY ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка сервера при входе' });
  }
}

// Отправка кода 2FA на выбранный канал (email/telegram) во время челленджа входа
async function twofaSend(req, res) {
  try {
    const { pending, channel } = req.body || {};
    const { status, data } = await forward('/2fa/challenge/send', { pending, channel });
    return res.status(status).json(data);
  } catch (e) {
    console.error('2FA SEND PROXY ERROR:', e.message);
    return res.status(500).json({ message: 'Не удалось отправить код' });
  }
}

// Проверка кода 2FA → выдаёт токен + пользователя
async function twofaVerify(req, res) {
  try {
    const { pending, method, code, remember } = req.body || {};
    const { status, ok, data } = await forward('/2fa/verify', { pending, method, code, remember });
    if (!ok) return res.status(status).json(data);
    return res.status(200).json({
      message: 'Вход выполнен успешно',
      token: data.token,
      user: shapeUser(data.user),
      device_token: data.device_token || null,
    });
  } catch (e) {
    console.error('2FA VERIFY PROXY ERROR:', e.message);
    return res.status(500).json({ message: 'Ошибка сервера при проверке кода' });
  }
}

async function me(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/me', 'GET');
    if (status !== 200) return res.status(status).json(data);
    return res.status(200).json({ user: shapeUser(data.user) });
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

async function updateProfile(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/profile', 'PATCH');
    return res.status(status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

async function uploadAvatar(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/avatar', 'POST');
    return res.status(status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

async function linkTelegram(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/link-telegram', 'POST');
    return res.status(status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

// ── Удаление аккаунта (App Store, Guideline 5.1.1(v)) ──
// Сам аккаунт живёт в accounts-api, поэтому просто пробрасываем запрос туда.
async function deleteAccount(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/account/delete', 'POST');
    return res.status(status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

async function restoreAccount(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/account/restore', 'POST');
    return res.status(status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

async function deletionPreview(req, res) {
  try {
    const { status, data } = await forwardAuthed(req, '/account/deletion-preview', 'GET');
    return res.status(status).json(data);
  } catch (e) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
}

module.exports = {
  register, login, twofaSend, twofaVerify, me, updateProfile, uploadAvatar, linkTelegram,
  deleteAccount, restoreAccount, deletionPreview,
};
