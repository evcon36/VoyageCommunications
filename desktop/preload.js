const { contextBridge, ipcRenderer } = require('electron');

// Мост наружу — минимальный: только то, что нужно нашим служебным страницам
// (выбор экрана и заглушка «нет связи»). Доступа к Node у страниц нет.
contextBridge.exposeInMainWorld('comsDesktop', {
  // окно выбора источника для демонстрации экрана
  getSources: () => ipcRenderer.invoke('picker:sources'),
  chooseSource: (id) => ipcRenderer.send('picker:choose', id),
  // страница-заглушка: повторить попытку подключения
  retry: () => ipcRenderer.send('app:retry'),

  // Входящий звонок. Раньше он существовал только внутри окна: свёрнутое
  // приложение о звонке никак не сообщало, и человек его просто пропускал.
  // Теперь окно поднимается поверх всех, мигает в панели задач и показывает
  // системное уведомление с ответом и отклонением.
  incomingCall: (payload) => ipcRenderer.send('call:incoming', payload),
  callEnded: () => ipcRenderer.send('call:ended'),
  onCallAction: (fn) => {
    const h = (_e, action) => fn(action);
    ipcRenderer.on('call:action', h);
    return () => ipcRenderer.removeListener('call:action', h);
  },
});
