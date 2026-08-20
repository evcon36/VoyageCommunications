// Свежий APK попадает на сайт сам.
//
// Раньше я выкладывал его руками после каждой сборки, и это забывалось: на
// сайте лежала версия на несколько правок старше той, что стояла у людей.
//
// Забирает сервер, а не система сборки: иначе пришлось бы класть в неё ключ
// доступа к серверу. Здесь же нужен только токен чтения сборок, и он остаётся
// на нашей стороне.
//
// Запуск: node /var/www/voyage/tools/sync-apk.js
// Токен: /var/www/voyage/tools/codemagic.token (права 600)

const fs = require('fs');
const path = require('path');

const APP_ID = '6a6e491cb5b21006155826f5';
const TARGET = '/var/www/voyage-downloads/COMS.apk';
const STAMP = path.join(__dirname, '.last-apk-build');
const TOKEN_FILE = path.join(__dirname, 'codemagic.token');

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

async function main() {
  if (!fs.existsSync(TOKEN_FILE)) { log('нет файла с токеном'); process.exit(1); }
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const head = { 'x-auth-token': token };

  const r = await fetch(`https://api.codemagic.io/builds?appId=${APP_ID}&limit=10`, { headers: head });
  if (!r.ok) { log('Codemagic ответил', r.status); process.exit(1); }
  const { builds = [] } = await r.json();

  // Опознаём сборку Android по самому артефакту: поле с именем процесса в
  // списке сборок приходит пустым, и фильтр по нему не находил ничего.
  const build = builds.find(b =>
    b.status === 'finished'
    && (b.artefacts || []).some(a => a.name.endsWith('.apk')));

  if (!build) { log('удачных сборок с APK не найдено'); return; }

  const last = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : '';
  if (last === build._id) { log('на сайте уже свежая версия'); return; }

  const art = build.artefacts.find(a => a.name.endsWith('.apk'));
  const ar = await fetch(art.url, { headers: head });
  if (!ar.ok) { log('не удалось скачать APK:', ar.status); process.exit(1); }
  const buf = Buffer.from(await ar.arrayBuffer());

  // Проверяем, что это действительно APK: пустой или обрезанный файл на сайте
  // хуже устаревшего, его невозможно поставить
  if (buf.length < 1_000_000 || buf.slice(0, 2).toString() !== 'PK') {
    log('скачанное не похоже на APK, оставляем прежний файл');
    process.exit(1);
  }

  // Пишем рядом и переименовываем: подмена мгновенная, никто не поймает
  // наполовину записанный файл
  const tmp = TARGET + '.new';
  fs.writeFileSync(tmp, buf);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, TARGET);
  fs.writeFileSync(STAMP, build._id);
  log(`выложен APK из сборки ${build._id}, ${(buf.length / 1048576).toFixed(1)} МБ`);
}

main().catch(e => { log('ошибка:', e.message); process.exit(1); });
