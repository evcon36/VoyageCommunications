import { apiFetch as request } from '../net';

// Раньше здесь был свой запросчик с адресом, вшитым при сборке. Из-за этого
// вход и проверка авторизации ходили мимо общего слоя и знали только один
// адрес: если он у оператора недоступен, приложение навсегда зависало на
// «Проверяем авторизацию», и переключение на второй вход не срабатывало,
// потому что до него дело не доходило.
async function apiFetch(path, options = {}) {
  let response;
  try {
    response = await request(path, options);
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new Error('Сервер не отвечает — проверьте интернет и попробуйте ещё раз');
    }
    throw new Error('Нет соединения с сервером — проверьте интернет');
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

// VoIP push-токен (CallKit/PushKit на iOS) — чтобы сервер мог разбудить
// закрытое приложение на входящий звонок
export async function registerVoipToken(token, deviceToken) {
  return apiFetch('/auth/voip-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ token: deviceToken, platform: 'ios' }),
  });
}
