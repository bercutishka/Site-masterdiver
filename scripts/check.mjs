#!/usr/bin/env node
/**
 * Быстрая локальная проверка перед пушем — не требует установки зависимостей.
 *   - синтаксис воркера (ESM)
 *   - wrangler.jsonc: валидный JSON(C) и есть main + assets
 *   - index.html на месте и нетривиальный
 *   - синтаксис встроенного в index.html скрипта
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let failed = 0;
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => { console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); failed++; };

// 1. worker.js — синтаксис ESM
try {
  const src = readFileSync('src/worker.js', 'utf8');
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: src });
  ok('src/worker.js — синтаксис ESM');
} catch (e) {
  bad('src/worker.js — ошибка синтаксиса: ' + (e.stderr?.toString() || e.message));
}

// 2. wrangler.jsonc — JSONC + обязательные поля
try {
  const raw = readFileSync('wrangler.jsonc', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const cfg = JSON.parse(raw);
  if (cfg.main === 'src/worker.js') ok('wrangler.jsonc — main → src/worker.js');
  else bad('wrangler.jsonc — main должен быть "src/worker.js", сейчас: ' + cfg.main);
  if (cfg.assets?.binding === 'ASSETS') ok('wrangler.jsonc — assets binding ASSETS');
  else bad('wrangler.jsonc — нет assets.binding "ASSETS"');
} catch (e) {
  bad('wrangler.jsonc — невалидный JSONC: ' + e.message);
}

// 3. index.html — существует и нетривиальный
try {
  const html = readFileSync('index.html', 'utf8');
  if (html.length > 1000 && html.includes('<html')) ok('index.html — на месте (' + Math.round(html.length / 1024) + ' КБ)');
  else bad('index.html — выглядит пустым/битым');

  // 4. синтаксис последнего <script> в index.html (логика приложения)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length) {
    execFileSync(process.execPath, ['--check'], { input: scripts.at(-1)[1] });
    ok('index.html — встроенный скрипт без синтаксических ошибок');
  }
} catch (e) {
  bad('index.html — ошибка: ' + (e.stderr?.toString() || e.message));
}

// 5. пререндер актуален (сгенерированные blog/<slug>/index.html совпадают с posts)
try {
  const { generate } = await import('./prerender.mjs');
  const pages = generate();
  const stale = pages.filter(([rel, content]) => {
    let cur = null; try { cur = readFileSync(rel, 'utf8'); } catch {}
    return cur !== content;
  }).map(([rel]) => rel);
  if (stale.length) bad('пререндер устарел (' + stale.length + ') — запусти `npm run build`');
  else ok('пререндер актуален (' + pages.length + ' статей)');
} catch (e) {
  bad('пререндер — ошибка: ' + e.message);
}

console.log('');
if (failed) { console.log(`\x1b[31mПроверка не пройдена: ${failed} ошибок\x1b[0m`); process.exit(1); }
console.log('\x1b[32mВсе проверки пройдены\x1b[0m');
