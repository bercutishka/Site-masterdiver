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

function extractPosts(html) {
  const start = html.indexOf('const posts=[');
  const end = html.indexOf('const reviews=', start);
  if (start < 0 || end < 0) throw new Error('не найден массив posts в index.html');
  let lit = html.slice(start + 'const posts='.length, end);
  lit = lit.slice(0, lit.lastIndexOf(']') + 1);
  return new Function('return (' + lit + ')')();
}

function setMeta(html, attr, name, value) {
  const re = new RegExp('(<meta ' + attr + '="' + name + '"\\s+content=")[^"]*(")');
  return html.replace(re, (m, a, b) => a + escAttr(value) + b);
}

/** Возвращает массив [relPath, html] для всех статей. */
export function generate() {
  const html = readFileSync('index.html', 'utf8');
  const posts = extractPosts(html);
  const out = [];
  for (const p of posts) {
    const slug = slugify(p.title);
    const url = SITE + 'blog/' + slug + '/';
    const desc = p.excerpt || '';
    const titleFull = p.title + ' — Глубже';

    let page = html;
    page = page.replace('<head>', '<head>\n<base href="' + BASE_HREF + '">');
    page = page.replace(/<title>[\s\S]*?<\/title>/, '<title>' + escHtml(titleFull) + '</title>');
    page = setMeta(page, 'name', 'description', desc);
    page = setMeta(page, 'property', 'og:title', titleFull);
    page = setMeta(page, 'property', 'og:description', desc);
    page = setMeta(page, 'property', 'og:url', url);
    page = setMeta(page, 'name', 'twitter:title', titleFull);
    page = setMeta(page, 'name', 'twitter:description', desc);
    page = page.replace(/(<link rel="canonical"\s+href=")[^"]*(")/, (m, a, b) => a + url + b);

    // Активируем страницу статьи вместо главной
    page = page.replace('<div class="page active" id="page-home">', '<div class="page" id="page-home">');
    page = page.replace('<div class="page" id="page-article">', '<div class="page active" id="page-article">');

    // Вставляем контент статьи (то же, что делает openArticle в рантайме)
    page = page.replace('<h1 id="art-title"></h1>', '<h1 id="art-title">' + escHtml(p.title) + '</h1>');
    page = page.replace('<div class="meta-row" id="art-meta"></div>',
      '<div class="meta-row" id="art-meta"><span>' + escHtml(p.cat) + '</span><span><b>' + escHtml(p.date) + '</b></span><span>⏱ ' + escHtml(p.read) + '</span></div>');
    page = page.replace('<div class="article-hero" id="art-hero"></div>',
      '<div class="article-hero ' + p.ph + '" id="art-hero">' + (p.emoji || '') + '</div>');
    page = page.replace('<div id="art-body"></div>', '<div id="art-body">' + p.body + '</div>');

    out.push(['blog/' + slug + '/index.html', page]);
  }

  // sitemap.xml: главная + страницы статей (то, что реально отдаёт 200 на Pages)
  const urls = [SITE, ...posts.map(p => SITE + 'blog/' + slugify(p.title) + '/')];
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u, i) => '  <url>\n    <loc>' + u + '</loc>\n    <changefreq>weekly</changefreq>\n    <priority>' + (i === 0 ? '1.0' : '0.8') + '</priority>\n  </url>').join('\n') +
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
    for (const [rel, content] of pages) { mkdirSync(dirname(rel), { recursive: true }); writeFileSync(rel, content); }
    console.log('Сгенерировано страниц: ' + pages.length);
    pages.forEach(([r]) => console.log('  ' + r));
  }
}
