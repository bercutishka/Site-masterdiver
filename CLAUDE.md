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
| `index.html` | **Весь фронтенд в одном файле (~1.2 МБ).** SPA: данные в JS-массивах, стили в одном `<style>`, картинки вшиты как base64 data-URI. |
| `src/worker.js` | Cloudflare Worker (ESM). API Airtable + раздача статики. |
| `wrangler.jsonc` | Конфиг воркера. `main` → `src/worker.js`, `assets.directory: "."` раздаёт статику, `binding: "ASSETS"`. |
| `og-cover.jpg` | Картинка превью для соцсетей (1200×630 в идеале; сейчас переиспользовано фото с сайта). |
| `robots.txt`, `sitemap.xml` | SEO. |
| `.assetsignore` | **Критично для деплоя.** `assets.directory: "."` иначе грузит в Cloudflare весь репозиторий (включая `node_modules` → деплой падает на `Asset too large`). Этот файл исключает всё, что не статика. |
| `.dev.vars.example` | Шаблон локальных секретов для `wrangler dev`. Реальный `.dev.vars` в .gitignore. |

## Архитектура фронтенда (index.html)

- **SPA-роутинг** через `go(id)` — переключает `display` у `<div class="page" id="page-XXX">`.
  Страницы: `home, logbook, blog, article, spots, spot-detail, gallery, about, buddy, book`.
- **Строки в файле очень длинные** (данные статей/спотов). Инструмент Read падает на больших
  кусках — читай маленькими `limit` или через `grep`/`sed -n`.
- Контент рендерится из массивов: `courses, posts(blog), spots, reviews`. Логбук/бади/статистика
  тянутся живьём с воркера через `fetch`.
- Чат-бот — **оффлайн, по ключевым словам** (`botReply`), без LLM. Это сознательный выбор.
- Хелперы безопасности: `esc()` (экранирование), `cleanTgHandle()` (валидация Telegram).

### Известные нерешённые задачи фронтенда (приоритет сверху вниз)
1. **History API / URL для страниц** — сейчас `go()` не трогает адрес: нет deep-link на статьи,
   не работает «Назад», SEO видит один URL. Самая ценная доработка.
2. Контент не в статическом HTML → плохо индексируется. Пререндер или вынос статей.
3. Вынести base64-картинки в файлы (вес страницы).
4. Доступность: `aria-expanded` на бургере, `aria-live` в чате, перевод фокуса в `go()`.

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
| `POST /` (JSON: Name,Telegram,Level,Location,About) | `{id}` 201 / `{error}` | создаёт заявку бади |

### Защита (уже в коде)
Фильтр модерации `Approved=1`, серверная валидация полей, лимиты длины, honeypot (`_hp`),
rate-limit 5 запросов/10 мин по IP, CORS только `https://bercutishka.github.io`.

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

- **Фронтенд** → GitHub Pages, автоматически с `main`.
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
npm run check        # синтаксис воркера + базовая проверка index.html (без установки)
npm run dev          # локальный запуск воркера (нужен .dev.vars с AIRTABLE_TOKEN)
npm run deploy:dry   # wrangler deploy --dry-run, проверка конфига без деплоя
```
