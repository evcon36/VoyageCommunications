// Деплой ОСНОВНОГО приложения для пользователей: voyage-coms.ru (за Cloudflare).
// Отдаётся из /var/www/voyage-coms/dist, base=/, API=https://voyage-coms.ru.
// Отличается от deploy/deploy.js (тот обновляет communications.voyage-community.ru, base=/communications/).
// Использование:  node deploy/deploy-coms.js
// Креды — deploy/deploy.config.json (не коммитится).

const { Client } = require('ssh2');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const DIST = path.join(CLIENT, 'dist-coms');
const CONFIG_PATH = path.join(__dirname, 'deploy.config.json');

const REMOTE_DIR = '/var/www/voyage-coms/dist';
const BASE_PATH = '/';
const SITE = 'https://voyage-coms.ru';           // и API, и HTTP-проверка
const SERVER_URL = 'https://voyage-coms.ru';

// TURN-креды сюда больше не кладём: постоянный пароль попадал в публичный бандл.
// Клиент получает временные креды вместе с токеном комнаты (см. rooms.routes.js).
const BUILD_ENV = {
  VITE_BASE_PATH: BASE_PATH,
  VITE_SERVER_URL: SERVER_URL,
};

const REQUIRED_FILES = ['index.html', 'applause.mp3'];

function fail(msg) { console.error('\n❌ ДЕПЛОЙ ОСТАНОВЛЕН: ' + msg); process.exit(1); }
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fail(`Нет файла ${CONFIG_PATH}`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function build() {
  console.log('1/5 Сборка (coms, base=/)...');
  fs.rmSync(DIST, { recursive: true, force: true });
  execSync('npx vite build --outDir dist-coms', {
    cwd: CLIENT, stdio: 'inherit',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...BUILD_ENV },
  });
}

function validate() {
  console.log('2/5 Валидация...');
  for (const f of REQUIRED_FILES) if (!fs.existsSync(path.join(DIST, f))) fail(`в dist-coms/ нет файла ${f}`);
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  if (!html.includes('src="/assets/')) fail('index.html собран не с base=/ (VITE_BASE_PATH)');
  const jsFile = fs.readdirSync(path.join(DIST, 'assets')).find(f => f.startsWith('index-') && f.endsWith('.js'));
  const js = fs.readFileSync(path.join(DIST, 'assets', jsFile), 'utf8');
  if (js.includes('http://localhost:4000')) fail('в бандле остался localhost:4000');
  if (!js.includes(SERVER_URL)) fail(`в бандле нет ${SERVER_URL} — VITE_SERVER_URL не подхватился`);
  console.log('   ok: base=/, SERVER_URL=' + SERVER_URL);
}

function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', code => code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${errOut || out}`)));
      stream.on('data', d => { out += d; });
      stream.stderr.on('data', d => { errOut += d; });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const data = fs.readFileSync(localPath);
      const CHUNK = 32768;
      sftp.open(remotePath, 'w', (e, handle) => {
        if (e) return reject(e);
        let offset = 0;
        (function writeNext() {
          if (offset >= data.length) return sftp.close(handle, () => resolve(data.length));
          const end = Math.min(offset + CHUNK, data.length);
          sftp.write(handle, data.slice(offset, end), 0, end - offset, offset, werr => {
            if (werr) return reject(werr);
            offset = end; writeNext();
          });
        })();
      });
    });
  });
}

async function deploy(config) {
  console.log('3/5 Упаковка...');
  const tarPath = path.join(DIST, '..', 'deploy-coms.tar.gz');
  execSync('tar czf ../deploy-coms.tar.gz .', { cwd: DIST });

  console.log('4/5 Загрузка и выкладка...');
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host: config.host, port: 22, username: config.username,
      ...(config.keyPath ? { privateKey: fs.readFileSync(config.keyPath), passphrase: config.passphrase } : { password: config.password }),
      readyTimeout: 20000,
    });
  });

  try {
    await uploadFile(conn, tarPath, '/tmp/deploy-coms.tar.gz');
    await sshExec(conn,
      `set -e
       rm -rf /tmp/deploy-coms-new && mkdir /tmp/deploy-coms-new
       tar xzf /tmp/deploy-coms.tar.gz -C /tmp/deploy-coms-new
       rm -rf ${REMOTE_DIR}.old
       [ -d ${REMOTE_DIR} ] && mv ${REMOTE_DIR} ${REMOTE_DIR}.old
       mv /tmp/deploy-coms-new ${REMOTE_DIR}
       rm -f /tmp/deploy-coms.tar.gz`);

    console.log('5/5 Проверка на origin (в обход Cloudflare)...');
    // Проверяем сам origin через Host-заголовок на 127.0.0.1, чтобы не наткнуться на кэш Cloudflare.
    const local = await sshExec(conn,
      `curl -sk -o /dev/null -w 'index:%{http_code}\\n' -H 'Host: voyage-coms.ru' https://127.0.0.1/ &&
       curl -sk -H 'Host: voyage-coms.ru' https://127.0.0.1/ | grep -o 'index-[A-Za-z0-9_-]*\\.js' | head -1`);
    console.log('   origin ' + local.trim().replace(/\n/g, ' | '));
    if (!local.includes('index:200')) { console.error('⚠ origin не отдаёт 200 — откат вручную: mv ' + REMOTE_DIR + '.old обратно'); process.exit(1); }
    await sshExec(conn, `rm -rf ${REMOTE_DIR}.old`);
    console.log('\n✅ Origin обновлён. ВАЖНО: очистить кэш Cloudflare для voyage-coms.ru (иначе пользователи получат старый index.html).');
  } finally {
    conn.end();
    fs.rmSync(tarPath, { force: true });
  }
}

(async () => {
  const config = loadConfig();
  build();
  validate();
  await deploy(config);
})().catch(e => fail(e.message));
