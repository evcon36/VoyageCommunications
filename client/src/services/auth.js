const API_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

// fetch с таймаутом: на нестабильном мобильном интернете запрос может
// молча зависнуть навсегда — лучше ошибка через 15 секунд и повтор
async function apiFetch(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Сервер не отвечает — проверьте интернет и попробуйте ещё раз');
    }
    throw new Error('Нет соединения с сервером — проверьте интернет');
  } finally {
    clearTimeout(timer);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(result.message || 'Ошибка сервера');
    err.status = response.status; // чтобы отличать 401 от сетевых сбоев
    throw err;
  }
  return result;
}

export async function registerUser(data) {
  return apiFetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function loginUser(data) {
  return apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getMe(token) {
  return apiFetch('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// 2FA: отправить код на выбранный канал (email/telegram) во время входа
export async function send2faCode(data) {
  return apiFetch('/auth/2fa/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// 2FA: проверить код → вернёт token + user
export async function verify2fa(data) {
  return apiFetch('/auth/2fa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
