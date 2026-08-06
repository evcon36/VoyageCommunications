// Запасной адрес на случай, когда провайдер режет один из путей.
//
// У сервиса два независимых входа:
//   voyage-coms.ru                        -> через Cloudflare
//   communications.voyage-community.ru    -> напрямую в наш сервер
// Часть провайдеров блокирует диапазоны Cloudflare (симптом — вечная загрузка),
// другие душат наш прямой IP. Одного адреса, работающего у всех, не существует,
// поэтому при сетевой ошибке предлагаем пользователю второй вход.

const COMS = 'https://voyage-coms.ru/';
const DIRECT = 'https://communications.voyage-community.ru/communications/';

// Куда уводить с текущего домена
export function getAltDomainUrl() {
  const host = window.location.hostname;
  const base = host === 'voyage-coms.ru' || host === 'www.voyage-coms.ru'
    ? DIRECT
    : host === 'communications.voyage-community.ru'
      ? COMS
      : null;
  if (!base) return null; // localhost/дев — запасной путь не предлагаем

  // сохраняем ссылку на комнату (?room=...&key=...), чтобы человек попал куда шёл
  const search = window.location.search || '';
  return base + search;
}

export const ALT_DOMAIN_HINT =
  'Если страница не грузится или вход не проходит — скорее всего ваш провайдер ' +
  'блокирует этот адрес. Откройте запасной вход, это тот же COMS с теми же аккаунтами.';

// «Умная» ссылка-приглашение: ведёт не прямо в приложение, а на страницу-переходник
// (j.html), которая сама проверяет оба входа и открывает работающий. Нужно потому,
// что у получателя провайдер может резать тот адрес, с которого ссылку скопировали.
export function buildInviteLink(roomSlug, inviteKey) {
  const base = import.meta.env.VITE_BASE_PATH || '/';
  const params = new URLSearchParams({ room: String(roomSlug || '') });
  if (inviteKey) params.set('key', inviteKey);

  // В приложении на телефоне адрес страницы выглядит как capacitor://localhost
  // или https://localhost: файлы лежат внутри приложения. Такую ссылку человек
  // отправлял собеседнику, и она не открывалась ни у кого. Ссылка всегда должна
  // вести на настоящий сайт.
  const origin = window.location.origin;
  const isRealSite = /^https?:\/\//.test(origin) && !/^https?:\/\/localhost(:|$)/.test(origin);
  const site = isRealSite ? `${origin}${base}` : COMS;

  return `${site}j.html?${params.toString()}`;
}
