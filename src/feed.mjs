/**
 * 订阅源（RSS / 网页）解析 —— 服务端版。
 *
 * 对齐 Legado 的 RssParserByRule + RssParserDefault 语义：
 *   1. ruleArticles 为空  → 走标准 RSS/Atom XML 解析（默认解析器）
 *   2. ruleArticles 以 - 开头 → 结果反序
 *   3. ruleNextPage === 'PAGE' → 靠 {{page}} 自增；否则把规则解析成 URL
 *   4. ruleTitle / ruleLink / rulePubDate / ruleDescription / ruleImage 在「每条 item 节点」上求值
 *   5. link 相对地址按列表页地址补全
 *   6. 正文：ruleContent 有就用；没有就退回文章描述，再退回正文提取
 *
 * 相比前端版本，这里能跑 @js: / JSONPath / XPath —— 因为复用 rules.mjs + jsengine。
 */
import { JSDOM } from 'jsdom';
import { fetchRaw } from './proxy.mjs';
import { makeCtx, str, list, url as ruleUrl } from './rules.mjs';
import { runJsRule } from './jsengine.mjs';

// 抓取超时要留出重试空间：引擎给整个任务 30s，一次 12s + 重试一次 = 最坏 24s
const UA_HINT = 12000;

/* ---------------- 工具 ---------------- */

/** 把 {{page}} / <page> / <page1> 替换成页码（Legado 的两种页码写法） */
export function resolvePageUrl(tpl, page) {
  const p = String(page || 1);
  return String(tpl || '')
    .replace(/\{\{\s*page\s*\}\}/gi, p)
    .replace(/<page(\d+)?>/gi, p);
}

const HAS_JS = /@js:|<js>/i;

/**
 * 跑规则里的 JS 片段：`@js:xxx` / `<js>xxx</js>`，以及 `{{表达式}}` 插值。
 * 订阅源的 sourceUrl 经常是脚本生成的（多线路、动态域名），不跑就拿不到真地址。
 */
function evalTemplate(text, src) {
  let s = String(text || '');
  if (HAS_JS.test(s)) {
    const m = s.match(/^([\s\S]*?)(@js:|<js>)([\s\S]*?)(<\/js>)?$/i);
    const code = m ? m[3] : s;
    try {
      const out = runJsRule(code, { source: src });
      s = String(out == null ? '' : (Array.isArray(out) ? out.join('\n') : out)).trim();
    } catch { /* 脚本跑不通就按原文继续，下面会判无效 */ }
  }
  s = s.replace(/\{\{([\s\S]*?)\}\}/g, (mm, expr) => {
    try {
      const out = runJsRule('return (' + expr + ');', { source: src });
      return String(out == null ? '' : out);
    } catch { return ''; }
  });
  return s;
}

/** 订阅源的基准地址（相对线路要基于它补全） */
function baseOf(src) {
  const s = String(src.sourceUrl || '');
  const m = s.match(/https?:\/\/[^\s|]+/);
  if (m) {
    try { return new URL(m[0]).origin + '/'; } catch { /* 继续 */ }
  }
  return '';
}

const sortCache = new WeakMap();

/**
 * 解析订阅源的「分类 / 线路」列表。
 *
 * Legado 里 sourceUrl 可以不是单个 URL，而是多行 `名称::URL`（有时由 @js: 生成）：
 *   全部::https://news.example.com/api/latest
 *   最新::/Articles
 * 也可能只有一行没有名称。这里统一拆成 {name,url} 列表，取第一个作为默认。
 */
export function resolveSorts(src) {
  if (!src || typeof src !== 'object') return [];
  const cached = sortCache.get(src);
  if (cached) return cached;

  const raw = evalTemplate(src.sourceUrl, src);
  const base = baseOf(src);
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('::');
    let name = '', url = t;
    if (i > 0) { name = t.slice(0, i).trim(); url = t.slice(i + 2).trim(); }
    if (!url) continue;
    if (/^data:/i.test(url)) continue;              // base64 线路占位，不是真地址
    if (!/^https?:\/\//i.test(url)) {
      // 允许相对路径；纯文字（比如"阅读导入"）直接丢弃
      if (!/^[./]/.test(url)) continue;
      if (!base) continue;
      url = absUrl(url, base);
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (out.some(x => x.url === url)) continue;
    out.push({ name: name || src.sourceName || '默认', url });
  }
  sortCache.set(src, out);
  return out;
}

/** 列表页地址：显式传入 > source.sortUrl > sourceUrl 里解析出的第一个分类 */
function feedUrlOf(src, sortUrl, page) {
  let raw = String(sortUrl || '').trim();
  if (!raw) raw = String(src.sortUrl || '').trim();
  if (!raw) {
    const sorts = resolveSorts(src);
    raw = (sorts[0] && sorts[0].url) || '';
  }
  if (!raw) {
    // 兜底：sourceUrl 本身就是个地址（SPA 的 #/ 片段要去掉，但保留普通锚点）
    const s = String(src.sourceUrl || '').trim();
    raw = /#\//.test(s) ? s.replace(/#\/.*$/, '') : s.split('#')[0];
  }
  if (!raw) return '';
  return resolvePageUrl(raw, page);
}

function absUrl(u, base) {
  if (!u) return '';
  try { return new URL(String(u).trim(), base).href; } catch { return String(u); }
}

function looksLikeFeed(text) {
  const head = String(text || '').slice(0, 600).trim();
  if (!head) return false;
  return /^<\?xml|^<rss|^<feed|^<rdf:RDF|^<RDF/i.test(head) || /<(item|entry)[\s>]/i.test(String(text).slice(0, 4000));
}

/** 从 HTML 片段里抠第一张图 */
function firstImg(html) {
  const m = String(html || '').match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function textOf(node) {
  if (!node) return '';
  return String(node.textContent || '').replace(/\s+/g, ' ').trim();
}

/* ---------------- 标准 RSS / Atom 解析 ---------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 取某个标签的内容（含 CDATA） */
function tagText(xml, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i');
  const m = String(xml).match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}

/**
 * 解析标准 RSS 2.0 / Atom / RDF。
 *
 * 手写而不是走 XML DOM：feed 结构扁平，正则够用；
 * 而且引擎线程里解析大 XML 的代价远高于切开再取字段。
 * 返回 null 表示「不像 feed」。
 */
export function parseStandardFeed(text, baseUrl) {
  if (!looksLikeFeed(text)) return null;
  const body = String(text);

  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const blocks = [];
  let m;
  while ((m = itemRe.exec(body))) blocks.push({ tag: m[1].toLowerCase(), xml: m[2] });
  const isAtom = blocks.length > 0 && blocks[0].tag === 'entry';
  if (!blocks.length) return { items: [], isAtom: false };

  const out = [];
  for (const { xml } of blocks) {
    const title = tagText(xml, 'title');
    if (!title) continue;

    // 链接：RSS 是 <link>文本</link>，Atom 是 <link href="...">
    let link = '';
    const linkRe = /<link\b([^>]*)>([\s\S]*?)<\/link>|<link\b([^>]*)\/>/gi;
    let lm;
    while ((lm = linkRe.exec(xml))) {
      const attrs = lm[1] || lm[3] || '';
      const inner = lm[2] || '';
      const hrefM = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
      const relM = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
      if (hrefM) {
        const rel = (relM && relM[1]) || '';
        if (!rel || rel === 'alternate') { link = decodeEntities(hrefM[1]); break; }
      } else if (inner && !link) {
        link = decodeEntities(inner).trim();
      }
    }
    if (!link) link = tagText(xml, 'guid');

    const date = tagText(xml, 'pubDate')
      || tagText(xml, 'published')
      || tagText(xml, 'updated')
      || tagText(xml, 'dc:date')
      || tagText(xml, 'time');

    const desc = tagText(xml, 'description') || tagText(xml, 'summary');
    const full = tagText(xml, 'content:encoded') || tagText(xml, 'content');
    const content = full || desc;

    let img = '';
    const thumbRe = /<(media:thumbnail|media:content|enclosure)\b([^>]*)>/gi;
    let tm;
    while ((tm = thumbRe.exec(xml))) {
      const attrs = tm[2] || '';
      const u = (attrs.match(/url\s*=\s*["']([^"']+)["']/i) || [])[1];
      const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (u && (!type || /image\//i.test(type) || /thumbnail/i.test(tm[1]))) { img = decodeEntities(u); break; }
    }
    if (!img) img = firstImg(content) || firstImg(desc);

    out.push({
      name: title,
      url: link ? absUrl(link, baseUrl) : baseUrl,
      date,
      desc,
      img: img ? absUrl(img, baseUrl) : '',
      content,
    });
  }
  return { items: out, isAtom };
}

/* ---------------- 正文提取（无 ruleContent 时兜底） ---------------- */

const CONTENT_SELS = [
  'article', '.article', '.post-content', '.entry-content', '.rich_media_content',
  '#content', '.content', '.post', '.detail', '.article-content', '.markdown-body', 'main',
];

export function extractReadable(doc, minLen = 120) {
  if (!doc || !doc.body) return '';
  let best = null, bestLen = 0;
  for (const sel of CONTENT_SELS) {
    let nodes = [];
    try { nodes = [...doc.querySelectorAll(sel)]; } catch { /* 选择器不合法就算了 */ }
    for (const n of nodes) {
      const len = String(n.textContent || '').replace(/\s/g, '').length;
      if (len > bestLen) { best = n; bestLen = len; }
    }
  }
  if (!best || bestLen < minLen) best = doc.body;
  if (!best) return '';
  const c = best.cloneNode(true);
  c.querySelectorAll('script,style,nav,header,footer,aside,iframe,form,button,noscript').forEach(n => n.remove());
  return c.innerHTML;
}

/* ---------------- 网页列表启发式（老格式订阅源的兜底） ---------------- */

/**
 * 老版 Legado 订阅源只有 sourceUrl + singleUrl，没有 ruleArticles，
 * 而目标常常是普通网页（论坛版块、导航页、发布页）。
 * 这里找「同一父节点下重复出现的一批链接」，按结构规整度挑一块当文章列表。
 */
export function guessWebList(doc, baseUrl) {
  if (!doc) return [];
  const groups = new Map();
  let links = [];
  try { links = [...doc.querySelectorAll('a[href]')]; } catch { return []; }

  for (const a of links) {
    const title = textOf(a);
    if (!title || title.length < 4 || title.length > 120) continue;
    const href = a.getAttribute('href') || '';
    if (!href || /^(javascript|#|mailto:)/i.test(href)) continue;
    const parent = a.parentElement;
    if (!parent) continue;
    // 用「父节点 + 父节点的标签名」当分组键
    const key = parent;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ a, title, href });
  }

  let best = null, bestScore = 0;
  for (const [parent, arr] of groups) {
    if (arr.length < 4) continue;
    // 同构程度：这些 <a> 的父级元素标签名分布越集中越像列表
    const tagCount = {};
    for (const { a } of arr) {
      const t = (a.parentElement && a.parentElement.tagName) || '';
      tagCount[t] = (tagCount[t] || 0) + 1;
    }
    const same = Math.max(...Object.values(tagCount));
    const score = arr.length * (same / arr.length);
    if (score > bestScore) { bestScore = score; best = { parent, arr, same }; }
  }
  if (!best) return [];

  // 链接应该在页面上「成块相邻」，用它们共同祖先的文本长度粗筛一下，避免抓到整页导航
  const seen = new Set();
  const out = [];
  for (const { title, href } of best.arr) {
    const u = absUrl(href, baseUrl);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ name: title, url: u, date: '', desc: '', img: '', content: '' });
    if (out.length >= 60) break;
  }
  return out;
}

/* ---------------- 对外接口 ---------------- */

/**
 * 取文章列表。
 * @returns {{items:Array, nextUrl:string, mode:'xml'|'rule'|'guess', url:string}}
 */
export async function feedArticles(src, opt = {}) {
  const page = Number(opt.page) || 1;
  const target = feedUrlOf(src, opt.sortUrl, page);
  if (!/^https?:\/\//i.test(target)) throw new Error('订阅源地址无效：' + (target || '(空)'));

  const res = await fetchRaw(target, {
    timeout: UA_HINT,
    retry: 1,
    headers: { Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*' },
  });
  const body = res.text || '';
  const baseUrl = res.url || target;

  let rule = String(src.ruleArticles || '').trim();
  // 页面只解析一次，后面 rule / 猜列表 / 正文提取都复用它
  let ctxCache = null;
  const ctxOf = () => (ctxCache || (ctxCache = makeCtx(res, baseUrl, {})));

  /* --- 1. 没有列表规则：标准 feed 解析 --- */
  if (!rule) {
    const std = parseStandardFeed(body, baseUrl);
    if (std && std.items.length) {
      return { items: std.items, nextUrl: '', mode: 'xml', url: baseUrl, sorts: resolveSorts(src) };
    }
    // 不是 feed，又没规则 → 尝试网页列表
    const doc = ctxOf().doc;
    const guessed = doc ? guessWebList(doc, baseUrl) : [];
    if (guessed.length) {
      return { items: guessed, nextUrl: '', mode: 'guess', url: baseUrl, sorts: resolveSorts(src) };
    }
    return { items: [], nextUrl: '', mode: 'xml', url: baseUrl, sorts: resolveSorts(src) };
  }

  /* --- 2. 有列表规则 --- */
  let reverse = false;
  if (rule.startsWith('-')) { reverse = true; rule = rule.slice(1).trim(); }

  const ctx = ctxOf();
  const nodes = list(rule, ctx);

  // 下一页
  let nextUrl = '';
  const np = String(src.ruleNextPage || '').trim();
  if (np) {
    if (/^page$/i.test(np)) nextUrl = resolvePageUrl(String(src.sortUrl || src.sourceUrl || ''), page + 1);
    else {
      const raw = str(np, ctx);
      if (raw) nextUrl = absUrl(raw, baseUrl);
    }
  }

  const items = [];
  for (const el of nodes) {
    const c = { ...ctx, node: el };
    const name = str(src.ruleTitle, c).trim();
    if (!name) continue;                        // Legado：标题为空直接丢弃
    const link = ruleUrl(src.ruleLink, c) || str(src.ruleLink, c);
    const date = str(src.rulePubDate, c);
    const desc = str(src.ruleDescription, c);
    const img = ruleUrl(src.ruleImage, c) || str(src.ruleImage, c);
    items.push({
      name,
      url: link ? absUrl(link, baseUrl) : baseUrl,
      date,
      desc,
      img: img ? absUrl(img, baseUrl) : '',
      content: desc,
    });
    if (items.length >= 80) break;
  }
  if (reverse) items.reverse();
  return { items, nextUrl, mode: 'rule', url: baseUrl, sorts: resolveSorts(src) };
}

/**
 * 取一篇正文。
 * 优先级：ruleContent → 文章描述（够长时） → 抓页面做正文提取
 */
export async function feedContent(src, article, opt = {}) {
  const url = String((article && article.url) || '').trim();
  const desc = String((article && (article.content || article.desc)) || '');
  const rule = String(src.ruleContent || '').trim();

  if (rule) {
    if (!/^https?:\/\//i.test(url)) throw new Error('文章地址无效');
    const res = await fetchRaw(url, { timeout: UA_HINT, retry: 1 });
    const ctx = makeCtx(res, res.url || url, {});
    const html = str(rule, ctx);
    if (html) return { html, why: 'rule' };
    // 规则跑了但没内容：退回提取
    const doc = mkDom(res.text || '');
    return { html: extractReadable(doc), why: 'rule-fallback' };
  }

  // 没有正文规则：RSS 描述本身就是全文的情况非常多，先用它
  if (desc && stripLen(desc) >= (opt.minDesc || 300)) {
    return { html: desc, why: 'desc' };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { html: desc, why: 'desc-only' };
  }
  const res = await fetchRaw(url, { timeout: UA_HINT, retry: 1 });
  const doc = mkDom(res.text || '');
  const html = extractReadable(doc);
  if (stripLen(html) >= 80) return { html, why: 'readable' };
  return { html: desc || html, why: desc ? 'desc' : 'empty' };
}

function stripLen(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/\s/g, '').length;
}

function mkDom(html) {
  const s = String(html || '');
  if (!s) return null;
  try {
    return new JSDOM(s, { contentType: 'text/html' }).window.document;
  } catch {
    return null;
  }
}
