#!/usr/bin/env node
/**
 * Нагрузочный тест API COMS: лестница по параллельности.
 *
 * Бьёт в реальный эндпоинт, который ходит в Postgres, поэтому меряется вся
 * цепочка: nginx → Node → Prisma → Postgres. Тест сам останавливается,
 * если сервис начинает деградировать, чтобы не положить прод.
 *
 * Запуск: node loadtest-api.js <url> [уровни через запятую]
 */
const https = require('https');
const { URL } = require('url');

const target = process.argv[2];
const levels = (process.argv[3] || '5,10,25,50,100').split(',').map(Number);
if (!target) {
  console.error('нужен URL');
  process.exit(1);
}
const u = new URL(target);

// порог, после которого считаем, что сервис поплыл, и прекращаем нагружать
const MAX_ERROR_RATE = 0.05;
const MAX_P95_MS = 3000;
const LEVEL_SECONDS = 10;

const agent = new https.Agent({ keepAlive: true, maxSockets: 500 });

function once() {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, agent, timeout: 15000 },
      (res) => {
        res.resume();
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ ok: res.statusCode < 500, code: res.statusCode, ms });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 'timeout', ms: 15000 }); });
    req.on('error', (e) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ok: false, code: e.code || 'err', ms });
    });
  });
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function runLevel(concurrency) {
  const deadline = Date.now() + LEVEL_SECONDS * 1000;
  const lat = [];
  const codes = {};
  let done = 0, failed = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const r = await once();
      lat.push(r.ms);
      codes[r.code] = (codes[r.code] || 0) + 1;
      done++;
      if (!r.ok) failed++;
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);

  return {
    concurrency,
    rps: done / secs,
    total: done,
    failed,
    errorRate: done ? failed / done : 0,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    p99: pct(lat, 0.99),
    codes,
  };
}

(async () => {
  console.log(`Цель: ${target}`);
  console.log(`Уровни: ${levels.join(', ')} параллельных клиентов, по ${LEVEL_SECONDS} с\n`);
  console.log('  парал. |    rps |  p50мс |  p95мс |  p99мс | ошибок | коды');
  console.log('  -------+--------+--------+--------+--------+--------+------------------');

  const results = [];
  for (const c of levels) {
    const r = await runLevel(c);
    results.push(r);
    const codes = Object.entries(r.codes).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `  ${String(c).padStart(6)} | ${r.rps.toFixed(0).padStart(6)} | ${r.p50.toFixed(0).padStart(6)} | ` +
      `${r.p95.toFixed(0).padStart(6)} | ${r.p99.toFixed(0).padStart(6)} | ` +
      `${(r.errorRate * 100).toFixed(1).padStart(5)}% | ${codes}`,
    );
    if (r.errorRate > MAX_ERROR_RATE) {
      console.log(`\n  ОСТАНОВ: доля ошибок ${(r.errorRate * 100).toFixed(1)}% превысила порог ${MAX_ERROR_RATE * 100}%`);
      break;
    }
    if (r.p95 > MAX_P95_MS) {
      console.log(`\n  ОСТАНОВ: p95 ${r.p95.toFixed(0)} мс превысил порог ${MAX_P95_MS} мс`);
      break;
    }
    await new Promise((res) => setTimeout(res, 3000)); // дать серверу выдохнуть
  }

  const best = results.reduce((a, b) => (b.errorRate <= MAX_ERROR_RATE && b.rps > a.rps ? b : a), results[0]);
  console.log(`\n  Пик без деградации: ~${best.rps.toFixed(0)} запросов/с при ${best.concurrency} параллельных (p95 ${best.p95.toFixed(0)} мс)`);
})();
