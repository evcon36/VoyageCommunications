// Запасной адрес на случай, когда провайдер режет один из входов.
//
// Основной адрес сервиса один: https://voyage-community.ru/communications/
// Голое имя voyage-community.ru доходит на мобильном интернете в России, а все
// поддомены (voyage-coms.ru, communications.voyage-community.ru) там закрыты:
// оператор читает имя хоста из открытой части TLS-приветствия и обрывает
// соединение. Путь после слэша ему не виден, поэтому /communications/ работает.
//
// Поддомены оставлены как запасной путь: на домашнем интернете они живы, а у
// части зарубежных провайдеров наш прямой адрес наоборот ходит хуже, чем
// Cloudflare перед voyage-coms.ru.

const APEX = 'https://voyage-community.ru/communications/';
const COMS = 'https://voyage-coms.ru/';
const DIRECT = 'https://communications.voyage-community.ru/communications/';

// Куда уводить с текущего адреса
export function getAltDomainUrl() {
  const host = window.location.hostname;

  // С заблокированных поддоменов всегда уводим на апекс: это единственный
  // адрес, который открывается у всех операторов
  const base = (host === 'voyage-coms.ru' || host === 'www.voyage-coms.ru'
             || host === 'communications.voyage-community.ru') ? APEX
             // с апекса запасным остаётся Cloudflare: он выручает там, где
             // плохо ходит наш прямой адрес
             : (host === 'voyage-community.ru' || host === 'www.voyage-community.ru') ? COMS
             : null;
  if (!base) return null; // localhost/дев: запасной путь не предлагаем

  // сохраняем ссылку на комнату (?room=...&key=...), чтобы человек попал куда шёл
  const search = window.location.search || '';
  return base + search;
}

export const ALT_DOMAIN_HINT =
  'Если страница не грузится или вход не проходит — скорее всего ваш провайдер ' +
  'блокирует этот адрес. Откройте запасной вход, это тот же COMS с теми же аккаунтами.';

// «Умная» ссылка-приглашение: ведёт не прямо в приложение, а на страницу-переходник
// (j.html), которая сама проверяет входы и открывает работающий. Нужно потому,
// что у получателя провайдер может резать тот адрес, с которого ссылку скопировали.
export function buildInviteLink(roomSlug, inviteKey) {
  const base = import.meta.env.VITE_BASE_PATH || '/';
  const params = new URLSearchParams({ room: String(roomSlug || '') });
  if (inviteKey) params.set('key', inviteKey);

  // В приложении на телефоне адрес страницы выглядит как capacitor://localhost
  // или https://localhost: файлы лежат внутри приложения. Такую ссылку человек
  // отправлял собеседнику, и она не открывалась ни у кого. Ссылка всегда должна
  // вести на настоящий сайт, причём на апекс: приглашение чаще всего открывают
  // с телефона, где поддомены не работают.
  const origin = window.location.origin;
  const isRealSite = /^https?:\/\//.test(origin) && !/^https?:\/\/localhost(:|$)/.test(origin);
  const site = isRealSite ? `${origin}${base}` : APEX;

  return `${site}j.html?${params.toString()}`;
}
