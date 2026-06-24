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

// ── Rate-limit: не более 5 заявок в 10 минут с одного IP ────────────────────
const rateLimitMap = new Map(); // живёт в памяти воркера (сбрасывается при рестарте)

function isRateLimited(ip) {
  const now = Date.now();
  const window = 10 * 60 * 1000; // 10 минут
  const max = 5;
  const key = ip || 'unknown';
  const entry = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - entry.start > window) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false;
  }
  if (entry.count >= max) return true;
  entry.count++;
  rateLimitMap.set(key, entry);
  return false;
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

function json(body, status = 200, cors = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = 'https://bercutishka.github.io';
  return new Response(JSON.stringify(body), { status, headers });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── Валидация входящих полей бади ────────────────────────────────────────────
function validateBuddyPayload(body) {
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

// ── Обработчики ──────────────────────────────────────────────────────────────

// Сборка query-строки в формате, который ждёт Airtable:
//   fields[]=A&fields[]=B   sort[0][field]=X&sort[0][direction]=desc
function atQuery({ filterByFormula, sort, fields, maxRecords } = {}) {
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

async function handleGetLogbook(token, url) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 100);
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

async function handlePost(token, request) {
  const ip = request.headers.get('CF-Connecting-IP');

  // Honeypot: если фронт добавил поле-ловушку и бот его заполнил
  const body = await request.json().catch(() => null);
  if (!body) return err('Неверный JSON');

  if (body._hp) return json({ ok: true }); // молча отбиваем ботов

  // Rate-limit
  if (isRateLimited(ip)) return err('Слишком много заявок. Попробуй через 10 минут.', 429);

  // Валидация
  const validationError = validateBuddyPayload(body);
  if (validationError) return err(validationError, 422);

  const handle = body.Telegram.replace(/^@/, '').trim();

  const record = await atFetch(token, `/${BASE_BUDDIES}/${TABLE_BUDDIES}`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        Name:     body.Name.trim().slice(0, 100),
        Telegram: '@' + handle,
        Level:    body.Level || 'OWD',
        Location: (body.Location || '').trim().slice(0, 200),
        About:    (body.About || '').trim().slice(0, 1000),
        // Approved: false по умолчанию — запись ждёт модерации
        Status:   'Ищет бади',
      },
    }),
  });

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
        if (request.method === 'POST')      return await handlePost(token, request);
        if (action === 'active')            return await handleGetActive(token);
        if (action === 'archive')           return await handleGetArchive(token);
        if (action === 'logbook')           return await handleGetLogbook(token, url);
        if (action === 'stats')             return await handleGetStats(token);
        return err('Неизвестный action', 400);
      } catch (e) {
        console.error(e);
        return err('Внутренняя ошибка: ' + e.message, 500);
      }
    }

    // Всё остальное — статические файлы (обрабатывает Cloudflare Assets)
    return env.ASSETS.fetch(request);
  },
};
