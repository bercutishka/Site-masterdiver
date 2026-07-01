#!/usr/bin/env node
/**
 * Пререндер статей: генерирует blog/<slug>/index.html со статическим контентом
 * и правильными мета-тегами (title, description, og:*, canonical) — чтобы
 * прямой заход и боты-превью соцсетей видели статью без JS.
 *
 * Источник правды — массив `posts` внутри index.html (тот же, что рендерит SPA).
 * Сгенерированные страницы коммитятся в репозиторий; GitHub Pages раздаёт их как есть.
 * JS при загрузке открывает ту же статью (routeFromLocation → openArticle) — бесшовно.
 *
 *   node scripts/prerender.mjs           — сгенерировать и записать
 *   node scripts/prerender.mjs --check   — проверить актуальность (для npm run check)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const SITE = 'https://bercutishka.github.io/Site-masterdiver/';
const BASE_HREF = '/Site-masterdiver/';

// Транслитерация — ДОЛЖНА совпадать со slugify в index.html.
const T = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const slugify = (s) => (s || '').toLowerCase().split('').map(c => T[c] !== undefined ? T[c] : c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');

// SVG-иконки категорий — ДОЛЖНЫ совпадать с ICONS в index.html
const IA = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  'Безопасность': `<svg ${IA}><path d="M12 3l7 2.5v5.5c0 4.2-2.9 7.4-7 8.5-4.1-1.1-7-4.3-7-8.5V5.5z"/><path d="M9 12l2 2 4-4"/></svg>`,
  'Разбор': `<svg ${IA}><path d="M12 4.5l8.5 14.5H3.5z"/><path d="M12 10v4"/><path d="M12 16.6h.01"/></svg>`,
  'Техника': `<svg ${IA}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1"/><path d="M12 12l3.6-2"/><path d="M12 3.5v2M20.5 12h-2M12 20.5v-2M3.5 12h2"/></svg>`,
  'Снаряжение': `<svg ${IA}><circle cx="8.5" cy="12" r="3.4"/><circle cx="15.5" cy="12" r="3.4"/><path d="M11.9 12h.2"/><path d="M5.1 12H4M20 12h-1.1"/></svg>`,
  'Путешествие': `<svg ${IA}><path d="M12 21c-4-4-6.5-7-6.5-10.2A6.5 6.5 0 0 1 18.5 10.8C18.5 14 16 17 12 21z"/><circle cx="12" cy="10.8" r="2.2"/></svg>`,
  'Путь': `<svg ${IA}><path d="M6.5 21V4"/><path d="M6.5 5h10l-2 3 2 3h-10"/></svg>`,
  'История': `<svg ${IA}><circle cx="12" cy="5" r="2"/><path d="M12 7v13"/><path d="M8.5 10h7"/><path d="M5 14a7 7 0 0 0 14 0"/><path d="M5 14H3.5M19 14h1.5"/></svg>`,
};
const ICON_DEFAULT = `<svg ${IA}><path d="M12 3.5c3.8 4.6 5.8 7.6 5.8 10.3A5.8 5.8 0 0 1 6.2 13.8C6.2 11.1 8.2 8.1 12 3.5z"/></svg>`;
const catIcon = (cat) => ICONS[cat] || ICON_DEFAULT;

// «Читать дальше»: до 3 статей той же категории (добор — остальными)
function relatedHtml(p, posts) {
  let rel = posts.filter(x => x !== p && x.cat === p.cat);
  for (const x of posts) { if (rel.length >= 3) break; if (x !== p && !rel.includes(x)) rel.push(x); }
  rel = rel.slice(0, 3);
  if (!rel.length) return '';
  const cards = rel.map(r =>
    `<a class="rel-card" href="${SITE}blog/${slugify(r.title)}/"><span class="rel-ic ${r.ph}">${catIcon(r.cat)}</span><span class="rel-txt"><span class="rel-cat">${escHtml(r.cat)}</span><span class="rel-t">${escHtml(r.title)}</span></span></a>`
  ).join('');
  return '<h2 class="rel-head">Читать дальше</h2><div class="rel-grid">' + cards + '</div>';
}

// Достаёт `const <name>=[...]` балансировкой скобок с учётом строк —
// устойчиво к `]` внутри строк/кода после массива.
function extractArray(html, name) {
  const marker = 'const ' + name + '=';
  const start = html.indexOf(marker + '[');
  if (start < 0) throw new Error('не найден массив ' + name + ' в index.html');
  let i = start + marker.length; // позиция '['
  let depth = 0, q = null, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (q) { if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const lit = html.slice(start + marker.length, i);
  return new Function('return (' + lit + ')')();
}

function setMeta(html, attr, name, value) {
  const re = new RegExp('(<meta ' + attr + '="' + name + '"\\s+content=")[^"]*(")');
  return html.replace(re, (m, a, b) => a + escAttr(value) + b);
}

// "7 янв 2026" → "2026-01-07" (или null, если не распарсилось)
const RU_MONTHS = [[/янв/,'01'],[/фев/,'02'],[/март|мар/,'03'],[/апр/,'04'],[/ма[йя]/,'05'],[/июн/,'06'],[/июл/,'07'],[/авг/,'08'],[/сен/,'09'],[/окт/,'10'],[/ноя/,'11'],[/дек/,'12']];
function parseRuDate(s) {
  if (!s) return null;
  const day = (s.match(/\d{1,2}/) || [])[0];
  const year = (s.match(/\d{4}/) || [])[0];
  let mm = null;
  for (const [re, m] of RU_MONTHS) if (re.test(s)) { mm = m; break; }
  if (!day || !year || !mm) return null;
  return year + '-' + mm + '-' + String(day).padStart(2, '0');
}

// Общая «шапка»: base href, title, description, og/twitter, canonical
function head(page, { title, desc, url, ogType }) {
  page = page.replace('<head>', '<head>\n<base href="' + BASE_HREF + '">');
  page = page.replace(/<title>[\s\S]*?<\/title>/, '<title>' + escHtml(title) + '</title>');
  page = setMeta(page, 'name', 'description', desc);
  page = setMeta(page, 'property', 'og:title', title);
  page = setMeta(page, 'property', 'og:description', desc);
  page = setMeta(page, 'property', 'og:url', url);
  if (ogType) page = setMeta(page, 'property', 'og:type', ogType);
  page = setMeta(page, 'name', 'twitter:title', title);
  page = setMeta(page, 'name', 'twitter:description', desc);
  return page.replace(/(<link rel="canonical"\s+href=")[^"]*(")/, (m, a, b) => a + url + b);
}

// Сделать активной нужную «страницу» SPA вместо главной
function activate(page, id) {
  page = page.replace('<div class="page active" id="page-home">', '<div class="page" id="page-home">');
  return page.replace('<div class="page" id="page-' + id + '">', '<div class="page active" id="page-' + id + '">');
}

function injectHead(page, snippet) {
  return page.replace('</head>', snippet + '\n</head>');
}

/** Возвращает массив [relPath, html] для статей, спотов, листинга блога и sitemap. */
export function generate() {
  const html = readFileSync('index.html', 'utf8');
  const posts = extractArray(html, 'posts');
  const spots = extractArray(html, 'spots');
  const out = [];

  // ── Статьи ──
  for (const p of posts) {
    const slug = slugify(p.title);
    const url = SITE + 'blog/' + slug + '/';
    const desc = p.excerpt || '';
    const title = p.title + ' — Глубже';
    const iso = parseRuDate(p.date);

    let page = head(html, { title, desc, url, ogType: 'article' });
    page = activate(page, 'article');
    page = page.replace('<h1 id="art-title"></h1>', '<h1 id="art-title">' + escHtml(p.title) + '</h1>');
    page = page.replace('<div class="meta-row" id="art-meta"></div>',
      '<div class="meta-row" id="art-meta"><span>' + escHtml(p.cat) + '</span><span><b>' + escHtml(p.date) + '</b></span><span>⏱ ' + escHtml(p.read) + '</span></div>');
    page = page.replace('<div class="article-hero" id="art-hero"></div>',
      '<div class="article-hero ' + p.ph + '" id="art-hero">' + catIcon(p.cat) + '</div>');
    page = page.replace('<div id="art-body"></div>', '<div id="art-body">' + p.body + '</div>');
    page = page.replace('<div id="art-related" class="art-related"></div>', '<div id="art-related" class="art-related">' + relatedHtml(p, posts) + '</div>');

    // JSON-LD BlogPosting + дата публикации
    const ld = {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: p.title, description: desc,
      author: { '@type': 'Person', name: 'Павел Смотров' },
      publisher: { '@type': 'Person', name: 'Павел Смотров' },
      image: SITE + 'og-cover.jpg', mainEntityOfPage: url,
    };
    if (iso) ld.datePublished = iso;
    let extra = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';
    if (iso) extra += '\n<meta property="article:published_time" content="' + iso + '">';
    page = injectHead(page, extra);

    out.push(['blog/' + slug + '/index.html', page]);
  }

  // ── Споты ──
  for (const s of spots) {
    const slug = slugify(s.t);
    const url = SITE + 'spots/' + slug + '/';
    const desc = s.sub || '';
    const title = s.t + ' — Глубже';

    let page = head(html, { title, desc, url });
    page = activate(page, 'spot-detail');
    page = page.replace('<h1 id="sd-title"></h1>', '<h1 id="sd-title">' + escHtml(s.t) + '</h1>');
    page = page.replace('<p id="sd-sub"></p>', '<p id="sd-sub">' + escHtml(s.sub || '') + '</p>');
    const hero = s.img
      ? '<div class="" id="sd-hero"><img class="spot-hero-img" src="' + s.img + '" alt="' + escAttr(s.t) + '" width="800" height="320" loading="lazy"><p class="spot-attr">' + escHtml(s.attr || '') + '</p></div>'
      : '<div class="article-hero ' + (s.ph || '') + '" id="sd-hero">' + (s.emoji || '') + '</div>';
    page = page.replace('<div class="article-hero" id="sd-hero"></div>', hero);
    const cards = [['Глубина', s.depth], ['Уровень', s.level], ['Темп. воды', s.temp], ['Видимость', s.vis]]
      .map(([k, v]) => '<div class="info-card"><div class="k">' + escHtml(k) + '</div><div class="v">' + escHtml(v || '') + '</div></div>').join('');
    page = page.replace('<div class="spot-detail-grid" id="sd-cards"></div>', '<div class="spot-detail-grid" id="sd-cards">' + cards + '</div>');
    page = page.replace('<div id="sd-body"></div>', '<div id="sd-body">' + (s.body || '') + '</div>');

    out.push(['spots/' + slug + '/index.html', page]);
  }

  // ── Листинг блога ──
  {
    let page = head(html, { title: 'Журнал — Глубже', desc: 'Заметки о технике, снаряжении и местах дайвинга — из личного опыта.', url: SITE + 'blog/' });
    page = activate(page, 'blog');
    const cards = posts.map((p, i) =>
      '<article class="post" onclick="openArticle(' + i + ')"><div class="cover ' + p.ph + '">' + catIcon(p.cat) + '</div>' +
      '<div class="body"><span class="cat">' + escHtml(p.cat) + '</span><h3>' + escHtml(p.title) + '</h3><p>' + escHtml(p.excerpt || '') + '</p>' +
      '<span class="date">' + escHtml(p.date) + ' · ' + escHtml(p.read) + '</span></div></article>').join('');
    page = page.replace('<div class="grid-3" id="blog-list"></div>', '<div class="grid-3" id="blog-list">' + cards + '</div>');
    out.push(['blog/index.html', page]);
  }

  // ── sitemap.xml: все страницы, отдающие 200 на Pages ──
  const urls = [
    [SITE, '1.0'],
    [SITE + 'blog/', '0.7'],
    ...posts.map(p => [SITE + 'blog/' + slugify(p.title) + '/', '0.8']),
    ...spots.map(s => [SITE + 'spots/' + slugify(s.t) + '/', '0.6']),
  ];
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(([u, pr]) => '  <url>\n    <loc>' + u + '</loc>\n    <changefreq>weekly</changefreq>\n    <priority>' + pr + '</priority>\n  </url>').join('\n') +
    '\n</urlset>\n';
  out.push(['sitemap.xml', sitemap]);

  return out;
}

// CLI (не выполняется при импорте из check.mjs)
if (process.argv[1] && process.argv[1].endsWith('prerender.mjs')) {
  const pages = generate();
  if (process.argv.includes('--check')) {
    const stale = pages.filter(([rel, content]) => {
      let cur = null; try { cur = readFileSync(rel, 'utf8'); } catch {}
      return cur !== content;
    }).map(([rel]) => rel);
    if (stale.length) { console.error('✗ Пререндер устарел — запусти `npm run build`:\n  ' + stale.join('\n  ')); process.exit(1); }
    console.log('✓ Пререндер актуален (' + pages.length + ' страниц)');
  } else {
    rmSync('blog', { recursive: true, force: true });
    rmSync('spots', { recursive: true, force: true });
    for (const [rel, content] of pages) { mkdirSync(dirname(rel), { recursive: true }); writeFileSync(rel, content); }
    console.log('Сгенерировано страниц: ' + pages.length);
    pages.forEach(([r]) => console.log('  ' + r));
  }
}
