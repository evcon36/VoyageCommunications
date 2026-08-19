const {
  app, BrowserWindow, session, desktopCapturer, shell,
  Tray, Menu, ipcMain, nativeImage, dialog, Notification,
} = require('electron');
const path = require('path');
const net = require('net');
const { URL } = require('url');
const { autoUpdater } = require('electron-updater');

// ── Два независимых входа в сервис ──────────────────────────────────────────
// Часть провайдеров режет диапазоны Cloudflare, часть — наш прямой IP.
// Десктоп-приложение проверяет оба и открывает работающий: в браузере это
// решалось страницей-переходником, здесь делаем нативно и надёжнее.
const ENDPOINTS = [
  {
    name: 'основной',
    url: 'https://voyage-coms.ru/',
    host: 'voyage-coms.ru',
    updateUrl: 'https://voyage-coms.ru/downloads/',
  },
  {
    name: 'запасной',
    url: 'https://communications.voyage-community.ru/communications/',
    host: 'communications.voyage-community.ru',
    updateUrl: 'https://communications.voyage-community.ru/downloads/',
  },
];
const PROBE_TIMEOUT = 4000;
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000; // раз в 6 часов

let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateReady = false;

// Проверка доступности: TCP-соединение на 443. Быстрее и честнее, чем HTTP —
// при блокировке DPI соединение либо не устанавливается, либо рвётся.
function probe(host, timeout = PROBE_TIMEOUT) {
  // Тестовая имитация блокировки провайдером: COMS_TEST_BLOCK=host1,host2
  if ((process.env.COMS_TEST_BLOCK || '').split(',').filter(Boolean).includes(host)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(443, host);
  });
}

async function pickEndpoint() {
  for (const ep of ENDPOINTS) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe(ep.host)) return ep;
  }
  return null;
}

// ── Права на камеру/микрофон/экран ──────────────────────────────────────────
// Разрешаем автоматически, но только для наших доменов: пользователь уже
// согласился, запуская приложение для звонков, лишний системный диалог не нужен.
function isOurOrigin(url) {
  try {
    const h = new URL(url).hostname;
    return ENDPOINTS.some((e) => h === e.host) || h === 'voyage-community.ru' || h === 'www.voyage-coms.ru';
  } catch {
    return false;
  }
}

function setupPermissions(ses) {
  const allowed = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture', 'clipboard-read', 'notifications', 'fullscreen']);

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowed.has(permission) && isOurOrigin(webContents.getURL()));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (!allowed.has(permission)) return false;
    return isOurOrigin(requestingOrigin || (webContents && webContents.getURL()) || '');
  });

  // Демонстрация экрана: показываем свой выбор окна/экрана.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: true,
      });
      const chosen = await showPicker(sources);
      if (!chosen) {
        // отмена: пустой ответ, страница получит NotAllowedError
        callback({});
        return;
      }
      const source = sources.find((s) => s.id === chosen);
      // audio: 'loopback' — системный звук вместе с экраном (Windows)
      callback({ video: source, audio: 'loopback' });
    } catch (e) {
      console.error('display media error:', e.message);
      callback({});
    }
  }, { useSystemPicker: false });
}

// ── Окно выбора экрана/окна для демонстрации ────────────────────────────────
function showPicker(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 780,
      height: 560,
      parent: mainWindow || undefined,
      modal: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Выберите, чем поделиться',
      backgroundColor: '#0e1013',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      isScreen: s.id.startsWith('screen:'),
    }));

    let settled = false;
    const done = (id) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      if (!picker.isDestroyed()) picker.close();
      resolve(id);
    };

    ipcMain.handle('picker:sources', () => payload);
    ipcMain.once('picker:choose', (_e, id) => done(id));
    picker.once('closed', () => done(null));

    picker.loadFile(path.join(__dirname, 'picker.html'));
    picker.once('ready-to-show', () => picker.show());
  });
}

// ── Автообновление ──────────────────────────────────────────────────────────
// Обновления раздаём со своего сервера. Адрес выбираем тем же перебором, что и
// сам сервис: если провайдер режет один домен, обновления пойдут со второго.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Идёт ли сейчас звонок: во время разговора не мешаем диалогами.
async function isInCall() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    return await mainWindow.webContents.executeJavaScript(
      "!!document.querySelector('.call-fullscreen')",
    );
  } catch {
    return false;
  }
}

async function promptInstall() {
  if (!updateReady || !mainWindow || mainWindow.isDestroyed()) return;
  // во время звонка откладываем и пробуем позже
  if (await isInCall()) {
    setTimeout(promptInstall, 60 * 1000);
    return;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Перезапустить сейчас', 'Позже'],
    defaultId: 0,
    cancelId: 1,
    title: 'Обновление COMS',
    message: 'Готово новое обновление',
    detail: 'Приложение перезапустится и обновится. Если отложить — обновление установится при следующем выходе.',
  });
  if (response === 0) {
    isQuitting = true;
    autoUpdater.quitAndInstall();
  }
}

async function initUpdates(endpoint) {
  if (!app.isPackaged) return; // в режиме разработки обновляться нечему
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: endpoint.updateUrl, channel: 'latest' });
  } catch (e) {
    console.error('update feed error:', e.message);
    return;
  }

  // Проверка механизма обновлений: COMS_SELFTEST_UPDATE=1 <путь>/COMS.exe
  if (process.env.COMS_SELFTEST_UPDATE === '1') {
    autoUpdater.autoDownload = false; // только проверяем, не качаем 78 МБ
    console.log('UPDTEST feed:', endpoint.updateUrl);
    console.log('UPDTEST current version:', app.getVersion());
    try {
      const r = await autoUpdater.checkForUpdates();
      const remote = r && r.updateInfo ? r.updateInfo.version : null;
      console.log('UPDTEST server version:', remote);
      console.log('UPDTEST update available:', remote && remote !== app.getVersion() ? 'ДА' : 'нет');
    } catch (e) {
      console.log('UPDTEST ERROR:', e.message);
    }
    isQuitting = true;
    app.quit();
    return;
  }

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    console.log('update downloaded:', info.version);
    if (tray) tray.setToolTip(`COMS — доступно обновление ${info.version}`);
    promptInstall();
  });
  autoUpdater.on('error', (e) => console.error('updater:', e.message));

  const check = () => autoUpdater.checkForUpdates().catch((e) => console.error('update check:', e.message));
  check();
  setInterval(check, UPDATE_INTERVAL);
}

// ── Главное окно ────────────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0e1013',
    title: 'COMS',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // нужен служебным страницам (заглушка «нет связи»); наружу отдаёт
      // только три безобидных метода, доступа к Node у страниц нет
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // общий раздел сессии: cookie и localStorage переживают перезапуск,
      // поэтому «запомнить устройство» и вход не сбрасываются
      partition: 'persist:coms',
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const ep = await pickEndpoint();
  if (!ep) {
    await mainWindow.loadFile(path.join(__dirname, 'loading.html'), {
      query: { error: '1' },
    });
    return;
  }
  await mainWindow.loadURL(ep.url);
  initUpdates(ep);

  // Самопроверка сборки: COMS_SELFTEST=1 npx electron .
  // Печатает, какой адрес выбран и что реально загрузилось, затем выходит.
  if (process.env.COMS_SELFTEST === '1') {
    // loadURL уже дождался загрузки; даём SPA смонтироваться и проверяем напрямую
    (async () => {
      await new Promise((r) => setTimeout(r, 2500));
      const info = await mainWindow.webContents.executeJavaScript(`(() => ({
        url: location.href,
        title: document.title,
        appMounted: (document.getElementById('root')?.children.length || 0) > 0,
        bridge: typeof window.comsDesktop === 'object',
        hasGetDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      }))()`);
      console.log('SELFTEST endpoint:', ep.name, ep.url);
      console.log('SELFTEST result:', JSON.stringify(info));
      // источники для демонстрации экрана должны находиться
      try {
        const srcs = await Promise.race([
          desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } }),
          new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000)),
        ]);
        console.log('SELFTEST capture sources:', srcs.length,
          '| экранов:', srcs.filter((s) => s.id.startsWith('screen:')).length,
          '| окон:', srcs.filter((s) => !s.id.startsWith('screen:')).length);
      } catch (e) {
        console.log('SELFTEST capture ERROR:', e.message);
      }
      isQuitting = true;
      app.quit();
    })();
  }

  // Если страница всё же не загрузилась (например, домен доступен, но сайт лежит) —
  // пробуем второй адрес, чтобы человек не остался с пустым окном.
  mainWindow.webContents.on('did-fail-load', async (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED: обычная отмена навигации */) return;
    if (failedUrl.startsWith('file://')) return; // наши локальные страницы
    let failedHost = '';
    try { failedHost = new URL(failedUrl).hostname; } catch { /* ignore */ }
    const other = ENDPOINTS.find((x) => x.host !== failedHost);
    if (other && await probe(other.host)) {
      mainWindow.loadURL(other.url);
    } else {
      mainWindow.loadFile(path.join(__dirname, 'loading.html'), { query: { error: '1' } });
    }
  });

  // Внешние ссылки — в системный браузер, а не внутрь приложения
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOurOrigin(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isOurOrigin(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Закрытие окна сворачивает в трей — звонок не обрывается случайным крестиком
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('COMS');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть COMS', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    {
      label: 'Сменить адрес входа',
      click: async () => {
        if (!mainWindow) return;
        const current = mainWindow.webContents.getURL();
        const other = ENDPOINTS.find((e) => !current.startsWith(e.url)) || ENDPOINTS[0];
        mainWindow.loadURL(other.url);
      },
    },
    { label: 'Перезагрузить', click: () => mainWindow && mainWindow.reload() },
    {
      label: 'Проверить обновления',
      click: async () => {
        if (!app.isPackaged) {
          dialog.showMessageBox({ type: 'info', message: 'Обновления работают только в установленном приложении' });
          return;
        }
        if (updateReady) { promptInstall(); return; }
        try {
          const r = await autoUpdater.checkForUpdates();
          const remote = r && r.updateInfo && r.updateInfo.version;
          if (!remote || remote === app.getVersion()) {
            dialog.showMessageBox({ type: 'info', title: 'COMS', message: 'У вас последняя версия', detail: `Версия ${app.getVersion()}` });
          }
        } catch (e) {
          dialog.showMessageBox({ type: 'error', title: 'COMS', message: 'Не удалось проверить обновления', detail: e.message });
        }
      },
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// одна копия приложения: второй запуск просто показывает уже открытое окно
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    setupPermissions(session.fromPartition('persist:coms'));
    setupPermissions(session.defaultSession);
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) mainWindow.show();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// IPC от страницы-заглушки: повторить подключение
ipcMain.on('app:retry', async () => {
  if (!mainWindow) return;
  const ep = await pickEndpoint();
  if (ep) mainWindow.loadURL(ep.url);
});

// ── Входящий звонок средствами системы ──
//
// Раньше звонок существовал только внутри окна приложения. Свёрнутое окно о
// нём никак не сообщало: человек видел пропущенный звонок постфактум, а
// звонивший всё это время слушал гудки. Для приложения про звонки это
// главный сценарий, и он не работал.
//
// Теперь окно поднимается поверх всех, мигает в панели задач, а система
// показывает уведомление с ответом и отклонением. Отдельного окна звонка не
// делаем: у приложения уже есть свой экран входящего, ему достаточно
// оказаться перед глазами.

let callNotification = null;
let restoreAlwaysOnTop = null;

function clearCallUi() {
  if (callNotification) {
    try { callNotification.close(); } catch { /* уже закрыто системой */ }
    callNotification = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.flashFrame(false); } catch { /* не на всех системах */ }
    if (restoreAlwaysOnTop !== null) {
      try { mainWindow.setAlwaysOnTop(restoreAlwaysOnTop); } catch { /* окно закрыто */ }
      restoreAlwaysOnTop = null;
    }
  }
}

ipcMain.on('call:incoming', (_e, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const who = String((payload && payload.from) || 'Кто-то').slice(0, 60);

  // Показать окно, даже если оно свёрнуто или спрятано в трей
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    // Поверх всех, но не навсегда: возвращаем прежнее состояние после звонка,
    // иначе окно останется липким и будет мешать работе
    if (restoreAlwaysOnTop === null) restoreAlwaysOnTop = mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    // Мигание в панели задач: если человек в другом приложении, окно перед
    // глазами он всё равно не увидит
    mainWindow.flashFrame(true);
  } catch { /* окно уничтожено между проверкой и вызовом */ }

  if (!Notification.isSupported()) return;
  try {
    if (callNotification) callNotification.close();
    callNotification = new Notification({
      title: 'Входящий звонок',
      body: `${who} звонит в COMS`,
      urgency: 'critical',
      timeoutType: 'never',
      actions: [
        { type: 'button', text: 'Ответить' },
        { type: 'button', text: 'Отклонить' },
      ],
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    // Нажатие по самому уведомлению равносильно ответу: это ожидаемое действие
    callNotification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('call:action', 'accept');
      clearCallUi();
    });
    callNotification.on('action', (_ev, index) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('call:action', index === 0 ? 'accept' : 'decline');
      }
      clearCallUi();
    });
    callNotification.on('close', () => { callNotification = null; });
    callNotification.show();
  } catch (e) {
    console.error('Не удалось показать уведомление о звонке:', e.message);
  }
});

ipcMain.on('call:ended', clearCallUi);
