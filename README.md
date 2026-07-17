# Глубже — Site-masterdiver

Личный сайт-блог про дайвинг (Павел Смотров): лендинг, блог с разборами аварий,
открытый логбук погружений, поиск напарника-бади и контактная форма.
Интерфейс на русском.

- **Прод (сайт):** https://bercutishka.github.io/Site-masterdiver/
- **API / воркер:** https://glubzhe-buddy.bercutishka.workers.dev

> Для агента (Claude Code) рабочая памятка с правилами и приоритетами задач — в [`CLAUDE.md`](./CLAUDE.md).
> Этот README — общее описание архитектуры и взаимосвязей.

---

## Содержание

- [Архитектура в одном взгляде](#архитектура-в-одном-взгляде)
- [Структура репозитория](#структура-репозитория)
- [Фронтенд](#фронтенд-indexhtml)
- [Бэкенд: Cloudflare Worker](#бэкенд-cloudflare-worker-srcworkerjs)
- [Данные: Airtable](#данные-airtable)
- [Потоки данных по фичам](#потоки-данных-по-фичам)
- [Все взаимосвязи (карта зависимостей)](#все-взаимосвязи-карта-зависимостей)
- [Деплой](#деплой)
- [Локальная разработка](#локальная-разработка)
- [Безопасность](#безопасность)
- [Дорожная карта](#дорожная-карта)

---

## Архитектура в одном взгляде

Три внешних сервиса + один статический файл фронтенда. Воркер — единая точка:
он и отдаёт статику, и проксирует API к Airtable.

```
                    ┌─────────────────────────────────────────────┐
                    │  Браузер пользователя                        │
                    │  index.html (SPA: HTML+CSS+JS в одном файле)  │
                    └───────────────┬──────────────┬───────────────┘
                                    │              │
              статика + API (fetch) │              │ POST контактной формы
                                    ▼              ▼
        ┌───────────────────────────────┐   ┌──────────────┐
        │ Cloudflare Worker             │   │  Formspree    │ → e-mail
        │ glubzhe-buddy                 │   │ /f/xykagdvo   │   владельцу
        │  • GET ?action=... → API      │   └──────────────┘
        │  • POST / → заявка бади         │
        │  • иначе → env.ASSETS (статика)│   ┌──────────────┐
        │                               │   │  Telegram     │ ← прямые
        └───────────────┬───────────────┘   │ @divemaster_… │   контакты
                        │ REST + Bearer                     └──────────────┘
                        ▼
        ┌───────────────────────────────┐
        │ Airtable (3 базы)             │
        │  • Buddies (заявки бади)       │
        │  • Dives   (логбук)            │
        │  • Settings(статистика k/v)    │
        └───────────────────────────────┘
```

Важная деталь: **сайт физически отдаётся с двух мест** — с GitHub Pages
(`bercutishka.github.io`, основной прод) и с самого воркера через `env.ASSETS`
(на домене `workers.dev`). Контент один и тот же (`index.html`), но за живыми
данными фронтенд всегда ходит на воркер.

---

## Структура репозитория

| Файл | Что это |
|------|---------|
| `index.html` | **Весь фронтенд в одном файле (~160 КБ).** SPA: данные в JS-массивах, стили в одном `<style>`. Фото вынесены в `img/` (остались только мелкие SVG-иконки инлайн). |
| `img/` | Фотографии сайта (hero, галерея, about) — отдельные `.jpg`, `loading="lazy"` (кроме hero). |
| `blog/<slug>/`, `spots/<slug>/`, `blog/` | Сгенерированные пререндер-страницы статей, спотов и листинга блога (мета + JSON-LD + текст в статике, для SEO/превью). `npm run build`; коммитятся; GitHub Pages раздаёт. |
| `scripts/prerender.mjs` | Генератор пререндер-страниц и `sitemap.xml` из `posts`/`spots`. |
| `test/worker.test.mjs` | Юнит-тесты воркера (`npm test`). |
| `src/worker.js` | Cloudflare Worker (ESM). API к Airtable + раздача статики. |
| `wrangler.jsonc` | Конфиг воркера: `main` → `src/worker.js`, `assets` (`binding: ASSETS`, `run_worker_first`, `not_found_handling`), нативный rate-limit (`unsafe.bindings` → `BUDDY_RATE_LIMIT`). |
| `404.html` | Редирект для deep-link на GitHub Pages: ловит прямой заход на `/blog/<slug>`, кладёт путь в `sessionStorage` и возвращает в SPA. |
| `og-cover.jpg` | Превью для соцсетей (сейчас переиспользовано фото с сайта; идеал — 1200×630). |
| `robots.txt`, `sitemap.xml` | SEO. |
| `.assetsignore` | **Критично для деплоя.** При `assets.directory: "."` исключает из загрузки в Cloudflare `node_modules`, исходники и конфиги. Без него деплой падает на `Asset too large`. |
| `.dev.vars.example` | Шаблон локального секрета `AIRTABLE_TOKEN` для `wrangler dev`. Реальный `.dev.vars` в `.gitignore`. |
| `package.json` / `scripts/check.mjs` | npm-скрипты (`check`, `test`, `build`, `dev`, `deploy:dry`, `deploy`) и быстрая локальная проверка без установки зависимостей. |
| `CLAUDE.md` | Памятка для агента: архитектура, правила, приоритеты задач. |
| `.claude/` | Настройки агента (allowlist команд) и SessionStart-хук с ориентацией по проекту. |

---

## Фронтенд (`index.html`)

Одностраничное приложение. Всё в одном файле: данные, разметка, стили, логика
(фото вынесены в `img/`).

- **SPA-роутинг** — функция `go(id)` переключает `display` у `<div class="page" id="page-XXX">`.
  Экраны: `home, logbook, blog, article, spots, spot-detail, gallery, about, buddy, book`.
- **Deep-link через History API:**
  - `go / openArticle / openSpot` делают `history.pushState`, обновляют `<title>`, `canonical` и `og:url` (хелпер `setMeta`).
  - `popstate` → `routeFromLocation()` восстанавливает экран по адресу (работают «Назад/Вперёд»).
  - URL: статьи `/blog/<slug>`, споты `/spots/<slug>`, разделы `/blog`, `/about`, …
  - `slug` — транслитерация заголовка (`slugify`), напр. `den-kogda-moya-naparnica-poteryala-soznanie-pod-vodoy`.
  - `BASE` определяется автоматически: на `github.io` → `/Site-masterdiver/`, иначе `/`.
  - Прямые ссылки: на GitHub Pages их ловит `404.html`; на `workers.dev` — `not_found_handling: single-page-application`.
- **Контент** рендерится из JS-массивов: `posts` (блог), `spots`, `reviews`, `incidents`, `courses`.
  Логбук, бади, статистика, архив пар — тянутся **живьём** с воркера через `fetch`.
- **Чат-бот** — оффлайн, по ключевым словам (`botReply`), без LLM. Сознательный выбор: работает всегда и без сервера.
- **Хелперы безопасности:** `esc()` (экранирование HTML), `cleanTgHandle()` (валидация Telegram-хэндла).

### ⚠️ Порядок инициализации (единый скрипт → TDZ)

Весь JS — один классический `<script>` в общей области видимости. `function`-объявления
поднимаются (hoisting) и доступны из любой точки, **но `let`/`const` — нет**: до своей
строки объявления переменная в *temporal dead zone* (TDZ), и обращение к ней бросает
`ReferenceError`. Такой необработанный краш на верхнем уровне **обрывает всю инициализацию
ниже** — и «мёртвыми» становятся сразу много фич (навигация, чат, загрузчики, роутинг).

Правило: **весь стартовый код, который что-то запускает, держим в самом конце скрипта** —
после всех объявлений `let/const`. Стартовые вызовы рендера (`renderSpots('Все')`,
`renderBlog('Все')`) стоят перед routing-IIFE в конце файла именно поэтому.

> Реальный инцидент (июль 2026): `renderBlog('Все')` вызвали в начале скрипта, а он
> использует `let activeBlogFilter`, объявленный ниже, → `ReferenceError` по TDZ →
> оборвалась инициализация → `navReady` в TDZ → `go()` падал → навигация не работала
> (не дойти до формы бади, заявки не отправлялись); `chatHistory`/`suggestions` в TDZ →
> чат-помощник падал. Симптомы — «чат молчит, заявки не приходят», а причина одна.

**`npm run check` ловит только синтаксис, не runtime-краш инициализации.** Проверять
старт нужно в браузере. Быстрый способ без интерактива — сравнить DOM после выполнения JS:

```bash
python3 -m http.server 8877 &     # раздать репозиторий
/opt/pw-browsers/chromium-*/chrome-linux/chrome --headless=new --no-sandbox \
  --virtual-time-budget=8000 --dump-dom http://127.0.0.1:8877/index.html > /tmp/dom.html
# убрать <script>…</script> и посчитать карточки: если блог-листинг пуст (0 статей) —
# инициализация оборвалась. Норма: 12 карточек статей, 4 спота.
```

---

## Бэкенд: Cloudflare Worker (`src/worker.js`)

Один воркер обслуживает **и API, и статику**. Решение в `fetch()`:
есть `?action=` или метод `POST` → это API; иначе → `env.ASSETS.fetch(request)` (статика).
Read-эндпоинты принимают только `GET` (прочие методы → `405`), создание — только `POST`.

> ⚠️ В `wrangler.jsonc` обязателен `run_worker_first: true`. Иначе Cloudflare отдаёт
> статику первой: запрос `/?action=stats` совпадает с `index.html` (путь `/`) и воркер
> не запускается. API живёт на корневом пути с query-параметрами, поэтому воркер должен
> идти первым, а статику отдавать сам через `env.ASSETS`.

### API-контракт (формат ответов фронтенд ждёт — не ломать)

| Запрос | Ответ | Источник в Airtable | Фильтр |
|--------|-------|---------------------|--------|
| `GET ?action=active` | `{records:[{fields:{Name,Level,Location,About,Telegram}}]}` | Buddies | `Approved=1 AND Status="Ищет бади"` |
| `GET ?action=archive` | `{records:[{fields:{Name,BuddyName,Location,TripDate,TripStory}}]}` | Buddies | `Status="Нашёл бади"` |
| `GET ?action=logbook&limit=N` | `{records:[{fields:{...}}]}` | Dives | `Published=1`, sort `DiveNumber` desc |
| `GET ?action=stats` | `{ключ:значение,...}` (напр. `dive_count`, `dive_goal`, `cert_level`) | Settings | — |
| `GET ?action=health` | `{ok,version,has_token,notify}` — версия задеплоенного воркера и статус последней отправки письма (диагностика, работает даже без токена) | — | — |
| `POST /` (JSON `Name,Telegram,Level,Location,About`) | `{id}` 201 / `{error}` | Buddies (создание) | приходит неодобренной |

Запросы к Airtable собираются хелпером `atQuery` в нужном формате
(`fields[]=…`, `sort[0][field]=…`, пробелы как `%20`).

### Секрет

`env.AIRTABLE_TOKEN` — Airtable Personal Access Token (Bearer). Задаётся в Cloudflare:
**Workers → glubzhe-buddy → Settings → Variables and Secrets** (тип **Secret**).
Локально — в `.dev.vars` (см. `.dev.vars.example`). Нужны scopes
`data.records:read` + `data.records:write` и доступ ко всем трём базам.

---

## Данные: Airtable

| База | ID | Таблица (ID) | Назначение |
|------|----|----|-----------|
| Glubzhe_Base | `appNiVAITJeCbNs4Y` | Buddies (`tblcO2vomq30JfBwn`) | Заявки на поиск бади |
| Глубже — Логбук | `appLyPznVpbWD6cfX` | Dives (`tblZNWL0FrvHMyQ4Z`) | Погружения |
| Глубже — Настройки | `appkFcxA5bqDJYl67` | Settings (`tblOVx4OxYJNjdXRG`) | Key/Value статистика |

**Buddies:** `Name`, `Telegram`, `Level`, `Location`, `About`,
`Approved` (checkbox — гейт публикации/модерация),
`Status` (singleSelect: «Ищет бади» / «Нашёл бади»),
`BuddyName`, `TripStory`, `TripDate`, `Created` (формула `CREATED_TIME()`).

**Dives:** `Place`, `Location`, `Date`, `DiveNumber`, `Depth`, `Duration`,
`Visibility`, `Notes`, `Published` (checkbox).

**Settings:** `Key`, `Value`, `Note`.

> ⚠️ Боевые данные/схему Airtable менять только с явного согласия владельца.

---

## Потоки данных по фичам

**Статистика на главной.** `loadStats()` → `GET ?action=stats` → воркер читает
Settings → `{dive_count, dive_goal, cert_level}` → фронт рисует счётчик и прогресс-бар.

**Логбук.** `renderLogbookPreview()` (главная, 3 записи) и `renderLogbookFull()`
(страница «Логбук») → `GET ?action=logbook[&limit=N]` → воркер читает Dives с
`Published=1` → карточки погружений.

**Поиск бади (чтение).** `renderBuddyList()` → `GET ?action=active` (только
`Approved=1 AND Status="Ищет бади"`); `renderPairs()` → `GET ?action=archive`
(`Status="Нашёл бади"`). Поля экранируются `esc()` перед вставкой.

**Поиск бади (заявка).** Форма → `submitBuddy()` (клиентская валидация + honeypot)
→ `POST /` → воркер (серверная валидация, лимиты длины, honeypot `_hp`, rate-limit)
→ создаёт запись в Buddies **без `Approved`** (ждёт ручной модерации) → `{id}`.

**Уведомление о новой заявке (e-mail).** Письмо владельцу шлёт **сам воркер**:
после успешного создания записи он отправляет `POST` на Formspree
(`buildBuddyNotification` → `notifyNewBuddy`, через `ctx.waitUntil` — ошибка
письма не роняет заявку). ⚠️ Уведомление **сознательно не** завязано на
автоматизацию Airtable: она живёт вне репозитория, её не видно из кода и она
уже молча отваливалась («заявки есть, писем нет»). Не переносить обратно.
Лимит бесплатного Formspree — 50 писем/мес на форму (делится с контактной формой).

**Контактная форма.** `submitForm()` → `POST https://formspree.io/f/xykagdvo`
→ письмо владельцу. Airtable/воркер не задействованы.

**Прямые контакты.** Ссылки на Telegram `@divemaster_glubzhe`.

---

## Все взаимосвязи (карта зависимостей)

| Откуда | Куда | Зачем | Связующее звено |
|--------|------|-------|-----------------|
| `index.html` (фронт) | Cloudflare Worker | живые данные + приём заявки бади | `fetch` на `workers.dev` |
| `index.html` | Formspree | контактная форма | `POST /f/xykagdvo` |
| `index.html` | Telegram | прямой контакт | ссылка `t.me/...` |
| Worker | Airtable | чтение/запись данных | REST + `Bearer AIRTABLE_TOKEN` |
| Worker | Formspree | e-mail о новой заявке бади | `POST /f/xykagdvo` (`notifyNewBuddy`) |
| Worker | статика | раздача `index.html` и ассетов | `env.ASSETS` (binding в `wrangler.jsonc`) |
| `wrangler.jsonc` | `src/worker.js` | точка входа воркера | поле `main` |
| `wrangler.jsonc` | `.assetsignore` | что НЕ грузить как статику | `assets.directory: "."` |
| GitHub `main` | GitHub Pages | деплой фронтенда | автопубликация |
| GitHub `main` | Cloudflare | деплой воркера | GitHub App «Cloudflare Workers and Pages» → `npx wrangler deploy` |
| Cloudflare Secret | Worker | токен Airtable | `env.AIRTABLE_TOKEN` |
| `404.html` | `index.html` | восстановление deep-link на Pages | `sessionStorage['spa-path']` |
| Фронт ↔ Worker | — | **жёсткий контракт ответов** | формат JSON из таблицы выше |

Точки, где «всё развалится», если поменять одну сторону, не поменяв другую:
- формат ответов API (фронт парсит конкретные поля);
- имена полей Airtable (воркер обращается по ним);
- `AIRTABLE_TOKEN` в Cloudflare (без него — 401/500 на всех API);
- `.assetsignore` (без него деплой падает);
- `run_worker_first` (без него API на `/` не доходит до воркера);
- порядок инициализации в `index.html` (стартовые вызовы — после объявлений `let/const`, иначе TDZ-краш обрывает всю инициализацию; см. раздел «Порядок инициализации»).

---

## Деплой

- **Фронтенд → GitHub Pages.** Автоматически из ветки `main`. Прямые ссылки на статьи/споты
  обслуживают **пререндер-страницы** `blog/<slug>/`, `spots/<slug>/`, `blog/` (коммитятся в
  репо — Pages собственный билд не запускает); прочие неизвестные пути ловит `404.html`.
  При изменении статей/спотов: `npm run build` → закоммитить `blog/`, `spots/`, `sitemap.xml`.
- **Воркер → Cloudflare.** Через GitHub App «Cloudflare Workers and Pages».
  Билд-команда `npx wrangler deploy`, деплой при пуше/мердже в `main`. Cloudflare Build
  сам делает `npm install` → появляется `node_modules`, поэтому `assets.directory: "."`
  **обязан** сопровождаться `.assetsignore`.
- **Перед пушем правок воркера:** `npm run check` (синтаксис) и `npm run deploy:dry` (dry-run).

---

## Локальная разработка

```bash
npm install          # поставить wrangler (для dev/deploy)
npm run build        # пререндер: статьи, споты, листинг блога, sitemap
npm test             # юнит-тесты воркера (node:test)
npm run check        # быстрая проверка без установки: синтаксис воркера и
                     # встроенного скрипта index.html, валидность wrangler.jsonc
npm run smoke        # smoke-проверка БОЕВОГО пайплайна (Pages + API воркера)
npm run dev          # локальный воркер (нужен .dev.vars с AIRTABLE_TOKEN)
npm run deploy:dry   # wrangler deploy --dry-run — проверка конфига без деплоя
```

### Smoke-проверка прода (`npm run smoke`)

Быстрый режим ничего не создаёт и не шлёт: Pages отдаёт сайт, GET-эндпоинты
живы (значит и токен Airtable жив), honeypot отбивает ботов (200), валидация
работает (422), методы гейтятся (405). **Запускать после каждого мержа в
`main`** (задеплоились и воркер, и Pages) и первым делом при любой жалобе
«не работает».

Полный прогон — `npm run smoke -- --full` — дополнительно отправляет
**настоящую** тестовую заявку: создаёт запись «ТЕСТ smoke» в Buddies и шлёт
письмо на почту. После него проверь письмо и удали тестовую запись при
модерации.

### Если не приходят письма о заявках — чек-лист

1. `npm run smoke` — если что-то красное, чинить сначала это.
2. `npm run smoke -- --full` — создаёт настоящую заявку:
   - **201 + письмо пришло** → всё работает; предыдущая заявка могла попасть в спам.
   - **201, письма нет** → смотреть Formspree: лимит 50 писем/мес исчерпан?
     (дэшборд formspree.io, форма `xykagdvo`) Письмо в спаме?
   - **не 201** → запись не создаётся: токен Airtable (Cloudflare → Workers →
     glubzhe-buddy → Variables and Secrets), его scopes (`data.records:write`)
     и доступ к базе Glubzhe_Base.
3. Записи в Buddies появляются, но smoke-письмо дошло → значит сломан был
   старый канал (автоматизация Airtable) — уведомления теперь шлёт воркер,
   автоматизацию можно выключить, чтобы не дублировала.

Только фронт без воркера: `python3 -m http.server` из корня репозитория.

**Рабочий процесс:** ветка разработки `claude/website-analysis-recommendations-33ap6n`,
PR в `main`, в `main` напрямую не пушить. Коммиты осмысленные, на русском.

---

## Безопасность

- **Модерация бади:** публикуются только записи с `Approved=1`; новые заявки приходят неодобренными.
- **Серверная валидация** в воркере: формат Telegram, допустимые `Level`, лимиты длины полей.
- **Honeypot** (`_hp`) и **rate-limit** (нативный Cloudflare Rate Limiting binding, 5 заявок/60 c по IP) на приём заявок.
- **Read-эндпоинты только `GET`** (прочие методы → 405); `limit` санитизируется в [1,100].
- **CORS** воркера — только `https://bercutishka.github.io`.
- **Экранирование** пользовательских данных на фронте (`esc`) при выводе списков бади/пар.
- **Заголовки безопасности** воркера: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options` (+ `<meta name="referrer">` на фронте).
- Секрет Airtable хранится только в Cloudflare (в репозитории его нет).

---

## Дорожная карта

### Сделано
- ✅ **Deep-link через History API** — свой URL/title у статей и спотов, «Назад», шаринг.
- ✅ **Пререндер** статей, спотов и листинга блога — контент и мета в статике (SEO/превью);
  у статей JSON-LD `BlogPosting`, `og:type=article`, `article:published_time`. `sitemap.xml`
  со всеми URL. (При изменении контента — `npm run build` + коммит.)
- ✅ **Вынос base64-картинок** в `img/`: `index.html` 1.2 МБ → ~160 КБ, `loading="lazy"`,
  `width/height` (CLS), `fetchpriority` у hero.
- ✅ **Доступность** — aria на бургере и чате, перевод фокуса на заголовок экрана в `go()`.
- ✅ **Защита** — серверная валидация, honeypot, нативный rate-limit, GET-only на чтение,
  CORS, заголовки безопасности, экранирование вывода.
- ✅ **Юнит-тесты воркера** (`npm test`).

### Остаётся
- **Аналитика** — пока не подключена (отложено).
- **Данные внутри `index.html`** (`posts`/`spots`) — из-за этого `slugify` продублирован в
  `index.html` и `prerender.mjs` (риск рассинхрона). Вынос в `data/*.json` убрал бы дубль.
- **Заголовки безопасности/CSP не действуют на канонический сайт** (GitHub Pages не отдаёт
  кастомные заголовки; работают только на `workers.dev`). Полностью — только при переезде
  основного хостинга на воркер.
- **Картинки**: `og-cover.jpg` вертикальный (идеал 1200×630); формат JPEG, не WebP; есть
  дубль (`pavel-smotrov.jpg` ≡ `pered-pogruzheniem.jpg`).
- **Rate-limit** ключуется по IP клиента (нормально для реальных пользователей; за общими
  прокси/NAT — грубее).
