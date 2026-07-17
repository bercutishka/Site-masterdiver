# CLAUDE.md — проект «Глубже» (Site-masterdiver)

Памятка для агента. Цель — не разбирать архитектуру заново каждую сессию.
Держи этот файл в актуальном состоянии: меняешь поведение/структуру — правишь и здесь.

## Что это

Личный сайт-блог про дайвинг (Павел Смотров). Лендинг + блог + логбук + поиск
бади. Язык интерфейса — русский. Хостинг фронтенда — GitHub Pages, бэкенд —
Cloudflare Worker, данные — Airtable, контактная форма — Formspree.

Прод: https://bercutishka.github.io/Site-masterdiver/
Воркер: https://glubzhe-buddy.bercutishka.workers.dev

## Структура репозитория

| Файл | Что это |
|------|---------|
| `index.html` | **Весь фронтенд в одном файле (~160 КБ).** SPA: данные в JS-массивах, стили в одном `<style>`. Фото вынесены в `img/` (раньше были base64; остались только мелкие SVG-иконки инлайн). |
| `img/` | Фотографии сайта (hero, галерея, about) — вынесены из base64 в отдельные `.jpg` с `loading="lazy"` (кроме hero). Раздаются как статика. |
| `blog/<slug>/index.html`, `spots/<slug>/index.html`, `blog/index.html` | **Сгенерированные** пререндер-страницы статей, спотов и листинга блога (мета + текст + JSON-LD в статике). Делает `npm run build` (`scripts/prerender.mjs`) из массивов `posts`/`spots`. Коммитятся; Pages раздаёт. Воркеру не отдаём (в `.assetsignore`: `blog`, `spots`). |
| `scripts/prerender.mjs` | Генератор пререндер-страниц + `sitemap.xml`. Статьи получают `og:type=article`, `article:published_time`, JSON-LD `BlogPosting`. Экспортирует `generate()` — её же использует `npm run check` для проверки актуальности. |
| `test/worker.test.mjs` | Юнит-тесты воркера (`validateBuddyPayload`, `atQuery`). Запуск: `npm test`. |
| `src/worker.js` | Cloudflare Worker (ESM). API Airtable + раздача статики. |
| `wrangler.jsonc` | Конфиг воркера. `main` → `src/worker.js`, `assets.directory: "."` раздаёт статику, `binding: "ASSETS"`. |
| `og-cover.jpg` | Картинка превью для соцсетей (1200×630 в идеале; сейчас переиспользовано фото с сайта). |
| `robots.txt`, `sitemap.xml` | SEO. |
| `404.html` | Редирект для deep-link на GitHub Pages: ловит прямой заход на `/blog/<slug>`, сохраняет путь в sessionStorage и возвращает в SPA. |
| `.assetsignore` | **Критично для деплоя.** `assets.directory: "."` иначе грузит в Cloudflare весь репозиторий (включая `node_modules` → деплой падает на `Asset too large`). Этот файл исключает всё, что не статика. |
| `.dev.vars.example` | Шаблон локальных секретов для `wrangler dev`. Реальный `.dev.vars` в .gitignore. |

## Архитектура фронтенда (index.html)

- **SPA-роутинг** через `go(id)` — переключает `display` у `<div class="page" id="page-XXX">`.
  Страницы: `home, logbook, blog, article, spots, spot-detail, gallery, about, buddy, book`.
- **History API (deep-link).** `go/openArticle/openSpot` делают `history.pushState` и обновляют
  `<title>` + canonical/og:url (`setMeta`). `popstate` → `routeFromLocation()` восстанавливает экран.
  URL статей/спотов: `/blog/<slug>`, `/spots/<slug>`, где slug — транслит заголовка (`slugify`).
  `BASE` определяется автоматически (на github.io — `/Site-masterdiver/`, иначе `/`).
  Прямые ссылки на GitHub Pages ловит `404.html` (редиректит в SPA через sessionStorage);
  на workers.dev — `assets.not_found_handling: "single-page-application"`.
  Все обработчики принимают `{noHistory:true}`, чтобы не писать в историю при восстановлении.
- **Строки в файле очень длинные** (данные статей/спотов). Инструмент Read падает на больших
  кусках — читай маленькими `limit` или через `grep`/`sed -n`.
- ⚠️ **Порядок инициализации (TDZ).** Весь JS — один классический `<script>`. `function`
  поднимаются, `let/const` — нет (до строки объявления — temporal dead zone). Необработанный
  краш на верхнем уровне обрывает ВСЮ инициализацию ниже (навигация/чат/загрузчики умирают
  разом). Все стартовые вызовы держи в конце скрипта, после объявлений. `npm run check` ловит
  только синтаксис — старт проверяй в браузере (`chrome --headless --dump-dom`, считать
  карточки: норма 12 статей + 4 спота). Был инцидент: `renderBlog('Все')` до `let
  activeBlogFilter` → ReferenceError → «чат молчит, заявки бади не приходят». См. README.
- Контент рендерится из массивов: `courses, posts(blog), spots, reviews`. Логбук/бади/статистика
  тянутся живьём с воркера через `fetch`.
- Чат-бот — **оффлайн, по ключевым словам** (`botReply`), без LLM. Это сознательный выбор.
- Хелперы безопасности: `esc()` (экранирование), `cleanTgHandle()` (валидация Telegram).

### Известные нерешённые задачи фронтенда (приоритет сверху вниз)
1. ✅ **History API / URL для страниц** — СДЕЛАНО (deep-link, «Назад», свой URL/title на статью).
   Остаётся ограничение GitHub Pages: прямой заход отдаёт HTTP 404 (через `404.html`-редирект),
   поэтому боты-превью без JS (соцсети) не видят og-теги статьи. Решается пререндером (п.2).
2. ✅ Пререндер статей — СДЕЛАНО: `npm run build` (scripts/prerender.mjs) генерирует
   `blog/<slug>/index.html` с мета-тегами и текстом статьи; коммитятся в репо, Pages раздаёт.
   `npm run check` проверяет их актуальность. Ограничение: при изменении статьи нужно
   пересобрать (`npm run build`) и закоммитить.
3. ✅ Вынести base64-картинки в файлы — СДЕЛАНО: 8 фото в `img/`, `index.html` 1.2 МБ → ~160 КБ.
4. ✅ Доступность — СДЕЛАНО: `aria-expanded`/`aria-controls` на бургере (`toggleNav`),
   `role="log"`+`aria-live` в чате, `role="dialog"`+`aria-hidden` на панели, перевод фокуса
   на заголовок экрана в `go()` (флаг `navReady`, чтобы не уводить фокус при первой загрузке).
5. Аналитика — не подключена.

## Бэкенд: Cloudflare Worker (src/worker.js)

Один воркер обслуживает И API, И статику. Логика в `fetch()`: если есть `?action=` или метод POST —
это API; иначе `env.ASSETS.fetch(request)`.

⚠️ **`run_worker_first: true` в `assets` обязателен.** Иначе Cloudflare отдаёт статику ПЕРВОЙ:
запрос `/?action=stats` совпадает с `index.html` (путь `/`), и воркер не запускается (GET → HTML,
POST → 405). API живёт на корневом пути с query-параметрами, поэтому воркер должен идти первым,
а статику отдавать сам через `env.ASSETS.fetch`.

### API-контракт (его ждёт фронтенд — не ломать формат ответов)
| Запрос | Ответ | Источник |
|--------|-------|----------|
| `GET ?action=active` | `{records:[{fields:{Name,Level,Location,About,Telegram}}]}` | Buddies, `Approved=1 AND Status="Ищет бади"` |
| `GET ?action=archive` | `{records:[{fields:{Name,BuddyName,Location,TripDate,TripStory}}]}` | Buddies, `Status="Нашёл бади"` |
| `GET ?action=logbook&limit=N` | `{records:[{fields:{...}}]}` | Dives, `Published=1`, sort DiveNumber desc |
| `GET ?action=stats` | `{ключ:значение,...}` (напр. `{dive_count,dive_goal}`) | Settings (Key/Value) |
| `GET ?action=health` | `{ok,version,has_token,notify}` — версия воркера + статус последнего письма. Менять `VERSION` при правках воркера! | — |
| `POST /` (JSON: Name,Telegram,Level,Location,About) | `{id}` 201 / `{error}` | создаёт заявку бади |

### ⚠️ Уведомления о заявках бади — шлёт ВОРКЕР, не Airtable
После успешного создания записи воркер сам шлёт письмо владельцу через
Formspree (`buildBuddyNotification`/`notifyNewBuddy`, `ctx.waitUntil`, ошибка
письма не роняет заявку). Так сделано потому, что автоматизация Airtable живёт
вне репозитория и уже молча отваливалась («заявки есть, писем нет» — инцидент
июль 2026). НЕ переносить уведомления обратно в Airtable-автоматизации.
Лимит бесплатного Formspree 50 писем/мес (общий с контактной формой).

### Защита (уже в коде)
Фильтр модерации `Approved=1`, серверная валидация полей, лимиты длины, honeypot (`_hp`),
rate-limit (нативный Cloudflare Rate Limiting binding `BUDDY_RATE_LIMIT` в `wrangler.jsonc`,
5 заявок/60 c по IP, консистентен между изолятами; откат на in-memory локально),
read-эндпоинты только GET (иначе 405), CORS только `https://bercutishka.github.io`.

### Секрет
`env.AIRTABLE_TOKEN` — Airtable Personal Access Token. Задаётся в Cloudflare:
Workers → glubzhe-buddy → Settings → Variables and Secrets (тип **Secret**).
Локально — в `.dev.vars` (см. `.dev.vars.example`).

## Airtable (данные)

Доступ есть через Airtable MCP — можно читать/писать схему и записи напрямую.

| База | ID | Таблица (ID) | Назначение |
|------|----|----|-----------|
| Glubzhe_Base | `appNiVAITJeCbNs4Y` | Buddies (`tblcO2vomq30JfBwn`) | Заявки бади |
| Глубже — Логбук | `appLyPznVpbWD6cfX` | Dives (`tblZNWL0FrvHMyQ4Z`) | Погружения |
| Глубже — Настройки | `appkFcxA5bqDJYl67` | Settings (`tblOVx4OxYJNjdXRG`) | Key/Value статистика |

**Buddies** поля: Name, Telegram, Level (singleSelect-логика на стороне формы),
Location, About, `Approved` (checkbox — гейт публикации/модерация),
`Status` (singleSelect: «Ищет бади» / «Нашёл бади»), BuddyName, TripStory, TripDate,
`Created` (формула `CREATED_TIME()`).

**Dives**: Place, Location, Date, DiveNumber, Depth, Duration, Visibility, Notes, `Published` (checkbox).
**Settings**: Key, Value, Note.

⚠️ Менять боевые данные/схему Airtable — только с явного согласия пользователя.

## Деплой

- **Фронтенд** → GitHub Pages, автоматически с `main`. Pages раздаёт файлы как есть
  (build не запускает), поэтому пререндер-страницы статей **коммитятся** в репо.
  Менял `posts` → прогони `npm run build` и закоммить `blog/` (иначе `npm run check` ругнётся).
- **Воркер** → Cloudflare через GitHub-интеграцию (GitHub App «Cloudflare Workers and Pages»).
  Билд-команда `npx wrangler deploy`. Деплоит при мердже в `main`.
  Cloudflare Build сам делает `npm install` → появляется `node_modules`. Поэтому
  `assets.directory: "."` ОБЯЗАТЕЛЬНО должен сопровождаться `.assetsignore`, иначе
  деплой падает на `Asset too large` (большие файлы из `node_modules`).
- Локальная проверка перед пушем: `npm run check` (синтаксис) и `npm run deploy:dry` (dry-run wrangler).

## Рабочий процесс (важно)

- **Ветка разработки:** `claude/website-analysis-recommendations-33ap6n`. Разрабатывай тут,
  PR в `main`. Не пушить в `main` напрямую.
- Коммиты осмысленные, на русском.
- PR создавать только по явной просьбе пользователя.
- Перед пушем правок воркера — прогнать `npm run check`.
- Хочешь увидеть сайт локально: `npm run dev` (wrangler) или `python3 -m http.server`.

## Команды

```bash
npm install          # поставить wrangler (нужно для dev/deploy)
npm run check        # синтаксис воркера + index.html + актуальность пререндера (без установки)
npm test             # юнит-тесты воркера (node:test, без установки)
npm run build        # сгенерировать пререндер: статьи, споты, листинг блога, sitemap
npm run smoke        # smoke БОЕВОГО пайплайна: Pages + все API + honeypot/422/405
npm run dev          # локальный запуск воркера (нужен .dev.vars с AIRTABLE_TOKEN)
npm run deploy:dry   # wrangler deploy --dry-run, проверка конфига без деплоя
```

## ⚠️ Smoke после деплоя (обязательный ритуал)

После каждого мержа в `main` (деплоятся и воркер, и Pages) — прогнать
`npm run smoke`. При жалобе «чат молчит / заявки не приходят / нет писем» —
он же первым делом, затем `npm run smoke -- --full` (создаёт НАСТОЯЩУЮ
тестовую заявку «ТЕСТ smoke» + письмо; напомнить пользователю удалить запись).
Чек-лист диагностики писем — README, «Если не приходят письма о заявках».
История инцидентов: (1) TDZ-краш init — форма недостижима; (2) автоматизация
Airtable молча умерла — записи создавались, письма не шли (лечение: уведомления
перенесены в воркер).
