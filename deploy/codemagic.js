// Запуск и отслеживание iOS-сборки в Codemagic без захода в интерфейс.
// Токен — в deploy/codemagic.config.json (не коммитится, см. .gitignore).
// Получить токен: Codemagic → Personal account settings → API tokens.
//
//   node deploy/codemagic.js start            запустить сборку для iPhone
//   node deploy/codemagic.js start android    запустить сборку APK
//   node deploy/codemagic.js status           последние сборки
//   node deploy/codemagic.js watch [buildId]  ждать окончания (по умолчанию последняя)
//
// Вебхук на теги ios-* в Codemagic не подключён: пуш тега сборку НЕ заводит,
// запускать надо отсюда или кнопкой Start new build.

const fs = require('fs');
const path = require('path');

const APP_ID = '6a6e491cb5b21006155826f5';   // VoyageCommunications
// ключи воркфлоу из codemagic.yaml
const WORKFLOWS = { ios: 'ios-testflight', android: 'android-apk' };
const BRANCH = 'ios-testflight';
const API = 'https://api.codemagic.io';

const CONFIG = path.join(__dirname, 'codemagic.config.json');
if (!fs.existsSync(CONFIG)) {
  console.error(`Нет файла ${CONFIG} с полем "token"`);
  process.exit(1);
}
const TOKEN = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token;

async function api(pathname, init = {}) {
  const r = await fetch(API + pathname, {
    ...init,
    headers: { 'x-auth-token': TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const builds = () => api(`/builds?appId=${APP_ID}&limit=8`).then(d => d.builds || []);

async function start(which = 'ios') {
  const workflowId = WORKFLOWS[which];
  if (!workflowId) throw new Error(`Неизвестная сборка "${which}". Доступны: ${Object.keys(WORKFLOWS).join(', ')}`);
  const { buildId } = await api('/builds', {
    method: 'POST',
    body: JSON.stringify({ appId: APP_ID, workflowId, branch: BRANCH }),
  });
  console.log(`Сборка запущена (${workflowId}): ${buildId}`);
  console.log(`https://codemagic.io/app/${APP_ID}/build/${buildId}`);
  return buildId;
}

async function status() {
  for (const b of await builds()) {
    const wf = b.config?.name || b.workflowId || b.workflow?.name || '';
    console.log(`${b._id}  ${String(b.status).padEnd(10)}  ${String(wf).padEnd(18)}  ${b.startedAt || ''}`);
  }
}

// Сборка идёт около десяти минут, поэтому опрашиваем раз в полминуты.
async function watch(id) {
  const buildId = id || (await builds())[0]?._id;
  if (!buildId) return console.log('Сборок нет');
  let last = '';
  while (true) {
    const b = (await builds()).find(x => x._id === buildId);
    if (!b) return console.log('Сборка не найдена:', buildId);
    if (b.status !== last) { console.log(new Date().toISOString().slice(11, 19), b.status); last = b.status; }
    if (['finished', 'failed', 'canceled', 'timeout', 'skipped'].includes(b.status)) {
      console.log('Итог:', b.status, b.message ? `— ${b.message}` : '');
      console.log(`https://codemagic.io/app/${APP_ID}/build/${buildId}`);
      return;
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

const cmd = process.argv[2] || 'status';
const run = cmd === 'start' ? () => start(process.argv[3] || 'ios')
          : cmd === 'watch' ? () => watch(process.argv[3])
          : status;
run().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
