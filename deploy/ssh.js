// SSH-команда на прод-сервере: node deploy/ssh.js "<команда>"
// Креды берутся из deploy.config.json (gitignored).
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, 'deploy.config.json'));

// аутентификация: приватный ключ (config.keyPath) или пароль (config.password)
const auth = config.keyPath
  ? { privateKey: fs.readFileSync(config.keyPath), passphrase: config.passphrase }
  : { password: config.password };

const command = process.argv.slice(2).join(' ');

const conn = new Client();
conn.on('ready', () => {
  conn.exec(command, (err, stream) => {
    if (err) { console.error(err); conn.end(); return; }
    stream.on('close', (code) => {
      conn.end();
      process.exit(code);
    });
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
  });
}).connect({ host: config.host, port: 22, username: config.username, ...auth, readyTimeout: 15000 });

conn.on('error', (e) => { console.error('SSH error:', e.message); process.exit(1); });
