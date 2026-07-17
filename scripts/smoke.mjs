#!/usr/bin/env node
/**
 * Smoke-проверка боевого пайплайна «Глубже».
 *
 *   npm run smoke          — безопасные проверки (ничего не создаёт, писем не шлёт)
 *   npm run smoke -- --full — плюс НАСТОЯЩАЯ тестовая заявка бади:
 *                             создаёт запись «ТЕСТ…» в Airtable и шлёт письмо
 *                             на почту. После прогона удали запись при модерации.
 *
 * Когда запускать: после каждого мержа в main (деплой воркера и Pages),
 * и первым делом при жалобе «чат молчит / заявки не приходят / нет писем».
 */

const WORKER = 'https://glubzhe-buddy.bercutishka.workers.dev';
const PAGES  = 'https://bercutishka.github.io/Site-masterdiver/';
const FULL   = process.argv.includes('--full');

let failed = 0;

async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗ ${name} — ${e.message}\x1b[0m`);
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('Smoke-проверка прод-пайплайна\n');

// ── Фронтенд (GitHub Pages) ──────────────────────────────────────────────────
await check('Pages: index.html отдаётся и похож на сайт', async () => {
  const r = await fetch(PAGES);
  expect(r.ok, `HTTP ${r.status}`);
  const html = await r.text();
  expect(html.length > 100_000, `подозрительно маленький (${html.length} байт)`);
  expect(html.includes('id="page-home"'), 'нет разметки SPA (id="page-home")');
  return `${Math.round(html.length / 1024)} КБ`;
});

// ── API воркера: чтение (жив ли токен Airtable, read-scope) ─────────────────
await check('GET ?action=stats → 200 + dive_count', async () => {
  const r = await fetch(`${WORKER}?action=stats`);
  expect(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  expect('dive_count' in j, `нет dive_count: ${JSON.stringify(j).slice(0, 80)}`);
  return `dive_count=${j.dive_count}`;
});

await check('GET ?action=active → 200 + records[]', async () => {
  const r = await fetch(`${WORKER}?action=active`);
  expect(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  expect(Array.isArray(j.records), 'нет массива records');
  return `${j.records.length} анкет`;
});

await check('GET ?action=logbook&limit=1 → 200 + records[]', async () => {
  const r = await fetch(`${WORKER}?action=logbook&limit=1`);
  expect(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  expect(Array.isArray(j.records), 'нет массива records');
});

// ── API воркера: приём заявок (без создания записей) ────────────────────────
await check('POST honeypot → 200 {ok} (бот отбит молча)', async () => {
  const r = await fetch(WORKER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _hp: 'bot', Name: 'x', Telegram: 'xxxxx' }),
  });
  expect(r.status === 200, `HTTP ${r.status}`);
  const j = await r.json();
  expect(j.ok === true, `ответ: ${JSON.stringify(j)}`);
});

await check('POST невалидный → 422 (серверная валидация жива)', async () => {
  const r = await fetch(WORKER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Name: '', Telegram: '' }),
  });
  expect(r.status === 422, `HTTP ${r.status}`);
});

await check('PUT ?action=stats → 405 (гейтинг методов)', async () => {
  const r = await fetch(`${WORKER}?action=stats`, { method: 'PUT' });
  expect(r.status === 405, `HTTP ${r.status}`);
});

// ── Полный прогон: настоящая заявка (запись + письмо) ───────────────────────
if (FULL) {
  await check('POST реальная ТЕСТ-заявка → 201 {id} (создаёт запись + письмо!)', async () => {
    const r = await fetch(WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Name: 'ТЕСТ smoke (удалить)',
        Telegram: '@glubzhe_test',
        Level: 'OWD',
        Location: '—',
        About: 'Автоматическая smoke-проверка пайплайна. Запись можно удалить.',
        _hp: '',
      }),
    });
    const text = await r.text(); // тело читаем один раз
    expect(r.status === 201, `HTTP ${r.status}: ${text.slice(0, 120)}`);
    const j = JSON.parse(text);
    expect(j.id, 'нет id записи');
    return `запись ${j.id}`;
  });
  console.log('\n  ⚠ Полный прогон: проверь, что ПИСЬМО пришло на почту,');
  console.log('    и удали запись «ТЕСТ smoke» в Airtable при модерации.');
}

console.log('');
if (failed) {
  console.log(`\x1b[31mПровалено проверок: ${failed}\x1b[0m`);
  console.log('Диагностика по шагам — README, раздел «Если не приходят письма о заявках».');
  process.exit(1);
}
console.log('\x1b[32mВсе проверки пройдены\x1b[0m' + (FULL ? '' : ' (быстрый режим; полный прогон: npm run smoke -- --full)'));
