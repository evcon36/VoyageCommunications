// Отправка VoIP push-уведомлений через Apple Push Notification service (APNs).
// Без внешних зависимостей: HTTP/2 из стандартной библиотеки Node + jsonwebtoken
// (уже используется в проекте) для подписи provider-токена ключом .p8 (ES256).
const http2 = require('http2');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const KEY_PATH = process.env.APNS_KEY_PATH;
const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
// Тема voip-пушей — bundle id с суффиксом .voip, отдельно от обычных уведомлений
const TOPIC = `${process.env.APNS_BUNDLE_ID || 'ru.voyagecoms.app'}.voip`;
const HOST = process.env.APNS_ENV === 'production'
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

let cachedKey = null;
function loadKey() {
  if (cachedKey) return cachedKey;
  if (!KEY_PATH || !fs.existsSync(KEY_PATH)) return null;
  cachedKey = fs.readFileSync(KEY_PATH, 'utf8');
  return cachedKey;
}

// Provider-токен живёт до часа у Apple; пересоздаём раз в 40 минут, чтобы не
// подходить к границе и не гонять podpись на каждый пуш.
let cachedToken = null;
let cachedTokenAt = 0;
function providerToken() {
  const key = loadKey();
  if (!key || !KEY_ID || !TEAM_ID) return null;
  const now = Date.now();
  if (cachedToken && now - cachedTokenAt < 40 * 60 * 1000) return cachedToken;
  cachedToken = jwt.sign({ iss: TEAM_ID, iat: Math.floor(now / 1000) }, key, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: KEY_ID },
  });
  cachedTokenAt = now;
  return cachedToken;
}

// Шлёт один VoIP-пуш на один токен устройства. Не бросает исключение при
// отказе Apple (истёкший/невалидный токен и т.п.) — только логирует и
// возвращает false, чтобы один мёртвый токен не ронял остальную рассылку.
function sendVoipPush(deviceToken, payload) {
  return new Promise((resolve) => {
    const token = providerToken();
    if (!token) {
      console.error('APNs: ключ не настроен (APNS_KEY_PATH/APNS_KEY_ID/APNS_TEAM_ID)');
      return resolve(false);
    }

    const client = http2.connect(HOST);
    client.on('error', (e) => { console.error('APNs connect error:', e.message); resolve(false); });

    const body = JSON.stringify(payload);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${token}`,
      'apns-topic': TOPIC,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });

    let status = 0;
    let resBody = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { resBody += chunk; });
    req.on('end', () => {
      client.close();
      if (status !== 200) {
        console.error('APNs push отклонён:', status, resBody);
        return resolve(false);
      }
      resolve(true);
    });
    req.on('error', (e) => { console.error('APNs request error:', e.message); resolve(false); });

    req.write(body);
    req.end();
  });
}

module.exports = { sendVoipPush };
