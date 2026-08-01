// одноразовая заливка файла на сервер (переиспользует креды deploy.config.json)
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy.config.json'), 'utf8'));

const localFile = process.argv[2];
const remoteFile = process.argv[3];
const data = fs.readFileSync(localFile);
const CHUNK = 32768;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) throw err;
    sftp.open(remoteFile, 'w', (e, handle) => {
      if (e) { console.error('open err:', e.message); process.exit(1); }
      let offset = 0;
      (function writeNext() {
        if (offset >= data.length) {
          return sftp.close(handle, () => { console.log('uploaded', data.length, 'bytes'); conn.end(); });
        }
        const end = Math.min(offset + CHUNK, data.length);
        sftp.write(handle, data.slice(offset, end), 0, end - offset, offset, werr => {
          if (werr) { console.error('write err:', werr.message); process.exit(1); }
          offset = end; writeNext();
        });
      })();
    });
  });
}).connect({ host: config.host, port: 22, username: config.username, password: config.password, readyTimeout: 20000 });
conn.on('error', e => { console.error('SSH error:', e.message); process.exit(1); });
