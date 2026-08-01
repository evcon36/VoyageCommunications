// KILL-SWITCH service worker.
// Прежний SW (base=/communications/) на voyage-coms.ru был бесполезен, а на части
// компьютеров устаревший/битый SW мешал открытию сайта вовсе. Оффлайн-кэш для
// видеозвонков не нужен, поэтому SW полностью снимается: чистим все кэши,
// разрегистрируемся и перезагружаем управляемые вкладки — дальше сайт работает без SW.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* ignore */ }
    try { await self.registration.unregister(); } catch (e) { /* ignore */ }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    } catch (e) { /* ignore */ }
  })());
});

// на всякий случай ничего не перехватываем — все запросы идут напрямую в сеть
self.addEventListener('fetch', () => {});
