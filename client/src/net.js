// Адрес сервера выбирается во время работы, а не при сборке.
//
// Почему так. У сервиса два входа: voyage-coms.ru через Cloudflare и
// communications.voyage-community.ru напрямую. Ни один не работает у всех:
// часть операторов душит подсеть нашего сервера, часть сетей плохо ходит в
// Cloudflare. Причём у одного человека компьютер может открывать один вход, а
// телефон только другой.
//
// Раньше адрес вшивался в сборку, поэтому приходилось собирать два разных
// бандла, и приложение, загрузившееся с мёртвого входа, оставалось мёртвым.
//
// Главное правило: выбор делается не один раз при запуске, а пересматривается
// при каждом сбое. Сеть меняется в течение дня, человек уходит с Wi-Fi в
// мобильный интернет, и вход, работавший утром, к вечеру может отвалиться.
// Поэтому выбор живёт до конца вкладки, а не неделю.

const BUILT_IN = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

// Порядок важен: первым идёт тот, с которого приложение загрузилось, он уже
// доказал свою работоспособность самим фактом загрузки.
const CANDIDATES = (() => {
  const list = [];
  const push = (u) => { if (u && !list.includes(u)) list.push(u); };

  push(BUILT_IN);
  // На боевых доменах знаем оба входа. На localhost и в приложении Capacitor
  // подмена не нужна: там адрес один.
  if (/voyage-coms\.ru|voyage-community\.ru/.test(BUILT_IN)) {
    push('https://voyage-coms.ru');
    push('https://communications.voyage-community.ru');
  }
  return list;
})();

const STORE_KEY = 'coms.origin';

function remembered() {
  try {
    const v = sessionStorage.getItem(STORE_KEY);
    return v && CANDIDATES.includes(v) ? v : null;
  } catch { return null; }
}

let current = remembered() || CANDIDATES[0];
const listeners = new Set();

export const serverUrl = () => current;
export const originCandidates = () => CANDIDATES.slice();

// Сокет и медиасервер тоже ходят по адресу и должны узнать о смене
export function onOriginChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function useOrigin(origin) {
  if (origin === current) return;
  current = origin;
  try { sessionStorage.setItem(STORE_KEY, origin); } catch { /* приватный режим */ }
  for (const fn of listeners) { try { fn(origin); } catch { /* слушатель не должен ломать переключение */ } }
}

// Отличаем «сеть не дошла» от «сервер ответил ошибкой». Переключаться имеет
// смысл только в первом случае: ответ 500 с другого входа будет таким же.
function isNetworkFailure(e) {
  return e instanceof TypeError || e?.name === 'AbortError' || e?.name === 'TimeoutError';
}

const TIMEOUT_MS = 12000;

async function tryOnce(origin, path, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${origin}${path}`, { ...init, signal: init?.signal || ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Запрос к серверу. При сетевом сбое пробует остальные входы и запоминает
// сработавший, чтобы следующие запросы шли сразу туда.
export async function apiFetch(path, init) {
  const order = [current, ...CANDIDATES.filter(o => o !== current)];
  let lastError = null;

  for (const origin of order) {
    try {
      const resp = await tryOnce(origin, path, init);
      if (origin !== current) useOrigin(origin);
      return resp;
    } catch (e) {
      lastError = e;
      if (!isNetworkFailure(e)) throw e;   // ошибка не сетевая, другой вход не поможет
      if (init?.body instanceof FormData) throw e; // тело уже прочитано, повтор не выйдет
    }
  }
  throw lastError || new Error('Сервер недоступен');
}

// Адрес файла (аватарки, записи): без запроса, просто подставляем текущий вход
export function mediaOrigin() { return current; }
