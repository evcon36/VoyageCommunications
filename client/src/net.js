// Адрес сервера выбирается во время работы, а не при сборке.
//
// Почему так. У сервиса несколько входов, и ни один не работает у всех.
// Основной: voyage-community.ru/communications/ (единственный, что доходит на
// мобильном интернете в России). Запасные: voyage-coms.ru через Cloudflare и
// communications.voyage-community.ru напрямую, они живы на домашнем интернете
// и выручают там, где плохо ходит наш прямой адрес.
//
// Раньше адрес вшивался в сборку, поэтому приходилось собирать два разных
// бандла, и приложение, загрузившееся с мёртвого входа, оставалось мёртвым.
//
// Главное правило: выбор делается не один раз при запуске, а пересматривается
// при каждом сбое. Сеть меняется в течение дня, человек уходит с Wi-Fi в
// мобильный интернет, и вход, работавший утром, к вечеру может отвалиться.
// Поэтому выбор живёт до конца вкладки, а не неделю.

const BUILT_IN = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

// Голый voyage-community.ru: единственное имя, которое доходит на мобильном
// интернете в России. Оператор читает имя хоста из открытой части TLS-приветствия
// и рвёт соединение по списку, а все поддомены сервиса в этот список попали.
// Путь после слэша оператору не виден, поэтому /communications/ на апексе
// открывается так же надёжно, как сам апекс.
const APEX = 'https://voyage-community.ru';

// Порядок важен: с первого адреса начинается любой запрос, пока гонка входов
// не выберет другой.
const CANDIDATES = (() => {
  const list = [];
  const push = (u) => { if (u && !list.includes(u)) list.push(u); };

  const isProd = /voyage-coms\.ru|voyage-community\.ru/.test(BUILT_IN);

  // Апекс первым даже тогда, когда сборка вшита на поддомен. Это важно для
  // приложения на телефоне: его собирают один раз и надолго, а адрес, который
  // откроется у человека, зависит от его оператора, а не от нашей сборки.
  if (isProd) push(APEX);
  push(BUILT_IN);
  if (isProd) {
    // Запасные входы. На мобильном интернете они сейчас закрыты, но на домашнем
    // работают и выручат, если апекс окажется недоступен.
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
// Первая попытка ждёт недолго: если вход недоступен, десять секунд тишины на
// запуске человек воспринимает как «приложение сломалось».
const FIRST_TRY_MS = 3500;

// Гонка входов на старте. Раньше входы перебирались по очереди, и когда
// первый молчал, запуск упирался в полный таймаут. Пробуем все сразу дешёвым
// запросом и запоминаем ответивший: дальше всё идёт прямо туда.
let probing = null;
export function pickOrigin() {
  if (CANDIDATES.length < 2) return Promise.resolve(current);
  if (probing) return probing;

  // Сохранённый выбор раньше принимался на веру и гонка пропускалась. Из-за
  // этого приложение намертво залипало: вход запоминался в момент, когда VPN
  // был включён, а после выключения ходило туда же и молчало. Гонка стоит
  // меньше полусекунды, поэтому проверяем всегда — сохранённый вход просто
  // побеждает в ней первым, если он и правда работает.

  probing = new Promise((resolve) => {
    let done = false;
    const finish = (origin) => {
      if (done) return;
      done = true;
      if (origin) useOrigin(origin);
      resolve(current);
    };
    let left = CANDIDATES.length;
    for (const origin of CANDIDATES) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FIRST_TRY_MS);
      // Запрос заведомо безобидный: спрашиваем о несуществующей комнате,
      // ничего не создаём и не меняем
      // Проверять надо не «пришёл ли ответ», а «ответил ли наш сервер».
      // Заблокированный вход отдаёт свою страницу-заглушку, и это тоже
      // успешный ответ: он выигрывал гонку, после чего всё приложение
      // ходило в никуда.
      fetch(`${origin}/rooms/guest-info/__probe__`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('чужой ответ'))))
        .then((d) => (d && typeof d === 'object' && 'exists' in d
          ? finish(origin)
          : Promise.reject(new Error('ответ не от нашего сервера'))))
        .catch(() => { if (--left === 0) finish(null); })
        .finally(() => clearTimeout(timer));
    }
    // страховка: даже если молчат все, приложение должно поехать дальше
    setTimeout(() => finish(null), FIRST_TRY_MS + 300);
  }).finally(() => { probing = null; });

  return probing;
}

// Ошибка с именем AbortError: верхний слой считает такую сетевой и пробует
// следующий вход, а не показывает человеку «ошибка сервера».
function timedOut() {
  const e = new Error('Истекло время ожидания');
  e.name = 'AbortError';
  return e;
}

async function tryOnce(origin, path, init, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // В приложении на телефоне запросы идут через системную сеть, а не через
  // страницу, и остановка по AbortController там срабатывает не всегда. Без
  // второго ограничения запрос висел бы бесконечно, и человек смотрел бы на
  // крутящийся кружок вместо понятной ошибки.
  let hardTimer;
  const hardLimit = new Promise((_, reject) => {
    hardTimer = setTimeout(() => reject(timedOut()), timeoutMs + 500);
  });
  try {
    return await Promise.race([
      fetch(`${origin}${path}`, { ...init, signal: init?.signal || ctrl.signal }),
      hardLimit,
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
  }
}

// Запрос к серверу. При сетевом сбое пробует остальные входы и запоминает
// сработавший, чтобы следующие запросы шли сразу туда.
// Некоторые запросы нельзя повторять вслепую: они меняют состояние. Запуск
// записи, например, идёт около пяти секунд, потому что сервер убеждается, что
// она реально пошла. Слой переключения обрывал попытку раньше и повторял её на
// другом входе, а запись к этому моменту уже работала: получалась вторая
// поверх первой, и человек видел ошибку при работающей записи.
//
// timeout: сколько ждать ответа. retry: можно ли повторять на другом входе.
export async function apiFetch(path, init, opts = {}) {
  const order = [current, ...CANDIDATES.filter(o => o !== current)];
  const allowRetry = opts.retry !== false;
  const wait = opts.timeout || null;
  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    const origin = order[i];
    // Пока есть куда переключиться, ждём недолго: смысл запасного входа в
    // том, чтобы не сидеть в тишине полный таймаут. На последнем даём
    // полный срок, там торопиться уже некуда.
    const isLast = i === order.length - 1 || !allowRetry;
    try {
      const resp = await tryOnce(origin, path, init, wait || (isLast ? TIMEOUT_MS : FIRST_TRY_MS));
      // Заглушки блокировщиков и сбои посредника приходят кодами 5xx. Это не
      // ответ нашего сервера, поэтому пробуем следующий вход, а не показываем
      // человеку ошибку.
      if (!isLast && resp.status >= 502 && resp.status <= 599) {
        lastError = new Error(`вход ответил ${resp.status}`);
        continue;
      }
      if (origin !== current) useOrigin(origin);
      return resp;
    } catch (e) {
      lastError = e;
      if (!allowRetry) throw e;            // повторять этот запрос нельзя
      if (!isNetworkFailure(e)) throw e;   // ошибка не сетевая, другой вход не поможет
      if (init?.body instanceof FormData) throw e; // тело уже прочитано, повтор не выйдет
    }
  }
  throw lastError || new Error('Сервер недоступен');
}

// Адрес файла (аватарки, записи): без запроса, просто подставляем текущий вход
export function mediaOrigin() { return current; }
