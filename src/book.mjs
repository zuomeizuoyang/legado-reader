/**
 * 书源业务编排：搜索 / 详情 / 目录 / 正文。
 * 全部在服务端完成规则求值，前端只拿结果。
 */
import { fetchRaw, decodeBuffer } from './proxy.mjs';
import iconv from 'iconv-lite';
import { makeCtx, str, list, url as ruleUrl, abs } from './rules.mjs';
import { runJsRule } from './jsengine.mjs';

/**
 * 按指定字符集做 URL 编码。
 * GBK 站（中文小说站里占大多数）必须先把关键词编成 GBK 字节再 percent-encode，
 * 否则服务器收到的是 UTF-8 字节，返回的搜索结果本身就是乱码。
 */
function encodeKey(key, charset) {
  const cs = String(charset || '').toLowerCase();
  if (!cs || /^utf-?8$/.test(cs)) return encodeURIComponent(key);
  const norm = /^(gb2312|gbk|gb18030)$/.test(cs) ? 'gbk' : cs;
  if (!iconv.encodingExists(norm)) return encodeURIComponent(key);
  try {
    const buf = iconv.encode(String(key), norm);
    return [...buf].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  } catch {
    return encodeURIComponent(key);
  }
}

/** 拆分 Legado 的 "url,{json配置}" 写法 */
function splitUrlConfig(t) {
  const i = t.indexOf(',{');
  if (i <= 0) return { urlTpl: t, cfg: null };
  try {
    return { urlTpl: t.slice(0, i), cfg: JSON.parse(t.slice(i + 1)) };
  } catch {
    return { urlTpl: t, cfg: null };
  }
}

/**
 * 生成搜索地址。searchUrl 支持四种形态：
 *  1. 普通模板      https://x.com/s?q={{key}}&page={{page}}
 *  2. 内嵌 JS       https://x.com/s?q={{java.encodeURI(key)}}
 *  3. JSON 配置     {"method":"POST","url":"...","body":"..."}
 *  4. 整段 JS       <js> ... return url </js>   ← 聚合源常见
 */
function buildSearchRequest(tpl, key, page, src) {
  let t = String(tpl || '').trim();

  // 形态 4：整段 JS 生成地址
  if (/^@js:|^<js>/i.test(t)) {
    const code = t.replace(/^@js:/i, '').replace(/^<js>/i, '').replace(/<\/js>\s*$/i, '');
    let out = '';
    try {
      out = runJsRule(code, { key, page, result: '', source: src, book: {}, chapter: {} });
    } catch (e) {
      throw new Error('搜索地址脚本出错：' + e.message);
    }
    const s0 = String(out == null ? '' : out).trim();
    if (!s0) throw new Error('搜索地址脚本返回空');

    // 脚本可能直接返回 JSON 配置
    if (s0.startsWith('{') && s0.includes('"url"')) {
      try {
        const cfg = JSON.parse(s0);
        return {
          url: String(cfg.url || '').trim(),
          method: (cfg.method || 'GET').toUpperCase(),
          body: cfg.body || null,
          headers: typeof cfg.headers === 'string' ? safeJson(cfg.headers) : (cfg.headers || {}),
          charset: cfg.charset || '',
        };
      } catch { /* 当普通 URL 处理 */ }
    }
    // 也可能返回 "url,{json}" 或带 {{page}} 的模板
    const sc = splitUrlConfig(s0);
    const encs = k => encodeKey(k, sc.cfg && sc.cfg.charset);
    return {
      url: fillVarTpl(sc.urlTpl, key, page, src, encs).trim(),
      method: (sc.cfg && sc.cfg.method ? sc.cfg.method : 'GET').toUpperCase(),
      body: sc.cfg && sc.cfg.body ? fillVarTpl(sc.cfg.body, key, page, src, encs) : null,
      headers: sc.cfg ? (typeof sc.cfg.headers === 'string' ? safeJson(sc.cfg.headers) : (sc.cfg.headers || {})) : {},
      charset: (sc.cfg && sc.cfg.charset) || '',
    };
  }

  // 形态 3：整段 JSON 配置
  if (t.startsWith('{')) {
    try {
      const cfg = JSON.parse(t);
      const encj = k => encodeKey(k, cfg.charset);
      const u = fillVarTpl(cfg.url || '', key, page, src, encj);
      return {
        url: /^https?:/i.test(u) ? u : abs(u, cfg.url),
        method: (cfg.method || 'GET').toUpperCase(),
        body: cfg.body ? fillVarTpl(cfg.body, key, page, src, encj) : null,
        headers: typeof cfg.headers === 'string' ? safeJson(cfg.headers) : (cfg.headers || {}),
        charset: cfg.charset || '',
      };
    } catch { /* 落到普通模板 */ }
  }

  // 形态 1/2：URL 模板（可能带 ",{json}" 请求配置）
  const { urlTpl, cfg } = splitUrlConfig(t);
  const enc = k => encodeKey(k, cfg && cfg.charset);
  return {
    url: fillVarTpl(urlTpl, key, page, src, enc).trim(),
    method: ((cfg && cfg.method) || 'GET').toUpperCase(),
    body: cfg && cfg.body ? fillVarTpl(cfg.body, key, page, src, enc) : null,
    headers: cfg ? (typeof cfg.headers === 'string' ? safeJson(cfg.headers) : (cfg.headers || {})) : {},
    charset: (cfg && cfg.charset) || '',
  };
}

function fillVarTpl(tpl, key, page, src, enc) {
  return String(tpl || '').replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => fillVar(e.trim(), key, page, src, enc));
}

function fillVar(expr, key, page, src, enc) {
  if (!expr) return '';
  if (expr === 'key' || expr === 'keyword') return (enc || encodeURIComponent)(key);
  if (expr === 'page') return String(page);
  try {
    const out = runJsRule(expr, { key, page, result: '', source: src || {} });
    return out == null ? '' : String(out);
  } catch { return ''; }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/** 统一发请求（服务端没有 CORS，直接用异步 fetch 更快） */
async function fetchPage(url, opt = {}) {
  return fetchRaw(url, {
    headers: opt.headers || {},
    timeout: opt.timeout || 15000,
  });
}

const MAX_SEARCH_ITEMS = 40;

export async function search(src, kw, page = 1) {
  if (!src.searchUrl) throw new Error('该源没有搜索地址');

  const req = buildSearchRequest(src.searchUrl, kw, page, src);
  let fullUrl = req.url;
  if (/^\//.test(fullUrl)) fullUrl = abs(fullUrl, src.bookSourceUrl);
  if (!/^https?:/i.test(fullUrl)) throw new Error('搜索结果地址无效：' + fullUrl);

  let res;
  if (req.method === 'POST') {
    // POST 也走 fetchRaw：统一拿到字符集探测 / 重试 / 状态码
    res = await fetchRaw(fullUrl, {
      method: 'POST',
      body: req.body || '',
      headers: req.headers,
      timeout: 20000,
      noCache: true,
    });
  } else {
    res = await fetchPage(fullUrl, { headers: req.headers });
  }
  if (res.status >= 400) throw new Error('HTTP ' + res.status);

  const base = res.url || fullUrl;
  const ctx = makeCtx(res, base, { key: kw, page });
  const r = src.ruleSearch || {};

  const els = list(r.bookList, ctx);
  const out = [];
  const seen = new Set();

  for (const el of els.slice(0, MAX_SEARCH_ITEMS)) {
    const c = { ...ctx, node: el };
    const name = str(r.name, c);
    if (!name) continue;
    const title = saneName(name);
    if (!title) continue;
    const bookUrl = ruleUrl(r.bookUrl, c);
    const key2 = title + '|' + bookUrl;
    if (seen.has(key2)) continue;
    seen.add(key2);
    out.push({
      name: title,
      author: saneField(str(r.author, c), 30) || '佚名',
      kind: saneField(str(r.kind, c), 20),
      lastChapter: saneField(str(r.lastChapter, c), 60),
      intro: saneIntro(str(r.intro, c)),
      coverUrl: ruleUrl(r.coverUrl, c),
      bookUrl: bookUrl || base,
      hasDetail: !!bookUrl,
      sourceUrl: src.bookSourceUrl,
      sourceName: src.bookSourceName,
    });
  }

  // 有些源的搜索结果页直接就是书籍页（规则指向页面本身）。
  // 但必须严格校验：一旦规则没匹配上，这里会取到整页文本，不能当成书名。
  if (!out.length && !els.length && ctx.doc && ctx.doc.documentElement) {
    const c = { ...ctx, node: ctx.doc.documentElement };
    const name = saneName(str(r.name, c));
    const bookUrl = ruleUrl(r.bookUrl, c);
    // 必须同时满足：书名像书名、拿得到详情地址。
    // 只满足前者的话，规则失效时会退化成一整页导航文本（"搜索：xx 首页 分类 排行…"）。
    const looksLikeTitle = !!name && !/[{};]/.test(name);
    if (looksLikeTitle) {
      out.push({
        name,
        author: saneField(str(r.author, c), 30) || '佚名',
        intro: saneIntro(str(r.intro, c)),
        coverUrl: ruleUrl(r.coverUrl, c),
        bookUrl: bookUrl || base,
        hasDetail: !!bookUrl,
        sourceUrl: src.bookSourceUrl,
        sourceName: src.bookSourceName,
      });
    }
  }

  return out;
}

function tryJson(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { return null; } }
  return null;
}

function clean(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 单行短字段（作者/分类/最新章节）：长度不对就是匹配错了节点 */
function saneField(n, max) {
  const s = clean(n);
  if (!s) return '';
  if (s.length > max) return '';
  if (/&nbsp;|&amp;|https?:\/\//.test(s)) return '';
  if (/window\.|function\s*\(/.test(s)) return '';
  // 页面导航词：说明规则匹配到了菜单/推荐区，不是真的字段值
  if (/相关.{0,2}(小说|推荐|阅读)|首页|登录|注册|排行|书架/.test(s)) return '';
  return s;
}

/**
 * 简介校验：简介可以长，但不该是一堆导航文本拼起来的。
 * 抓到整页时典型特征是塞满了 &nbsp; 或者几十个链接文字。
 */
function saneIntro(n) {
  const s = clean(n);
  if (!s) return '';
  const nb = (s.match(/&nbsp;/g) || []).length;
  if (nb >= 3) return '';
  if (s.length > 600) return s.slice(0, 200) + '…';
  return s;
}

/**
 * 书名合理性校验。
 * 整合包里总有几个源的 name 规则指向了父节点或整页标题，
 * 结果抓出「《 xx》全集下载 与"xx"相关的小说 - 首页 玄幻小说」这种东西。
 * 真书名不会有 40 个字，也不该带换行——这类直接丢掉，别让用户去点。
 */
function saneName(n) {
  const s = clean(n);
  if (!s) return '';
  if (s.length > 40) return '';
  if (/\n|\r/.test(String(n || ''))) return '';
  return s;
}

export async function info(src, book) {
  const target = book.bookUrl;
  const res = await fetchPage(target);
  const ctx = makeCtx(res, res.url || target, { book });
  const r = src.ruleBookInfo || {};
  const pick = k => str(r[k], ctx);
  const tocUrl = ruleUrl(r.tocUrl, ctx);

  return {
    name: saneName(pick('name')) || book.name,
    author: saneField(pick('author'), 30) || book.author,
    intro: saneIntro(pick('intro')) || book.intro || '',
    kind: saneField(pick('kind'), 20) || book.kind || '',
    coverUrl: ruleUrl(r.coverUrl, ctx) || book.coverUrl || '',
    lastChapter: saneField(pick('lastChapter'), 60) || book.lastChapter || '',
    wordCount: clean(pick('wordCount')) || '',
    tocUrl: tocUrl || '',
    _htmlLen: (res.text || '').length,
  };
}

/* ---------- 目录排序 ----------
 * 不少站点在目录页顶部先挂一块「最新章节」（倒序），下面才是正序全集，
 * 直接按 DOM 顺序拼出来就是 1981,1980,…,1,… 这种乱序。
 * 能解析出章节编号且编号基本不重复时按编号升序重排；分卷重新编号的
 * （编号重复率高）则只在整体明显倒序时反转，避免打乱分卷结构。
 */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };

function cnToInt(s) {
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) { num = CN_DIGIT[ch]; }
    else if (CN_UNIT[ch] !== undefined) {
      section += (num || 1) * CN_UNIT[ch];
      num = 0;
    } else return null;
  }
  total = section + num;
  return total > 0 ? total : null;
}

/** 从「第一千九百八十一章 xxx」/「第12节」这类标题里取章节序号 */
function chapterNumber(name) {
  const m = String(name || '').match(/第?\s*([0-9]{1,6}|[零〇一二两三四五六七八九十百千]{1,9})\s*[章节回话集篇]/);
  if (!m) return null;
  const t = m[1];
  if (/^\d+$/.test(t)) return parseInt(t, 10) || null;
  return cnToInt(t);
}

function orderChapters(out) {
  if (out.length < 10) return out;
  const nums = out.map(o => chapterNumber(o.name));
  const parsed = nums.filter(n => n !== null).length;

  // 编号能解析、而且基本不重复 → 按编号升序（同级保持原顺序）。
  // 编号重复往往意味着分卷重新计数，或站点自己就排乱了，这时不能碰。
  if (parsed / out.length >= 0.9) {
    const uniq = new Set(nums.filter(n => n !== null)).size;
    if (uniq / out.length >= 0.85) {
      return out
        .map((o, i) => ({ o, n: nums[i] === null ? -1 : nums[i], i }))
        .sort((a, b) => a.n - b.n || a.i - b.i)
        .map(x => x.o);
    }
  }

  // 兜底：只有「整份目录几乎严格倒序」才反转，非单调的一律保持原样
  let desc = 0, asc = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === null || nums[i - 1] === null) continue;
    if (nums[i] < nums[i - 1]) desc++;
    else if (nums[i] > nums[i - 1]) asc++;
  }
  const pairs = desc + asc;
  if (desc > 10 && pairs > 0 && desc / pairs >= 0.95 && asc <= 2) return out.slice().reverse();
  return out;
}

const MAX_TOC_PAGES = 10;   // 目录翻页上限：防规则写错时无限抓

export async function toc(src, book, infoData) {
  const r = src.ruleToc || {};
  let tocUrl = (infoData && infoData.tocUrl) || book.tocUrl || '';
  let res, ctx, usedUrl;

  if (!tocUrl) {
    res = await fetchPage(book.bookUrl);
    usedUrl = book.bookUrl;
    ctx = makeCtx(res, res.url || usedUrl, { book });
    tocUrl = book.bookUrl;
  } else {
    res = await fetchPage(tocUrl);
    usedUrl = tocUrl;
    ctx = makeCtx(res, res.url || usedUrl, { book });
  }
  const entryUrl = tocUrl;

  let els = list(r.chapterList, ctx);
  if (!els.length && usedUrl !== book.bookUrl) {
    res = await fetchPage(book.bookUrl);
    usedUrl = book.bookUrl;
    ctx = makeCtx(res, res.url || usedUrl, { book });
    els = list(r.chapterList, ctx);
  }

  const out = [];
  const seen = new Set();

  /** 把当前页 ctx 里的章节吸进 out（同一次抓取可能被调用多次：每翻一页一次） */
  function absorb() {
    for (const el of els) {
      const c = { ...ctx, node: el };
      const name = clean(str(r.chapterName, c));
      if (!name) continue;
      const cu = ruleUrl(r.chapterUrl, c);
      const isVol = !!(r.isVolume && str(r.isVolume, c));
      const k = name + '|' + cu;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name, url: cu || usedUrl, isVol });
    }
  }

  function setPage(pageRes, url) {
    usedUrl = pageRes.url || url;
    ctx = makeCtx(pageRes, usedUrl, { book });
    els = list(r.chapterList, ctx);
  }

  absorb();

  /* 目录分页（nextTocUrl）
     不少站把几千章切成 index.html / index_2.html …，只取第一页会
     得到"只有前 200 章"的目录——书能打开，但后面全是缺的。
     顺着 nextTocUrl 继续抓，直到没有下一页或地址重复。 */
  if (r.nextTocUrl) {
    const visited = new Set([usedUrl]);
    for (let page = 0; page < MAX_TOC_PAGES; page++) {
      let next = '';
      try { next = ruleUrl(r.nextTocUrl, ctx); } catch { next = ''; }
      if (!next || visited.has(next)) break;
      visited.add(next);
      let pageRes;
      try {
        pageRes = await fetchPage(next);
      } catch { break; }                 // 后一页抓不到：保留已拿到的目录，别整份失败
      setPage(pageRes, next);
      if (!els.length) break;            // 下一页没有章节了，说明到底了
      absorb();
    }
  }

  return { list: orderChapters(out), tocUrl: entryUrl };
}

export async function content(src, chapter, baseUrl) {
  const r = src.ruleContent || {};
  let target = chapter.url || baseUrl;
  const parts = [];
  const visited = new Set();

  for (let page = 0; page < 5; page++) {
    if (!target || visited.has(target)) break;
    visited.add(target);
    const res = await fetchPage(target);
    const ctx = makeCtx(res, res.url || target, { chapter });
    let part = str(r.content, ctx);
    // 只有源本身没写正文规则时才退回整页 —— 规则存在却取不到，
    // 说明内容靠 JS 渲染或被反爬拦截，塞整页进去只会得到满屏导航。
    if (!part && !r.content && page === 0 && ctx.doc && ctx.doc.body) {
      part = ctx.doc.body.innerHTML;
    }
    if (part) parts.push(part);
    const next = ruleUrl(r.nextContentUrl, ctx);
    if (!next || next === target) break;
    target = next;
  }
  return parts.join('\n');
}
