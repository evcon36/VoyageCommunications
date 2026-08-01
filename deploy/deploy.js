// Деплой клиента Voyage Communications на прод.
// Использование:  node deploy/deploy.js
// Креды берутся из deploy/deploy.config.json (НЕ коммитится, см. .gitignore).

const { Client } = require('ssh2');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const DIST = path.join(CLIENT, 'dist');
const CONFIG_PATH = path.join(__dirname, 'deploy.config.json');

const REMOTE_DIR = '/var/www/voyage/client/dist';
const BASE_PATH = '/communications/';
// SITE — домен API (VITE_SERVER_URL): к нему клиент обращается за /companies, /rooms, /auth.
// Валидация бандла проверяет, что этот адрес вшит в сборку.
const SITE = 'https://voyage-community.ru';
// CHECK_SITE — где реально лежит эта статика (/var/www/voyage/client/dist). voyage-community.ru/communications/
// теперь 301 → voyage-coms.ru, а сам dist отдаётся напрямую на поддомене communications.voyage-community.ru.
// ВНИМАНИЕ: основное приложение для пользователей — voyage-coms.ru → /var/www/voyage-coms/dist,
// он деплоится ОТДЕЛЬНО (см. deploy/deploy-coms.js).
const CHECK_SITE = 'https://communications.voyage-community.ru';

// Файлы, которые обязаны попасть в сборку — иначе деплой прерывается
const REQUIRED_FILES = [
  'index.html',
  'applause.mp3',
  'trump-money.mp3',
  'trump-amazing.mp3',
  'trump-beautiful.mp3',
  'trump-50.mp3',
];

function fail(msg) {
  console.error('\n❌ ДЕПЛОЙ ОСТАНОВЛЕН: ' + msg);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`Нет файла ${CONFIG_PATH}.\nСоздайте его:\n` +
      JSON.stringify({ host: 'x.x.x.x', username: 'root', password: '...' }, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function build() {
  console.log('1/5 Сборка...');
  execSync('npx vite build', {
    cwd: CLIENT,
    stdio: 'inherit',
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: '1',
      VITE_BASE_PATH: BASE_PATH,
    },
  });
}

function validate() {
  console.log('2/5 Валидация сборки...');
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(DIST, f))) fail(`в dist/ нет файла ${f}`);
  }
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  if (!html.includes(`src="${BASE_PATH}assets/`)) {
    fail(`index.html не содержит base-path ${BASE_PATH} — сборка собрана с неправильным VITE_BASE_PATH`);
  }
  // с code-splitting js-файлов несколько — env-переменные вшиты в основной index-чанк
  const jsFile = fs.readdirSync(path.join(DIST, 'assets')).find(f => f.startsWith('index-') && f.endsWith('.js'));
  const js = fs.readFileSync(path.join(DIST, 'assets', jsFile), 'utf8');
  if (js.includes('http://localhost:4000')) {
    fail('в бандле остался localhost:4000 — не подхватился client/.env.production (VITE_SERVER_URL)');
  }
  if (!js.includes(SITE)) {
    fail(`в бандле нет ${SITE} — VITE_SERVER_URL указывает не на прод`);
  }
  console.log('   ok: base-path, SERVER_URL, mp3-файлы на месте');
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
          if (offset >= data.length) {
            return sftp.close(handle, () => resolve(data.length));
          }
          const end = Math.min(offset + CHUNK, data.length);
          sftp.write(handle, data.slice(offset, end), 0, end - offset, offset, werr => {
            if (werr) return reject(werr);
            offset = end;
            writeNext();
          });
        })();
      });
    });
  });
}

async function deploy(config) {
  console.log('3/5 Упаковка...');
  // tar запускаем с относительными путями: GNU tar в Git Bash не понимает "C:\..."
  const tarPath = path.join(DIST, '..', 'deploy-dist.tar.gz');
  execSync('tar czf ../deploy-dist.tar.gz .', { cwd: DIST });

  console.log('4/5 Загрузка и выкладка...');
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host: config.host, port: 22, username: config.username,
      ...(config.keyPath
        ? { privateKey: fs.readFileSync(config.keyPath), passphrase: config.passphrase }
        : { password: config.password }),
      readyTimeout: 20000,
    });
  });

  try {
    await uploadFile(conn, tarPath, '/tmp/deploy-dist.tar.gz');
    // атомарно: распаковка во временную папку, потом мгновенная замена
    await sshExec(conn,
      `set -e
       rm -rf /tmp/deploy-dist-new
       mkdir /tmp/deploy-dist-new
       tar xzf /tmp/deploy-dist.tar.gz -C /tmp/deploy-dist-new
       rm -rf ${REMOTE_DIR}.old
       [ -d ${REMOTE_DIR} ] && mv ${REMOTE_DIR} ${REMOTE_DIR}.old
       mv /tmp/deploy-dist-new ${REMOTE_DIR}
       rm -f /tmp/deploy-dist.tar.gz`);

    console.log('5/5 Проверка на проде...');
    const checks = await sshExec(conn,
      `curl -s -o /dev/null -w 'index:%{http_code} ' ${CHECK_SITE}${BASE_PATH} &&
       curl -s ${CHECK_SITE}${BASE_PATH} | grep -o 'index-[A-Za-z0-9_-]*\\.js' | head -1 &&
       curl -s -o /dev/null -w 'mp3:%{http_code}\\n' ${CHECK_SITE}${BASE_PATH}applause.mp3`);
    console.log('   ' + checks.trim().replace(/\n/g, ' | '));

    if (!checks.includes('index:200') || !checks.includes('mp3:200')) {
      console.error('⚠ Проверка не прошла! Откат: mv ' + REMOTE_DIR + '.old обратно');
      process.exit(1);
    }
    await sshExec(conn, `rm -rf ${REMOTE_DIR}.old`);
    console.log('\n✅ Деплой завершён успешно.');
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
