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
      root.removeProperty('--kb');
      return;
    }
    root.setProperty('--vvh', `${vv.height}px`);
    // Высота клавиатуры отдельно: панель чата должна стоять на месте, а
    // подниматься только строка ввода. Раньше вместе с клавиатурой уезжала
    // вся панель целиком, вместе с заголовком и перепиской.
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.setProperty('--kb', `${kb}px`);
    // На iOS клавиатура НЕ сжимает layout viewport: страница уезжает вверх, а
    // position:fixed остаётся привязан к layout — панели «улетают» за экран.
    // offsetTop показывает это смещение, компенсируем его сдвигом сверху.
    root.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  // Клавиатура может быть открыта только когда есть поле в фокусе. Если
  // фокуса нет, высоту не ужимаем ни при каких обстоятельствах.
  //
  // Без этой проверки случалось так: клавиатуру закрыли, а событие об этом на
  // iOS пришло не всегда. Тогда высота оставалась посчитанной при открытой
  // клавиатуре, и панель контактов обрезалась ровно посередине экрана, а
  // снизу проступал главный экран.
  const editable = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  };
  const guarded = () => {
    if (!editable()) {
      const root = document.documentElement.style;
      root.removeProperty('--vvh');
      root.removeProperty('--vv-top');
      root.removeProperty('--kb');
      return;
    }
    setVv();
  };

  guarded();
  vv.addEventListener('resize', guarded);
  vv.addEventListener('scroll', guarded);
  // Снятие фокуса — самый надёжный признак, что клавиатура ушла: приходит
  // всегда, в отличие от изменения видимой области
  window.addEventListener('focusout', () => setTimeout(guarded, 50));
}
