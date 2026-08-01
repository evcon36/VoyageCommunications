const { contextBridge, ipcRenderer } = require('electron');

// Мост наружу — минимальный: только то, что нужно нашим служебным страницам
// (выбор экрана и заглушка «нет связи»). Доступа к Node у страниц нет.
contextBridge.exposeInMainWorld('comsDesktop', {
  // окно выбора источника для демонстрации экрана
  getSources: () => ipcRenderer.invoke('picker:sources'),
  chooseSource: (id) => ipcRenderer.send('picker:choose', id),
  // страница-заглушка: повторить попытку подключения
  retry: () => ipcRenderer.send('app:retry'),
});
