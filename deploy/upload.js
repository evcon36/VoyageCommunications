// Загрузка файла на сервер: node deploy/upload.js <local> <remote>
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'deploy.config.json'));

const auth = config.keyPath
  ? { privateKey: fs.readFileSync(config.keyPath), passphrase: config.passphrase }
  : { password: config.password };

const localFile = process.argv[2];
const remoteFile = process.argv[3];
const data = fs.readFileSync(localFile);
const CHUNK = 32768;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) throw err;
    sftp.open(remoteFile, 'w', (e, handle) => {
      if (e) { console.error('open err:', e); conn.end(); process.exit(1); return; }
      let offset = 0;
      (function writeNext() {
        if (offset >= data.length) {
          return sftp.close(handle, () => { console.log('Uploaded', data.length, 'bytes ->', remoteFile); conn.end(); });
        }
        const end = Math.min(offset + CHUNK, data.length);
        sftp.write(handle, data.slice(offset, end), 0, end - offset, offset, werr => {
          if (werr) { console.error('write err:', werr); conn.end(); process.exit(1); return; }
          offset = end; writeNext();
        });
      })();
    });
  });
}).connect({ host: config.host, port: 22, username: config.username, ...auth, readyTimeout: 15000 });
conn.on('error', (e) => { console.error('SSH error:', e.message); process.exit(1); });
