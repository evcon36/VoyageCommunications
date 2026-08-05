// Отложенная загрузка медиадвижка.
//
// livekit-client весит 467 КБ и приходит одним собранным файлом: разрезать его
// на части нельзя. При этом операторы связи душат подсеть нашего сервера так,
// что крупные ответы рвутся, а мелкие проходят. Пока движок ехал вместе с
// приложением, он тянул за собой весь первый экран: человек видел белую
// страницу и не понимал, сломалось или грузится.
//
// Теперь движок не нужен до входа в звонок. Первый экран приезжает без него, а
// сам движок подтягивается фоном сразу после отрисовки и точно дожидается
// перед созданием комнаты.
//
// LK — общий объект, который заполняется после загрузки. Обращаться к LK.Track
// и подобному можно только там, где комната уже существует: до звонка
// участников нет, а значит и обращаться неоткуда.

export const LK = {
  Room: null,
  RoomEvent: null,
  Track: null,
  ConnectionQuality: null,
};

let loading = null;

export function loadLiveKit() {
  // повторные вызовы получают то же обещание: параллельные входы в звонок не
  // должны скачивать движок дважды
  if (!loading) {
    loading = import('livekit-client').then((m) => {
      LK.Room = m.Room;
      LK.RoomEvent = m.RoomEvent;
      LK.Track = m.Track;
      LK.ConnectionQuality = m.ConnectionQuality;
      return LK;
    }).catch((e) => {
      // сбрасываем, чтобы следующая попытка входа скачала заново: на рваной
      // сети первая загрузка вполне может не дойти
      loading = null;
      throw e;
    });
  }
  return loading;
}

export const isLiveKitReady = () => Boolean(LK.Room);

// Подтягиваем фоном, когда браузер освободился: к моменту, когда человек
// нажмёт «войти в комнату», движок обычно уже на месте.
export function prefetchLiveKit() {
  const go = () => loadLiveKit().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 1200);
}
