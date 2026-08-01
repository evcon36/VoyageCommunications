// node deploy/download.js <remote> <local>
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'deploy.config.json'));
const auth = config.keyPath
  ? { privateKey: fs.readFileSync(config.keyPath), passphrase: config.passphrase }
  : { password: config.password };
const remote = process.argv[2], local = process.argv[3];
const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) throw err;
    sftp.open(remote, 'r', (e, h) => {
      if (e) { console.error('open', e.message); conn.end(); process.exit(1); return; }
      sftp.fstat(h, (se, st) => {
        const buf = Buffer.alloc(st.size); let off = 0;
        (function rd() {
          if (off >= st.size) { fs.writeFileSync(local, buf); console.log('Downloaded', st.size); conn.end(); return; }
          const len = Math.min(32768, st.size - off);
          sftp.read(h, buf, off, len, off, (re) => { if (re) { console.error(re.message); conn.end(); process.exit(1); return; } off += len; rd(); });
        })();
      });
    });
  });
}).connect({ host: config.host, port: 22, username: config.username, ...auth, readyTimeout: 15000 });
conn.on('error', e => { console.error('SSH', e.message); process.exit(1); });
