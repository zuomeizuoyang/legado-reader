/**
 * Legado 书源规则引擎（服务端版）。
 *
 * 相比纯前端版本的三个关键升级：
 *  1. XPath 用 jsdom 原生 evaluate，不再是残缺的 CSS 兼容层
 *  2. `@js:` / `<js>` 规则真正执行（见 jsengine.mjs）
 *  3. `{{ }}` 里的 JS 表达式也能执行并支持 java.*
 */
import { JSDOM } from 'jsdom';
import { runJsRule, registerRuleEngine } from './jsengine.mjs';

/* ---------------- DOM ---------------- */

// 同一份 HTML 反复解析很贵，按内容指纹缓存
const docCache = new Map();
const DOC_CACHE_MAX = 24;

export function mkDoc(html) {
  const key = String(html || '');
  const hit = docCache.get(key);
  // 缓存的是 JSDOM 实例，文档要从 window 上取
  if (hit) return hit.window.document;

  const dom = new JSDOM(key, { url: 'https://localhost/' });
  docCache.set(key, dom);
  if (docCache.size > DOC_CACHE_MAX) {
    docCache.delete(docCache.keys().next().value);
  }
  return dom.window.document;
}

/* ---------------- JSONPath 迷你实现 ---------------- */
export function jp(data, expr) {
  let p = String(expr).trim();
  if (p.startsWith('$')) p = p.slice(1);
  const toks = p.match(/\.\.[\w\u4e00-\u9fa5$-]+|\.[\w\u4e00-\u9fa5$-]+|\[\d+\]|\[\*\]|\[['"][^'"]+['"]\]/g) || [];
  let cur = [data];
  for (const tk of toks) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (tk.startsWith('..')) {
        const key = tk.slice(2);
        (function deep(o) {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) { o.forEach(deep); return; }
          for (const k in o) {
            if (k === key) next.push(o[k]);
            deep(o[k]);
          }
        })(c);
      } else if (tk.startsWith('.')) {
        const key = tk.slice(1);
        if (Array.isArray(c)) { c.forEach(x => { if (x && typeof x === 'object' && key in x) next.push(x[key]); }); }
        else if (typeof c === 'object' && key in c) next.push(c[key]);
      } else if (tk === '[*]') {
        if (Array.isArray(c)) next.push(...c);
        else if (c && typeof c === 'object') next.push(...Object.values(c));
      } else {
        let m = tk.match(/\[(\d+)\]/);
        if (m) { if (c) next.push(c[+m[1]]); continue; }
        m = tk.match(/\[['"]([^'"]+)['"]\]/);
        if (m && c) next.push(c[m[1]]);
      }
    }
    cur = next;
  }
  return cur;
}

/* ---------------- 选择器转换 ---------------- */

/** Legado 里 "class.dir clear" 表示同时含两个 class */
function pre(sel) {
  let s = sel;
  for (let i = 0; i < 4; i++) {
    const n = s.replace(/class\.([\w-]+)\s+([\w-]+)(?=\s|@|>|$)/g, 'class.$1.$2');
    if (n === s) return s;
    s = n;
  }
  return s;
}

function toXPath(sel0) {
  const sel = pre(sel0);
  const segs = sel.split(/\s*[@>]\s*|\s+/).filter(Boolean);
  if (!segs.length) return null;
  const steps = segs.map(s => {
    if (s.startsWith('class.')) {
      const cs = s.slice(6).split('.');
      return '*' + cs.map(c => `[contains(concat(" ",normalize-space(@class)," ")," ${c} ")]`).join('');
    }
    if (s.startsWith('id.')) return `*[@id="${s.slice(3)}"]`;
    if (s.startsWith('tag.')) return s.slice(4);
    if (s.startsWith('text.')) return `*[contains(normalize-space(.),"${s.slice(5)}")]`;
    return s;
  });
  return '//' + steps.join('//');
}

function toCss(sel0) {
  const sel = pre(sel0);
  const segs = sel.split(/\s*[@>]\s*|\s+/).filter(Boolean);
  const out = [];
  for (const s of segs) {
    // Legado 索引写法：tag.a.0 / class.item.1 / p.2
    const im = s.match(/^(tag|class|id)\.(.+)\.(\d+)$/);
    if (im) {
      const base = im[1] === 'tag' ? im[2] : im[1] === 'class' ? '.' + im[2] : '#' + im[2];
      out.push(`${base}:nth-of-type(${Number(im[3]) + 1})`);
      continue;
    }
    const tm = s.match(/^([a-zA-Z][\w-]*)\.(\d+)$/);
    if (tm) {
      out.push(`${tm[1]}:nth-of-type(${Number(tm[2]) + 1})`);
      continue;
    }
    if (s.startsWith('class.')) out.push(s.slice(6).split('.').map(c => '.' + c).join(''));
    else if (s.startsWith('id.')) out.push('#' + s.slice(3));
    else if (s.startsWith('tag.')) out.push(s.slice(4));
    else out.push(s);
  }
  return out.join(' ');
}

const ORDERED_NODE_SNAPSHOT = 7;

/**
 * 把 Legado 选择器拆成逐级查询步骤。
 *
 * 索引语义是重点：Legado 的 `tag.dd.book_other.0` 表示
 * 「所有匹配 dd.book_other 的元素里取第 0 个」，
 * 而不是 CSS 的 :nth-of-type(1)（那是按同类型兄弟排序）。
 * 两者在真实页面里结果完全不同。
 */
function buildSteps(body) {
  const sel = pre(body);
  const segs = sel.split(/\s*[@>]\s*|\s+/).filter(Boolean);
  const steps = [];

  for (const s of segs) {
    let m = s.match(/^(tag|class|id)\.(.+)\.(\d+)$/);
    if (m) {
      const kind = m[1], name = m[2], idx = Number(m[3]);
      let css;
      if (kind === 'tag') css = name;                                   // dd.book_other
      else if (kind === 'class') css = '.' + name.split('.').join('.');  // .a.b
      else css = '#' + name;
      steps.push({ css, idx });
      continue;
    }
    m = s.match(/^([a-zA-Z][\w-]*)\.(\d+)$/);
    if (m) { steps.push({ css: m[1], idx: Number(m[2]) }); continue; }

    let css;
    if (s.startsWith('class.')) css = '.' + s.slice(6).split('.').join('.');
    else if (s.startsWith('id.')) css = '#' + s.slice(3);
    else if (s.startsWith('tag.')) css = s.slice(4);
    else css = s;
    steps.push({ css, idx: null });
  }
  return steps;
}

/** 按步骤逐级查询；带索引的步骤在「当前匹配集合」上取第 N 个 */
function querySteps(base, steps) {
  let cur = [base];
  for (const st of steps) {
    const next = [];
    for (const n of cur) {
      if (!n || typeof n.querySelectorAll !== 'function') continue;
      let found = [];
      try { found = [...n.querySelectorAll(st.css)]; } catch { found = []; }
      if (st.idx != null) {
        if (found[st.idx]) next.push(found[st.idx]);
      } else {
        next.push(...found);
      }
    }
    cur = next;
    if (!cur.length) break;
  }
  return cur;
}


function xpath(doc, ctxNode, expr) {
  const root = ctxNode || doc;
  try {
    const r = doc.evaluate(expr, root, null, ORDERED_NODE_SNAPSHOT, null);
    const arr = [];
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (n.nodeType === 3 || n.nodeType === 4) arr.push({ __text: n.nodeValue, nodeType: 3 });
      else arr.push(n);
    }
    return arr;
  } catch { return []; }
}

/** 从元素/对象取值 */
export function val(el, attr, baseUrl) {
  if (el == null) return '';
  if (el.__text != null) return String(el.__text).trim();
  if (typeof el !== 'object' || !el.nodeType) {
    if (attr && el && typeof el === 'object') return String(el[attr] ?? '');
    return typeof el === 'object' ? JSON.stringify(el) : String(el);
  }
  if (!attr || attr === 'text' || attr === 'ownText') {
    return (el.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  }
  if (attr === 'html' || attr === 'all') return el.innerHTML || '';
  if (attr === 'outerHtml') return el.outerHTML || '';
  if (attr === 'textNodes') {
    return [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim();
  }
  let v = el.getAttribute ? el.getAttribute(attr) : null;
  if (v == null && /^(src|href)$/i.test(attr)) {
    v = el.getAttribute('data-src') || el.getAttribute('data-original') ||
        el.getAttribute('data-echo') || el.getAttribute('data-url') ||
        el.getAttribute('data-lazy-src') || el.getAttribute('src');
  }
  if (v == null) return '';
  return String(v).trim();
}

/** ## 正则替换 */
function applyRepl(str, repl) {
  let r = String(repl || '');
  let flags = 'g';
  if (r.endsWith('###')) r = r.slice(0, -3);
  const i = r.indexOf('##');
  const pat = i >= 0 ? r.slice(0, i) : r;
  const rep = i >= 0 ? r.slice(i + 2) : '';
  if (!pat) return str;
  try { return String(str).replace(new RegExp(pat, flags), rep); }
  catch {
    try { return String(str).replace(new RegExp(pat), rep); }
    catch { return str; }
  }
}

function splitTop(s, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === sep[0] && s[i + 1] === sep[1]) { out.push(cur); cur = ''; i++; }
    else cur += s[i];
  }
  out.push(cur);
  return out;
}

const HAS_JS = /@js:|<js>/i;

/* 单条规则求值，返回 Element[] / string[] / 其他 */
function one(raw, ctx) {
  raw = String(raw).trim();
  if (!raw) return null;

  /* --- JS 规则：服务端执行 --- */
  if (HAS_JS.test(raw)) {
    let code = raw;
    const m = code.match(/^([\s\S]*?)(@js:|<js>)([\s\S]*?)(<\/js>)?$/i);
    let prefix = '';
    if (m) {
      prefix = m[1].trim();
      code = m[3];
    }
    // 规则可能是 "选择器@js:xxx"，先把前缀选择器跑出来作为 result
    let base = ctx;
    if (prefix) {
      const preCtx = { ...ctx };
      const v = one(prefix, preCtx);
      base = { ...ctx, result: normalizeForJs(v, ctx) };
    }
    // Legado 里 `result` 是当前步骤的上游结果：
    // 整页规则拿到页面 HTML，节点规则拿到该节点的 HTML
    const jsCtx = {
      ...base,
      result: base.node
        ? (base.node.outerHTML ?? base.node.innerHTML ?? base.node.textContent ?? '')
        : (base.html ?? ''),
    };
    const out = runJsRule(code, jsCtx);
    if (out === '' || out == null) return null;
    if (Array.isArray(out)) return out.map(x => (x && typeof x === 'object') ? x : String(x));
    return [String(out)];
  }

  let sel = raw, repl = null;
  const hi = raw.indexOf('##');
  if (hi > 0) { sel = raw.slice(0, hi); repl = raw.slice(hi + 2); }

  /* 整条规则就是属性名，作用于当前节点 */
  const pure = sel.trim().match(/^@([a-zA-Z][\w-]*)$/);
  if (pure) {
    const ns = ctx.node ? [ctx.node] : [];
    const vs = ns.map(n => val(n, pure[1], ctx.baseUrl)).filter(v => v !== '');
    return vs.length ? vs.map(s => repl ? applyRepl(s, repl) : s) : null;
  }

  let kind = 'css', body = sel.trim(), rawCss = false;
  if (/^@css:/i.test(body)) { kind = 'css'; body = body.slice(5).trim(); rawCss = true; }
  else if (body.startsWith('@@')) { kind = 'css'; body = body.slice(2).trim(); rawCss = true; }
  else if (/^@xpath:/i.test(body)) { kind = 'xpath'; body = body.slice(7).trim(); }
  else if (/^@json:/i.test(body)) { kind = 'json'; body = body.slice(6).trim(); }
  else if (/^@/.test(body)) return null;
  else if (body.startsWith('/') || body.startsWith('./')) kind = 'xpath';
  else if (body.startsWith('$')) kind = 'json';
  else if (body.startsWith(':')) { kind = 'regex'; body = body.slice(1); }

  /* --- JSON --- */
  if (kind === 'json') {
    let data;
    if (ctx.node && typeof ctx.node === 'object' && !ctx.node.nodeType) data = ctx.node;
    else data = ctx.json;
    if (data == null) {
      try { data = JSON.parse(ctx.html); } catch { return null; }
    }
    const arr = jp(data, body);
    if (!arr.length) return null;
    return arr.map(x => {
      if (x == null) return '';
      if (typeof x === 'object') return x;
      const s = String(x);
      return repl ? applyRepl(s, repl) : s;
    });
  }

  /* --- 整页正则 --- */
  if (kind === 'regex') {
    let m;
    try { m = String(ctx.html || '').match(new RegExp(body, 's')); } catch { return null; }
    if (!m) return null;
    const out = [m[1] != null ? m[1] : m[0]];
    return out.map(s => repl ? applyRepl(s, repl) : s);
  }

  /* 属性标记：a@href / sel > text */
  const ATTRS = /^(text|textNodes|html|all|ownText|outerHtml|innerHtml|href|src|title|alt|content|value|class|style|id|datetime|data-[\w-]+)$/i;
  let attr = null;
  const gt = body.match(/^(.*?)\s*>\s*(text|html|ownText|outerHtml|all)$/i);
  if (gt && gt[1].trim()) { body = gt[1].trim(); attr = gt[2]; }
  else {
    const am = body.match(/^([\s\S]+?)@([a-zA-Z][\w-]*)$/);
    if (am && am[1].trim()) {
      if (ATTRS.test(am[2])) { body = am[1].trim(); attr = am[2]; }
      else { body = am[1].trim() + ' > ' + am[2]; }
    }
  }
  if (!attr && ctx.node && /^(text|html|ownText|outerHtml|all|href|src|title|alt|content|value|data-src|data-original)$/i.test(body)) {
    attr = body; body = '';
  }

  let nodes = [];
  if (!body) {
    nodes = ctx.node ? [ctx.node] : (ctx.doc ? [ctx.doc.documentElement] : []);
  } else if (kind === 'xpath') {
    nodes = xpath(ctx.doc, ctx.node, body);
  } else {
    const base = ctx.node || ctx.doc;

    if (rawCss) {
      // @css: 是原生 CSS，不做 Legado 语法转换
      let css = body;
      let needText = null;
      const cm = css.match(/:contains\((["']?)([\s\S]*?)\1\)/);
      if (cm) { needText = cm[2]; css = css.replace(cm[0], '').trim(); }
      try {
        nodes = base && base.querySelectorAll ? [...base.querySelectorAll(css)] : [];
        if (needText) nodes = nodes.filter(n => (n.textContent || '').includes(needText));
      } catch { nodes = []; }
    } else {
      nodes = querySteps(base, buildSteps(body));
    }

    // text.xxx 按文本匹配，走 XPath
    if (!nodes.length && /\btext\./.test(body) && !rawCss) {
      const xp = toXPath(body);
      if (xp) nodes = xpath(ctx.doc, ctx.node, xp);
    }
    // CSS 没查到时退回 XPath 再试一次
    if (!nodes.length && !rawCss) {
      const xp = toXPath(body);
      if (xp) nodes = xpath(ctx.doc, ctx.node, xp);
    }
  }

  if (!nodes || !nodes.length) {
    // 列表项本身就是 <a>，规则却写 tag.a@href，退回取自身属性
    if (attr && ctx.node && ctx.node.getAttribute) {
      const v = val(ctx.node, attr, ctx.baseUrl);
      if (v) return [repl ? applyRepl(v, repl) : v];
    }
    return null;
  }

  if (attr) {
    const out = nodes.map(n => val(n, attr, ctx.baseUrl)).filter(v => v !== '' && v != null);
    return out.length ? out.map(s => repl ? applyRepl(s, repl) : s) : null;
  }
  return nodes;
}

/** 给 JS 规则准备 result：元素转成 HTML 字符串更贴近 Legado */
function normalizeForJs(v, ctx) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (!v.length) return '';
    if (typeof v[0] === 'string') return v.join('\n');
    if (v[0] && v[0].nodeType) return v.map(n => n.outerHTML ?? n.textContent ?? '').join('\n');
    return JSON.stringify(v);
  }
  return String(v);
}

export function str(rule, ctx) {
  if (rule == null) return '';
  const s = String(rule).trim();
  if (!s) return '';
  for (const branch of splitTop(s, '||')) {
    const v = one(branch, ctx);
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      const first = v[0];
      let r = '';
      if (typeof first === 'string') r = first;
      else if (first && first.nodeType) r = val(first, 'text', ctx.baseUrl);
      else if (first && first.__text != null) r = String(first.__text);
      else if (first && typeof first === 'object') r = JSON.stringify(first);
      if (r) return r;
    }
  }
  return '';
}

export function list(rule, ctx) {
  if (!rule) return [];
  const s = String(rule).trim();
  for (const branch of splitTop(s, '||')) {
    const v = one(branch, ctx);
    if (Array.isArray(v) && v.length) {
      if (typeof v[0] === 'string') {
        // JS / JSON 返回的字符串：能 parse 成对象数组就展开
        const joined = v.join('\n').trim();
        if (joined.startsWith('[') || joined.startsWith('{')) {
          try {
            const parsed = JSON.parse(joined);
            if (Array.isArray(parsed)) {
              return parsed.map(x => (typeof x === 'object' && x) ? x : fakeEl(String(x)));
            }
          } catch { /* 不是 JSON */ }
        }
        return v.map(t => fakeEl(t));
      }
      return v.filter(x => x && typeof x === 'object');
    }
  }
  return [];
}

function fakeEl(text) {
  return { __text: text, nodeType: 1, getAttribute: () => null, querySelectorAll: () => [] };
}

export function abs(u, base) {
  if (!u) return '';
  u = String(u).trim();
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  try { return new URL(u, base || 'https://localhost/').href; }
  catch { return u; }
}

export function url(rule, ctx) {
  if (!rule) return '';
  let s = String(rule).trim();

  // 纯 JS 规则
  if (/^<js>[\s\S]*<\/js>$/i.test(s) || /^@js:/i.test(s)) {
    let code = s.replace(/^<js>/i, '').replace(/<\/js>$/i, '').replace(/^@js:/i, '');
    const out = runJsRule(code, ctx);
    return abs(String(out == null ? '' : out).trim(), ctx.baseUrl);
  }

  if (s.includes('{{')) {
    s = s.replace(/\{\{([\s\S]*?)\}\}/g, (m, inner) => {
      inner = inner.trim();
      if (!inner) return '';
      if (/^@js:|^<js>|java\./i.test(inner)) {
        let code = inner.replace(/^@js:/i, '').replace(/^<js>/i, '').replace(/<\/js>$/i, '');
        const out = runJsRule(code, ctx);
        return out == null ? '' : String(out);
      }
      return str(inner, ctx) || '';
    });
  } else {
    s = str(s, ctx);
  }
  return abs(s, ctx.baseUrl);
}

export function makeCtx(res, baseUrl, extra = {}) {
  const html = res.text || '';
  const doc = mkDoc(html);
  return {
    doc,
    node: null,
    baseUrl: baseUrl || res.url || '',
    html,
    json: res.json ?? null,
    ...extra,
  };
}

/* 把规则引擎回注给 JS 执行环境，jsengine 内部要用 java.getString() 等能力 */
registerRuleEngine({ str, list, mkDoc });
