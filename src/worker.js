/**
 * Cloudflare Worker — glubzhe-buddy
 *
 * API эндпоинты:
 *   GET  ?action=active    — список бади (Approved=true, Status="Ищет бади")
 *   GET  ?action=archive   — архив пар (Status="Нашёл бади")
 *   GET  ?action=logbook   — погружения (Published=true), поддерживает ?limit=N
 *   GET  ?action=stats     — статистика (из таблицы Settings)
 *   POST /                 — добавить заявку бади
 *
 * Секреты Cloudflare (Variables and Secrets):
 *   AIRTABLE_TOKEN  — Bearer-токен Airtable
 */

// ── ID баз и таблиц (не секреты, можно в коде) ──────────────────────────────
const BASE_BUDDIES  = 'appNiVAITJeCbNs4Y';
const TABLE_BUDDIES = 'tblcO2vomq30JfBwn'; // таблица Buddies

const BASE_LOGBOOK  = 'appLyPznVpbWD6cfX';
const TABLE_DIVES   = 'tblZNWL0FrvHMyQ4Z'; // таблица Dives

const BASE_SETTINGS = 'appkFcxA5bqDJYl67';
const TABLE_SETTINGS = 'tblOVx4OxYJNjdXRG'; // таблица Settings

// ── Rate-limit ───────────────────────────────────────────────────────────────
// Основной механизм — нативный Rate Limiting binding Cloudflare (env.BUDDY_RATE_LIMIT,
// настроен в wrangler.jsonc): консистентен между изолятами. Если биндинг недоступен
// (локальный запуск), откатываемся на in-memory счётчик.
const rateLimitMap = new Map();

function memRateLimited(ip) {
  const now = Date.now();
  const window = 60 * 1000; // 60 c
  const max = 5;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) { rateLimitMap.set(ip, { count: 1, start: now }); return false; }
  if (entry.count >= max) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

async function isRateLimited(env, ip) {
  if (env && env.BUDDY_RATE_LIMIT) {
    const { success } = await env.BUDDY_RATE_LIMIT.limit({ key: ip });
    return !success;
  }
  return memRateLimited(ip);
}

// ── Хелперы ──────────────────────────────────────────────────────────────────
const AT_URL = 'https://api.airtable.com/v0';

async function atFetch(token, path, opts = {}) {
  const res = await fetch(`${AT_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Airtable error ${res.status}`);
  return data;
}

// Заголовки безопасности (защита «в глубину»). CSP не ставим: сайт построен на
// инлайновых скриптах/обработчиках, строгий CSP их сломает; основной хостинг —
// GitHub Pages, где заголовки всё равно не настроить.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function json(body, status = 200, cors = true) {
  const headers = { 'Content-Type': 'application/json', ...SECURITY_HEADERS };
  if (cors) headers['Access-Control-Allow-Origin'] = 'https://bercutishka.github.io';
  return new Response(JSON.stringify(body), { status, headers });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── Валидация входящих полей бади ────────────────────────────────────────────
export function validateBuddyPayload(body) {
  const { Name, Telegram, Level, Location, About } = body || {};

  if (!Name || typeof Name !== 'string' || Name.trim().length < 2)
    return 'Имя обязательно (минимум 2 символа)';

  if (!Telegram || typeof Telegram !== 'string')
    return 'Telegram обязателен';

  const handle = Telegram.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{5,32}$/.test(handle))
    return 'Telegram: только латиница, цифры, _, от 5 до 32 символов';

  const LEVELS = ['OWD', 'Advanced OWD', 'Rescue Diver', 'Divemaster', 'Инструктор'];
  if (Level && !LEVELS.includes(Level))
    return 'Недопустимое значение Level';

  if (Name.trim().length > 100)        return 'Имя слишком длинное (макс. 100 символов)';
  if (handle.length > 32)              return 'Telegram слишком длинный';
  if (Location && Location.length > 200) return 'Location слишком длинный (макс. 200)';
  if (About && About.length > 1000)    return 'About слишком длинный (макс. 1000 символов)';

  return null; // всё ок
}

// ── Уведомление владельцу о новой заявке ─────────────────────────────────────
// Письмо шлёт САМ ВОРКЕР через Formspree (тот же ящик, что у контактной формы).
// Раньше уведомление держалось на автоматизации Airtable — она живёт вне
// репозитория и молча отваливается; теперь канал в коде и покрыт smoke-тестом.
// Ошибка отправки письма НЕ роняет создание заявки (fire-and-forget).
const FORMSPREE_URL = 'https://formspree.io/f/xykagdvo';

export function buildBuddyNotification(fields, recordId) {
  return {
    _subject: `Новая заявка бади: ${fields.Name} (${fields.Telegram})`,
    message: [
      'Новая заявка на поиск бади — ждёт модерации (галочка Approved).',
      '',
      `Имя: ${fields.Name}`,
      `Telegram: ${fields.Telegram}`,
      `Уровень: ${fields.Level}`,
      `Локация: ${fields.Location || '—'}`,
      `О себе: ${fields.About || '—'}`,
      '',
      `Запись: ${recordId}`,
      `Модерация: https://airtable.com/${BASE_BUDDIES}/${TABLE_BUDDIES}`,
    ].join('\n'),
  };
}

async function notifyNewBuddy(fields, recordId) {
  try {
    const res = await fetch(FORMSPREE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildBuddyNotification(fields, recordId)),
    });
    if (!res.ok) console.error('Не ушло уведомление о заявке (Formspree):', res.status, await res.text());
  } catch (e) {
    console.error('Не ушло уведомление о заявке (Formspree):', e);
  }
}

// ── Обработчики ──────────────────────────────────────────────────────────────

// Сборка query-строки в формате, который ждёт Airtable:
//   fields[]=A&fields[]=B   sort[0][field]=X&sort[0][direction]=desc
export function atQuery({ filterByFormula, sort, fields, maxRecords } = {}) {
  const sp = new URLSearchParams();
  if (filterByFormula) sp.set('filterByFormula', filterByFormula);
  if (maxRecords != null) sp.set('maxRecords', String(maxRecords));
  if (fields) for (const f of fields) sp.append('fields[]', f);
  if (sort) sort.forEach((s, i) => {
    sp.set(`sort[${i}][field]`, s.field);
    sp.set(`sort[${i}][direction]`, s.direction || 'asc');
  });
  // URLSearchParams кодирует пробел как "+"; Airtable ждёт %20 (иначе пробел
  // в значении вроде "Ищет бади" может сломать фильтр).
  return sp.toString().replace(/\+/g, '%20');
}

async function handleGetActive(token) {
  // Только одобренные записи со статусом "Ищет бади"
  const q = atQuery({
    filterByFormula: `AND({Approved}=1, {Status}="Ищет бади")`,
    sort: [{ field: 'Created', direction: 'desc' }],
    fields: ['Name', 'Level', 'Location', 'About', 'Telegram'],
  });
  const data = await atFetch(token, `/${BASE_BUDDIES}/${TABLE_BUDDIES}?${q}`);
  return json({ records: data.records });
}

async function handleGetArchive(token) {
  // Пары, которые нашли бади
  const q = atQuery({
    filterByFormula: `{Status}="Нашёл бади"`,
    sort: [{ field: 'Created', direction: 'desc' }],
    fields: ['Name', 'BuddyName', 'Location', 'TripDate', 'TripStory'],
  });
  const data = await atFetch(token, `/${BASE_BUDDIES}/${TABLE_BUDDIES}?${q}`);
  return json({ records: data.records });
}

// Безопасный лимит: целое в [1,100], иначе дефолт 100
export function clampLimit(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 100;
}

async function handleGetLogbook(token, url) {
  const limit = clampLimit(url.searchParams.get('limit'));
  const q = atQuery({
    filterByFormula: `{Published}=1`,
    sort: [{ field: 'DiveNumber', direction: 'desc' }],
    maxRecords: limit,
    fields: ['Place', 'Location', 'Date', 'DiveNumber', 'Depth', 'Duration', 'Visibility', 'Notes'],
  });
  const data = await atFetch(token, `/${BASE_LOGBOOK}/${TABLE_DIVES}?${q}`);
  return json({ records: data.records });
}

async function handleGetStats(token) {
  const q = atQuery({ fields: ['Key', 'Value'] });
  const data = await atFetch(token, `/${BASE_SETTINGS}/${TABLE_SETTINGS}?${q}`);
  const stats = {};
  for (const rec of data.records || []) {
    const k = rec.fields?.Key;
    const v = rec.fields?.Value;
    if (k) stats[k] = v;
  }
  return json(stats);
}

async function handlePost(token, request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Honeypot: если фронт добавил поле-ловушку и бот его заполнил
  const body = await request.json().catch(() => null);
  if (!body) return err('Неверный JSON');

  if (body._hp) return json({ ok: true }); // молча отбиваем ботов

  // Rate-limit (нативный лимитер Cloudflare с откатом на in-memory)
  if (await isRateLimited(env, ip)) return err('Слишком много заявок. Попробуйте позже.', 429);

  // Валидация
  const validationError = validateBuddyPayload(body);
  if (validationError) return err(validationError, 422);

  const handle = body.Telegram.replace(/^@/, '').trim();

  const fields = {
    Name:     body.Name.trim().slice(0, 100),
    Telegram: '@' + handle,
    Level:    body.Level || 'OWD',
    Location: (body.Location || '').trim().slice(0, 200),
    About:    (body.About || '').trim().slice(0, 1000),
    // Approved: false по умолчанию — запись ждёт модерации
    Status:   'Ищет бади',
  };

  const record = await atFetch(token, `/${BASE_BUDDIES}/${TABLE_BUDDIES}`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  });

  // Письмо владельцу — после ответа клиенту, не блокируя заявку
  if (ctx) ctx.waitUntil(notifyNewBuddy(fields, record.id));
  else notifyNewBuddy(fields, record.id); // локальный запуск без ctx

  return json({ id: record.id }, 201);
}

// ── Главный обработчик запросов ───────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = env.AIRTABLE_TOKEN;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': 'https://bercutishka.github.io',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Запросы к API (есть ?action= или POST)
    const action = url.searchParams.get('action');
    const isApi = action || request.method === 'POST';

    if (isApi) {
      if (!token) return err('Не настроен AIRTABLE_TOKEN', 500);
      try {
        if (request.method === 'POST') return await handlePost(token, request, env, ctx);
        // Чтение — только GET; остальные методы не поддерживаем
        if (request.method !== 'GET') return err('Метод не поддерживается', 405);
        if (action === 'active')  return await handleGetActive(token);
        if (action === 'archive') return await handleGetArchive(token);
        if (action === 'logbook') return await handleGetLogbook(token, url);
        if (action === 'stats')   return await handleGetStats(token);
        return err('Неизвестный action', 400);
      } catch (e) {
        console.error(e);
        return err('Временная ошибка сервера, попробуйте позже', 500);
      }
    }

    // Всё остальное — статические файлы (обрабатывает Cloudflare Assets) + заголовки безопасности
    const assetRes = await env.ASSETS.fetch(request);
    const res = new Response(assetRes.body, assetRes);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
};
