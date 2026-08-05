import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Загрузчик в index.html ждёт этого признака. Если приложение не запустилось,
// он уводит человека на второй вход: у части операторов один из адресов
// недоступен, и без этого получался белый экран без единого слова.
window.__comsReady?.();

// Снимаем ранее зарегистрированный service worker и чистим его кэши.
// На части компьютеров устаревший SW мешал открытию сайта; оффлайн-кэш для
// видеозвонков не нужен. (kill-switch sw.js доснимает SW и на «белом экране».)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
}
if (typeof caches !== 'undefined') {
  caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
}

// Реальная высота видимой области на телефоне (учитывает клавиатуру).
// CSS-единица dvh реагирует только на скрытие/показ адресной строки, но НЕ
// сжимается под выезжающую клавиатуру в Safari на iOS — из-за этого низ
// полноэкранных панелей (контакты/админка/модалки) уезжал под клавиатуру.
// visualViewport.height — единственный надёжный источник актуальной высоты.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const setVv = () => {
    const root = document.documentElement.style;
    // ВАЖНО: visualViewport меняется и при пинч-зуме тоже. Если реагировать на зум,
    // панели скачут и обрезаются при масштабировании. Подстраиваемся ТОЛЬКО под
    // клавиатуру (масштаб ~1), иначе отдаём управление обычному CSS (100dvh).
    const zoomed = Math.abs((vv.scale || 1) - 1) > 0.05;
    if (zoomed) {
      root.removeProperty('--vvh');
      root.removeProperty('--vv-top');
      return;
    }
    root.setProperty('--vvh', `${vv.height}px`);
    // На iOS клавиатура НЕ сжимает layout viewport: страница уезжает вверх, а
    // position:fixed остаётся привязан к layout — панели «улетают» за экран.
    // offsetTop показывает это смещение, компенсируем его сдвигом сверху.
    root.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  setVv();
  vv.addEventListener('resize', setVv);
  vv.addEventListener('scroll', setVv);
}
