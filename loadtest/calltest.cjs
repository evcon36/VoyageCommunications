// Сквозная проверка сценариев звонка на живом сервере.
// Поднимаем два сокет-клиента и прогоняем каждый случай отдельно.
// ЗАПУСКАТЬ НА СЕРВЕРЕ, из /var/www/voyage/server: сервер берёт ник из токена,
// а подписать токен можно только там, где лежит JWT_SECRET.
//   cd /var/www/voyage/server && node --env-file=.env calltest.cjs
const { io } = require('socket.io-client');

const URL = process.env.COMS_TEST_URL || 'https://voyage-coms.ru';
const ROOM = { roomSlug: 'voy-test-call', inviteKey: 'k-test' };

// Сервер больше не верит клиенту на слово: presence принимает только токен
function tokenFor(username) {
  const { signToken } = require('./src/lib/jwt');
  return signToken({ id: `test-${username}`, username });
}

function connect(username) {
  const token = tokenFor(username);
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], extraHeaders: { Origin: 'capacitor://localhost' } });
    s.on('connect', () => { s.emit('presence', { token }); setTimeout(() => resolve(s), 250); });
  });
}

// ждём событие с таймаутом — иначе зависший сценарий не отличить от рабочего
function waitFor(sock, event, ms = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sock.off(event, h); resolve(null); }, ms);
    const h = (payload) => { clearTimeout(t); sock.off(event, h); resolve(payload || {}); };
    sock.on(event, h);
  });
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const a = await connect('testcaller');
  const b = await connect('testcallee');

  // 1. Отклонение: звонящий должен узнать причину
  {
    const inc = waitFor(b, 'call-incoming');
    a.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A' });
    const call = await inc;
    check('входящий доходит до получателя', Boolean(call?.callId));
    if (call?.callId) {
      const ended = waitFor(a, 'call-ended');
      b.emit('call-decline', { callId: call.callId });
      const e = await ended;
      check('отклонение доходит до звонящего', e?.reason === 'declined', `reason=${e?.reason}`);
    }
  }

  // 2. Отмена звонящим: плашка у получателя должна погаснуть
  {
    const inc = waitFor(b, 'call-incoming');
    a.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A' });
    const call = await inc;
    const ended = waitFor(b, 'call-ended');
    a.emit('call-cancel', { callId: call.callId });
    const e = await ended;
    check('отмена гасит плашку у получателя', e?.reason === 'cancelled', `reason=${e?.reason}`);
  }

  // 3. Звонок несуществующему: не должно быть тишины
  {
    const ended = waitFor(a, 'call-ended');
    a.emit('call-start', { toUsername: 'nobody-here', ...ROOM, fromName: 'A' });
    const e = await ended;
    check('недоступный абонент — звонящий уведомлён', e?.reason === 'unavailable', `reason=${e?.reason}`);
  }

  // 4. Звонок самому себе
  {
    const ended = waitFor(a, 'call-ended');
    a.emit('call-start', { toUsername: 'testcaller', ...ROOM, fromName: 'A' });
    const e = await ended;
    check('звонок самому себе отклоняется', e?.reason === 'self', `reason=${e?.reason}`);
  }

  // 5. Двойной клик не плодит звонки
  {
    const inc = waitFor(b, 'call-incoming');
    a.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A' });
    const first = await inc;
    const second = waitFor(b, 'call-incoming', 1500);
    a.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A' });
    const dup = await second;
    check('повторный клик не создаёт второй звонок', dup === null);
    a.emit('call-cancel', { callId: first.callId });
    await waitFor(b, 'call-ended', 2000);
  }

  // 6. Занято: пока идёт звонок, третий получает busy
  {
    const c = await connect('testthird');
    const inc = waitFor(b, 'call-incoming');
    a.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A' });
    const call = await inc;
    const ended = waitFor(c, 'call-ended');
    c.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'C' });
    const e = await ended;
    check('второй звонящий получает «занято»', e?.reason === 'busy', `reason=${e?.reason}`);
    a.emit('call-cancel', { callId: call.callId });
    await waitFor(b, 'call-ended', 2000);
    c.close();
  }

  // 7. Приём: звонящий получает данные комнаты
  {
    const inc = waitFor(b, 'call-incoming');
    a.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A' });
    const call = await inc;
    const acc = waitFor(a, 'call-accepted');
    b.emit('call-accept', { callId: call.callId });
    const r = await acc;
    check('приём доводит комнату до звонящего', r?.roomSlug === ROOM.roomSlug, `room=${r?.roomSlug}`);
    // повторный приём того же звонка не должен ничего дать
    const again = waitFor(a, 'call-accepted', 1500);
    b.emit('call-accept', { callId: call.callId });
    check('повторный приём игнорируется', (await again) === null);
  }

  // 8. Обрыв соединения звонящего гасит звонок
  {
    const a2 = await connect('testcaller2');
    const inc = waitFor(b, 'call-incoming');
    a2.emit('call-start', { toUsername: 'testcallee', ...ROOM, fromName: 'A2' });
    await inc;
    const ended = waitFor(b, 'call-ended', 5000);
    a2.close();
    const e = await ended;
    check('обрыв у звонящего гасит плашку', e?.reason === 'cancelled', `reason=${e?.reason}`);
  }

  a.close(); b.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\nИТОГО: ${results.length - bad.length}/${results.length} сценариев прошли`);
  process.exit(bad.length ? 1 : 0);
})();
