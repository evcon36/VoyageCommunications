// Публикация сборки десктопного приложения на наш сервер.
// electron-updater берёт latest.yml и по нему скачивает новый установщик.
//
// Использование:
//   cd desktop && npm run build:win     (собрать)
//   node deploy/deploy-desktop.js       (выложить)
//
// Раздача идёт с /downloads/ на обоих доменах (за Cloudflare и напрямую),
// поэтому обновления доходят даже если провайдер режет один из путей.

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'desktop', 'release');
const REMOTE_DIR = '/var/www/voyage-downloads';
const CONFIG_PATH = path.join(__dirname, 'deploy.config.json');

// latest.yml обязателен: без него автообновление не работает
const REQUIRED = ['latest.yml'];

function fail(msg) {
  console.error('\n❌ ПУБЛИКАЦИЯ ОСТАНОВЛЕНА: ' + msg);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fail(`нет файла ${CONFIG_PATH}`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function collectFiles() {
  if (!fs.existsSync(RELEASE_DIR)) {
    fail(`нет папки ${RELEASE_DIR} — сначала соберите: cd desktop && npm run build:win`);
  }
  const all = fs.readdirSync(RELEASE_DIR);
  // builder-debug.yml — служебный лог сборки, клиентам не нужен
  const files = all.filter((f) => /\.(exe|yml|blockmap)$/i.test(f) && f !== 'builder-debug.yml');
  for (const need of REQUIRED) {
    if (!files.includes(need)) {
      fail(`в сборке нет ${need} — проверьте секцию "publish" в desktop/package.json`);
    }
  }
  const exe = files.find((f) => f.toLowerCase().endsWith('.exe'));
  if (!exe) fail('в сборке нет установщика (.exe)');
  return files;
}

function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${errOut || out}`))));
      stream.on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errOut += d; });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const data = fs.readFileSync(localPath);
      const CHUNK = 65536;
      sftp.open(remotePath, 'w', (e, handle) => {
        if (e) return reject(e);
        let offset = 0;
        (function next() {
          if (offset >= data.length) return sftp.close(handle, () => resolve(data.length));
          const end = Math.min(offset + CHUNK, data.length);
          sftp.write(handle, data.slice(offset, end), 0, end - offset, offset, (werr) => {
            if (werr) return reject(werr);
            offset = end;
            next();
          });
        })();
      });
    });
  });
}

(async () => {
  const config = loadConfig();
  const files = collectFiles();

  // версия из latest.yml — её увидят клиенты
  const yml = fs.readFileSync(path.join(RELEASE_DIR, 'latest.yml'), 'utf8');
  const version = (yml.match(/^version:\s*(.+)$/m) || [])[1] || '?';
  console.log(`1/3 Публикуем версию ${version} (${files.length} файлов)`);

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host: config.host,
      port: 22,
      username: config.username,
      ...(config.keyPath
        ? { privateKey: fs.readFileSync(config.keyPath), passphrase: config.passphrase }
        : { password: config.password }),
      readyTimeout: 20000,
    });
  });

  try {
    await sshExec(conn, `mkdir -p ${REMOTE_DIR}`);
    console.log('2/3 Загрузка...');
    for (const f of files) {
      const size = fs.statSync(path.join(RELEASE_DIR, f)).size;
      process.stdout.write(`   ${f} (${(size / 1048576).toFixed(1)} МБ)... `);
      // сначала во временный файл, потом переименование — клиент не скачает половину
      await uploadFile(conn, path.join(RELEASE_DIR, f), `${REMOTE_DIR}/.tmp-${f}`);
      // кавычки обязательны: в именах сборок могут быть пробелы
      await sshExec(conn, `mv "${REMOTE_DIR}/.tmp-${f}" "${REMOTE_DIR}/${f}"`);
      console.log('ок');
    }
    await sshExec(conn, `chmod 644 ${REMOTE_DIR}/* && chown -R www-data:www-data ${REMOTE_DIR} 2>/dev/null || true`);

    console.log('3/3 Проверка раздачи...');
    const check = await sshExec(conn,
      `curl -s -o /dev/null -w 'coms:%{http_code} ' https://voyage-coms.ru/downloads/latest.yml && ` +
      `curl -s -o /dev/null -w 'direct:%{http_code}\\n' https://communications.voyage-community.ru/downloads/latest.yml`);
    console.log('   ' + check.trim());
    if (!check.includes('coms:200') || !check.includes('direct:200')) {
      fail('latest.yml не отдаётся по HTTP — проверьте nginx (location /downloads/)');
    }
    console.log(`\n✅ Версия ${version} опубликована. Клиенты получат обновление автоматически.`);
  } finally {
    conn.end();
  }
})().catch((e) => fail(e.message));
