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

  // Запасные входы нужны и в приложении.
  //
  // В сборке 109 их убрали: запасной стоит за Cloudflare, а тот отдаёт
  // `alt-svc: h3=":443"` и просит ходить по HTTP/3 (UDP), который мобильные
  // операторы режут — отсюда семисекундные задержки в логах. Но логи 10.09
  // показали обратную картину: на мобильном интернете владельца **молчал
  // апекс**, а Cloudflare отвечал. В такие минуты до сервера не доходило
  // ничего с телефона — ни из веб-слоя, ни из нативного, — а запросы через
  // Cloudflare приходили. Приложение без запасного входа в этот момент
  // оставалось вообще ни с чем.
  //
  // Семь секунд ожидания хуже мгновенного ответа, но несравнимо лучше, чем
  // «нет связи с сервером». Перебор входов при чтении идёт параллельно и
  // полное время ждёт (см. apiFetch), а как только апекс оживает, приложение
  // возвращается на него само (см. scheduleComeback).
  if (isProd) {
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
  scheduleComeback();
}

// Возвращение на главный вход.
//
// Запасной вход выбирался на один сетевой сбой, а жил до полного перезапуска
// приложения. На мобильном интернете это оказалось хуже самого сбоя: запасной
// вход через Cloudflare у оператора не заблокирован, он отвечает — но по
// восемь секунд на запрос. Приложение переезжало туда из-за одной осечки и
// выглядело мёртвым, хотя формально работало. Человек видел «первый раз
// открывается, а потом только через VPN»: пока приложение не закрыто и не
// открыто заново, выбор входа никто не пересматривал.
//
// Поэтому, уйдя с главного входа, регулярно проверяем, не ожил ли он.
const COMEBACK_MS = 30000;
let comebackTimer = null;
function scheduleComeback() {
  if (comebackTimer || current === CANDIDATES[0]) return;
  comebackTimer = setInterval(() => {
    if (current === CANDIDATES[0]) {
      clearInterval(comebackTimer);
      comebackTimer = null;
      return;
    }
    pickOrigin();
  }, COMEBACK_MS);
}

// Отличаем «сеть не дошла» от «сервер ответил ошибкой». Переключаться имеет
// смысл только в первом случае: ответ 500 с другого входа будет таким же.
function isNetworkFailure(e) {
  return e instanceof TypeError || e?.name === 'AbortError' || e?.name === 'TimeoutError'
    // Так выглядит отказ «сети нет» из веб-слоя: обычный Error с этим текстом
    || /Load failed|Network(Error| request failed)|The Internet connection/i.test(String(e?.message || ''));
}

// Сроки рассчитаны на сеть, где соединение устанавливается не сразу.
//
// На мобильном интернете первый пакет соединения теряется, и телефон шлёт
// его заново: 3 секунды, потом 9, потом 21. На сервере это видно как миллион
// с лишним повторных отправок. Самопроверка с телефона владельца показала
// установку соединения за 3228 мс там, где на Wi-Fi уходит 300.
//
// Прежние сроки (3,5 и 12 секунд) резали именно такие соединения: вход был
// жив и отвечал, а приложение уже писало «нет связи с сервером». Safari на
// том же телефоне открывал сайт всегда — просто потому, что ждёт до минуты.
//
// Быстрая сеть от этого не пострадала: если вход отвечает за 300 мс, всё
// работает ровно как раньше. Изменился только потолок терпения.
const TIMEOUT_MS = 30000;
const FIRST_TRY_MS = 8000;

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

  probing = (async () => {
    // Сначала спрашиваем только главный вход, и только если он молчит —
    // остальные.
    //
    // Раньше проверялись все три разом. На хорошей сети это дёшево, а на
    // слабом мобильном канале лавина одновременных соединений топит саму
    // себя: в дневнике владельца главный вход отвечал за 215 мс, и в ту же
    // секунду всё остальное уходило в таймауты по 38 и 60 секунд.
    const first = await probeOne(CANDIDATES[0]);
    if (first) { useOrigin(CANDIDATES[0]); return current; }
    return raceRest();
  })().finally(() => { probing = null; });

  return probing;
}

// Одна проверка живости входа. Отвечает true, только если ответил наш сервер:
// заглушка блокировщика тоже отдаёт успешный ответ, и без этой проверки она
// выигрывала бы гонку, после чего приложение ходило бы в никуда.
async function probeOne(origin) {
  try {
    // Проверке входа хватает двух попыток: она идёт рядом с работой
    // приложения и не должна занимать соединение надолго.
    const r = await tryOnce(origin, `/rooms/guest-info/__probe__?t=${Date.now()}`,
                            { cache: 'no-store' }, 3000);
    if (!r.ok) return false;
    const d = await r.json();
    return Boolean(d && typeof d === 'object' && 'exists' in d);
  } catch { return false; }
}

// Главный вход молчит — перебираем запасные ПО ОЧЕРЕДИ, а не разом.
//
// Одновременная проверка нескольких входов на слабом мобильном канале топит
// сама себя: соединения открываются пачкой и все уходят в таймаут. По очереди
// медленнее в худшем случае, зато не создаёт лавины.
async function raceRest() {
  for (const origin of CANDIDATES.slice(1)) {
    if (await probeOne(origin)) { useOrigin(origin); return current; }
  }
  return current;   // молчат все — остаёмся там, где были
}

// Ошибка с именем AbortError: верхний слой считает такую сетевой и пробует
// следующий вход, а не показывает человеку «ошибка сервера».
function timedOut() {
  const e = new Error('Истекло время ожидания');
  e.name = 'AbortError';
  return e;
}

// Запрос системной сетью телефона вместо сетевого движка веб-слоя.
//
// На телефоне владельца движок WebView до сервера не доставал, а системная
// сеть в ту же секунду отвечала за 288 мс — это видно в дневнике: нативная
// самопроверка входа проходит, запрос веб-слоя не доходит вовсе. Штатный
// CapacitorHttp, который должен подменять fetch, в Capacitor 8.5 этого не
// делает (проверено сборкой с включённой настройкой), поэтому зовём наш
// нативный слой напрямую.
//
// Отправку файлов оставляем веб-слою: тело FormData через мост не передать.
const IS_NATIVE_APP = Boolean(globalThis.Capacitor?.isNativePlatform?.());
let nativeHttp = null;
if (IS_NATIVE_APP) {
  try {
    nativeHttp = globalThis.Capacitor?.registerPlugin?.('Voip') || null;
  } catch { nativeHttp = null; }
}

function canGoNative(init) {
  return Boolean(nativeHttp?.request)
    && !(init?.body instanceof FormData)
    && !(init?.body instanceof Blob);
}

// Ответ нативного слоя приводим к виду, который ждёт остальной код
function asResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body || '{}'),
    text: async () => body || '',
  };
}

async function tryOnce(origin, path, init, timeoutMs = TIMEOUT_MS) {
  if (canGoNative(init)) {
    try {
      // Срок на ОДНУ попытку короткий, а попыток много: нативный слой сам
      // бросает зависшее соединение и открывает новое. Смысл в этом, а не в
      // терпении — рукопожатие на мобильном интернете либо проходит сразу,
      // либо не пройдёт вовсе.
      const r = await nativeHttp.request({
        url: `${origin}${path}`,
        method: String(init?.method || 'GET').toUpperCase(),
        headers: init?.headers || {},
        body: typeof init?.body === 'string' ? init.body : undefined,
        // Попытка короткая, попыток много. На мобильном интернете рукопожатие
        // срывается через раз: обречённое соединение ждать незачем, дешевле
        // бросить и открыть новое. Две секунды — столько занимает удачное
        // рукопожатие с запасом.
        timeout: 2,
        attempts: Math.max(4, Math.min(20, Math.round(timeoutMs / 1500))),
      });
      return asResponse(r?.status ?? 0, r?.body ?? '');
    } catch (e) {
      // Нативный слой отказал — ошибку выдаём как сетевую, чтобы верхний
      // слой попробовал другой вход, а не показал «ошибка сервера»
      const err = new Error(String(e?.message || e));
      err.name = 'TimeoutError';
      throw err;
    }
  }
  return webFetch(origin, path, init, timeoutMs);
}

async function webFetch(origin, path, init, timeoutMs = TIMEOUT_MS) {
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
      // no-store, потому что ответы API кэшировать незачем, а вред от этого
      // был прямой: закэшированный ответ телефон переспрашивал условным
      // запросом и получал 304 — законный ответ без тела, который обёртка
      // запросов считает отказом сервера. Приложение писало «нет связи с
      // сервером» при живом сервере, ровно со второго холодного запуска.
      fetch(`${origin}${path}`, { cache: 'no-store', ...init, signal: init?.signal || ctrl.signal }),
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
// 304 «не изменилось» приходит без тела, и работать с ним верхний слой не
// умеет: он ждёт JSON. Считаем такой ответ негодным и пробуем другой вход —
// как и заглушку блокировщика (5xx). Запросы идут с no-store, поэтому 304
// прийти не должен вовсе, но проверка стоит одну строку.
const unusable = (resp) => resp.status === 304 || (resp.status >= 502 && resp.status <= 599);

// Все входы сразу, побеждает первый ответивший. Только для чтения: один и
// тот же GET можно отправить хоть всем сразу, запись — нельзя.
function raceOrigins(origins, path, init, wait) {
  return new Promise((resolve, reject) => {
    let left = origins.length;
    let done = false;
    let lastError = null;
    for (const origin of origins) {
      tryOnce(origin, path, init, wait || TIMEOUT_MS)
        .then((resp) => {
          // Не ответ нашего сервера — пусть выигрывает кто-то другой
          if (unusable(resp)) throw new Error(`вход ответил ${resp.status}`);
          if (done) return;
          done = true;
          if (origin !== current) useOrigin(origin);
          resolve(resp);
        })
        .catch((e) => {
          lastError = e;
          if (--left === 0 && !done) reject(lastError || new Error('Сервер недоступен'));
        });
    }
  });
}

export async function apiFetch(path, init, opts = {}) {
  const order = [current, ...CANDIDATES.filter(o => o !== current)];
  const allowRetry = opts.retry !== false;
  const wait = opts.timeout || null;
  let lastError = null;

  // Короткое ожидание уместно только для чтения. Оно придумано, чтобы мёртвый
  // вход не задерживал запуск, а на запуске идут одни лишь запросы чтения.
  //
  // Для остальных это оказалось ловушкой. Вход в аккаунт с телефона уходил,
  // сервер отвечал за десятые доли секунды и писал в журнал успех, а
  // приложение к этому моменту уже бросало попытку и уходило на запасные
  // входы, которые у оператора закрыты. Человек видел «сервер не отвечает»
  // при работающем сервере. Отменить сам запрос при этом не выходит: в
  // приложении он идёт через системную сеть, и отмена там не срабатывает.
  const isRead = String(init?.method || 'GET').toUpperCase() === 'GET';

  // Чтение: короткая попытка по текущему входу, а если он молчит — остальные
  // все сразу, каждому полное время.
  //
  // Перебор по очереди подводил ровно там, где важнее всего. На мобильном
  // интернете запасной вход отвечает за семь секунд; в короткий лимит
  // очередной попытки он не укладывался, приложение объявляло «нет связи с
  // сервером» — и это при живом входе. По логам видно: запрос доходил до
  // сервера уже после того, как приложение сдалось.
  if (isRead && allowRetry && order.length > 1) {
    // Мгновенный отказ всех входов сразу — это не «сервер недоступен», а
    // «система считает, что сети нет».
    //
    // При холодном запуске радиомодуль телефона спит, и iOS отвечает
    // приложению «интернет отсутствует» (-1009), не выходя в сеть вовсе. В
    // дневнике с телефона владельца это выглядело так: все три входа падают
    // за две секунды с одной и той же ошибкой. Приложение верило первому
    // ответу и показывало «нет связи с сервером», хотя связь была — Safari,
    // открытый минутой позже, сайт открывал.
    //
    // Поэтому такой отказ считаем преждевременным и пробуем ещё, дав модулю
    // время проснуться. Настоящая недоступность переживёт эти попытки и
    // отвалится честно, просто на несколько секунд позже.
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      try {
        try {
          const resp = await tryOnce(current, path, init, wait || FIRST_TRY_MS);
          if (!unusable(resp)) return resp;
        } catch (e) {
          if (!isNetworkFailure(e)) throw e;   // не сетевая — другой вход не поможет
        }
        return await raceOrigins(order, path, init, wait);
      } catch (e) {
        const instant = Date.now() - startedAt < 4000;
        if (attempt >= 3 || !instant || !isNetworkFailure(e)) throw e;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }

  for (let i = 0; i < order.length; i++) {
    const origin = order[i];
    const isLast = i === order.length - 1 || !allowRetry;
    const quick = isRead && !isLast;
    try {
      const resp = await tryOnce(origin, path, init, wait || (quick ? FIRST_TRY_MS : TIMEOUT_MS));
      // Заглушки блокировщиков и сбои посредника приходят кодами 5xx. Это не
      // ответ нашего сервера, поэтому пробуем следующий вход, а не показываем
      // человеку ошибку.
      if (!isLast && unusable(resp)) {
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
