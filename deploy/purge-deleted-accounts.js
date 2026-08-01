#!/usr/bin/env node
/**
 * Физическое удаление аккаунтов, у которых истекла 30-дневная отсрочка.
 *
 * Порядок важен: сначала стираем данные COMS (там есть файлы на диске),
 * потом сам аккаунт. Если очистка COMS упала — аккаунт не трогаем,
 * иначе данные останутся сиротами без владельца.
 *
 * Запуск из cron раз в сутки (NODE_PATH обязателен: accounts-api берёт
 * зависимости из чужих node_modules, своих у него нет):
 *   0 4 * * * NODE_PATH=/var/www/voyage-backend/node_modules /usr/bin/node \
 *     /var/www/accounts-api/purge-deleted-accounts.js >> /var/log/account-purge.log 2>&1
 *
 * Прогон без удаления: node purge-deleted-accounts.js --dry-run
 */
const fs = require('fs');
const { Pool } = require('pg');

// Свой разбор .env вместо dotenv: пакета здесь нет, а формат простой.
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const ENV = loadEnv('/var/www/accounts-api/.env');

const GRACE_DAYS = 30;
const COMS_INTERNAL_URL = ENV.COMS_INTERNAL_URL || 'http://127.0.0.1:4000/internal/purge-user';
const INTERNAL_SECRET = ENV.INTERNAL_SECRET || '';
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  user: ENV.DB_USER, host: ENV.DB_HOST, database: ENV.DB_NAME,
  password: ENV.DB_PASS, port: Number(ENV.DB_PORT) || 5432,
});

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function purgeComsData(account) {
  const resp = await fetch(COMS_INTERNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
    body: JSON.stringify({ accountId: String(account.id), username: account.username }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`COMS purge вернул ${resp.status}: ${body.message || 'без деталей'}`);
  return body.stats || {};
}

async function purgeAccount(account) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Платежи не удаляем: они нужны для бухгалтерии и по закону. Вместо этого
    // обезличиваем — сумма и дата остаются, связь с человеком пропадает.
    await client.query('UPDATE vpn_payments SET account_id = NULL WHERE account_id = $1', [account.id]);
    // Конфиг VPN отзываем целиком: это доступ, а не финансовая запись.
    await client.query('DELETE FROM vpn_wg_clients WHERE account_id = $1', [account.id]);
    // Журнал входов содержит IP — это персональные данные, стираем.
    await client.query('DELETE FROM auth_events WHERE account_id = $1', [account.id]);
    // trusted_devices, twofa_codes и twofa_backup_codes уходят каскадом.
    await client.query('DELETE FROM accounts WHERE id = $1', [account.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

(async () => {
  if (!INTERNAL_SECRET) {
    log('ОШИБКА: INTERNAL_SECRET не задан — очистка данных COMS невозможна');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, username, email, deletion_requested_at
       FROM accounts
      WHERE deletion_requested_at IS NOT NULL
        AND deletion_requested_at < now() - ($1 || ' days')::interval
      ORDER BY deletion_requested_at`,
    [GRACE_DAYS],
  );

  if (!rows.length) {
    log('нечего удалять');
    await pool.end();
    return;
  }

  log(`к удалению: ${rows.length}`, DRY_RUN ? '(пробный прогон, ничего не трогаем)' : '');

  let done = 0;
  let failed = 0;
  for (const acc of rows) {
    const who = `${acc.id} ${acc.username || acc.email || '—'}`;
    if (DRY_RUN) {
      log(`  [пробно] ${who} (запрошено ${acc.deletion_requested_at.toISOString().slice(0, 10)})`);
      continue;
    }
    try {
      const stats = await purgeComsData(acc);
      await purgeAccount(acc);
      log(`  удалён ${who} | COMS: ${JSON.stringify(stats)}`);
      done++;
    } catch (e) {
      // аккаунт остаётся помеченным — следующий запуск попробует снова
      log(`  ОШИБКА ${who}: ${e.message}`);
      failed++;
    }
  }

  log(`итого: удалено ${done}, с ошибками ${failed}`);
  await pool.end();
  if (failed) process.exit(1);
})().catch((e) => {
  log('ФАТАЛЬНО:', e.message);
  process.exit(1);
});
