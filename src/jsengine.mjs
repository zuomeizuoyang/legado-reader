/**
 * Legado 书源 JS 规则执行环境。
 *
 * 原生「阅读」App 跑在 Rhino（Java 的 JS 引擎）里，规则可以直接调
 * `java.ajax()`、`org.jsoup.Jsoup.parse()` 这些 Java 能力。
 * 浏览器里没有这些东西，所以 80% 的书源在纯前端方案里直接失效。
 *
 * 这里在 Node 的 vm 沙箱里把这些能力仿真出来：
 *   - java.ajax / java.connect  → 同步 HTTP（走 Atomics 桥）
 *   - org.jsoup.Jsoup.parse     → jsdom 包装
 *   - java.getString(rule, html)→ 回调本项目的规则引擎
 *   - 加解密 / 编码 / cookie / 缓存等工具函数
 */
import vm from 'node:vm';
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import { JSDOM } from 'jsdom';
import { syncFetch } from './syncfetch.mjs';

let helpers = null;
/** 由 rules.mjs 注入，避免循环依赖 */
export function registerRuleEngine(h) { helpers = h; }

const memStore = new Map();
const cookieJar = new Map();

/* ---------------- 沙箱加固 ----------------
 * Node 的 vm 不是安全边界（官方 README 写得很清楚）。共享同一个进程时，
 * 只要书源脚本能摸到任意一个「宿主函数」，就能顺着 .constructor 拿到宿主
 * Function，然后 `Function('return process')()` —— 沙箱当场失效。
 *
 * 这里做四层收口，成本递增、收益也递增：
 *   1. 不把宿主内建对象递进沙箱（见 runJsRule 里的注释）
 *   2. 把每个交给脚本的宿主函数的原型链剪断（.constructor 变成 undefined）
 *   3. 脚本里 eval / new Function 直接禁用
 *   4. 引擎整体跑在另一个带权限模型的线程里（见 engine-host.mjs）——
 *      就算前面几层都被绕过，能做的也只剩"读项目目录 + 发网络请求"
 */

/** 剪断宿主函数回到宿主 Function 构造器的那一跳 */
function cutFunctionChain(fn) {
  if (typeof fn !== 'function') return;
  try { Object.setPrototypeOf(fn, null); } catch { /* 不可配置就跳过 */ }
}

/** 只处理我们自己塞进沙箱的对象，不往 jsdom / 宿主内建对象里乱走 */
function sealOwn(obj, depth = 0) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
  if (typeof obj === 'function') { cutFunctionChain(obj); return; }
  if (depth > 2) return;
  let names;
  try { names = Object.getOwnPropertyNames(obj); } catch { return; }
  for (const k of names) {
    if (k === 'constructor' || k === '__proto__' || k === 'prototype') continue;
    let d;
    try { d = Object.getOwnPropertyDescriptor(obj, k); } catch { continue; }
    if (!d) continue;
    const v = 'value' in d ? d.value : d.get;
    if (typeof v === 'function') cutFunctionChain(v);
    else if (v && typeof v === 'object' && depth < 2) sealOwn(v, depth + 1);
  }
}

function sealSandbox(sandbox) {
  for (const k of Object.keys(sandbox)) sealOwn(sandbox[k], 0);
  // 自己实现的 jsoup 兼容类：删掉 constructor 属性，堵住 doc.constructor 这条路
  for (const cls of [JqElements, JqElement, JqDocument]) {
    try { delete cls.prototype.constructor; } catch { /* ignore */ }
    cutFunctionChain(cls);
  }
}

/** 进沙箱第一件事：把明显通往宿主能力的名字全部改成"一碰就报错" */
const SANDBOX_BOOT = `(function(){
  var blocked = ['process','require','module','exports','global','Buffer','fetch',
                 'setTimeout','setInterval','setImmediate','queueMicrotask',
                 'WebAssembly','__dirname','__filename'];
  for (var i = 0; i < blocked.length; i++) {
    (function(k){
      try {
        Object.defineProperty(globalThis, k, {
          configurable: false,
          get: function(){ throw new Error('沙箱内不可用：' + k); }
        });
      } catch (e) { /* 已存在或不可配置，忽略 */ }
    })(blocked[i]);
  }
})();`;

/* ---------------- jsoup 兼容层 ---------------- */

class JqElements extends Array {
  size() { return this.length; }
  first() { return this[0] || null; }
  last() { return this[this.length - 1] || null; }
  get(i) { return this[i] || null; }
  text() { return this.map(e => e.text()).join(' ').trim(); }
  html() { return this.map(e => e.html()).join('\n'); }
  outerHtml() { return this.map(e => e.outerHtml()).join('\n'); }
  attr(k) { return this.length ? this[0].attr(k) : ''; }
  eachText() { return this.map(e => e.text()); }
  select(sel) {
    const out = new JqElements();
    for (const e of this) out.push(...e.select(sel));
    return out;
  }
  eq(i) { const r = new JqElements(); if (this[i]) r.push(this[i]); return r; }
  toString() { return this.outerHtml(); }
}

class JqElement {
  constructor(el) { this._el = el; }
  get node() { return this._el; }
  select(sel) {
    const out = new JqElements();
    try {
      for (const e of this._el.querySelectorAll(sel)) out.push(new JqElement(e));
    } catch { /* 非法选择器 */ }
    return out;
  }
  text() { return (this._el.textContent || '').replace(/\s+/g, ' ').trim(); }
  ownText() {
    return [...this._el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim();
  }
  html() { return this._el.innerHTML || ''; }
  outerHtml() { return this._el.outerHTML || ''; }
  attr(k) {
    if (k === 'text') return this.text();
    if (k === 'html') return this.html();
    const v = this._el.getAttribute(k);
    return v == null ? '' : v;
  }
  hasAttr(k) { return this._el.hasAttribute(k); }
  tagName() { return (this._el.tagName || '').toLowerCase(); }
  id() { return this._el.id || ''; }
  className() { return this._el.className || ''; }
  parent() { return this._el.parentElement ? new JqElement(this._el.parentElement) : null; }
  children() {
    const out = new JqElements();
    for (const c of this._el.children) out.push(new JqElement(c));
    return out;
  }
  next() { const n = this._el.nextElementSibling; return n ? new JqElement(n) : null; }
  prev() { const n = this._el.previousElementSibling; return n ? new JqElement(n) : null; }
  equals(o) { return o instanceof JqElement && o._el === this._el; }
  toString() { return this.outerHtml(); }
}

class JqDocument extends JqElement {
  constructor(doc) { super(doc.documentElement); this._doc = doc; }
  select(sel) {
    const out = new JqElements();
    try {
      for (const e of this._doc.querySelectorAll(sel)) out.push(new JqElement(e));
    } catch { /* ignore */ }
    return out;
  }
  getElementById(id) {
    const e = this._doc.getElementById(id);
    return e ? new JqElement(e) : null;
  }
  getElementsByClass(c) { return this.select('.' + c); }
  getElementsByTag(t) { return this.select(t); }
  getElementsByAttribute(k, v) { return this.select(`[${k}="${v}"]`); }
  title() { return (this._doc.querySelector('title')?.textContent || '').trim(); }
  body() { return new JqElement(this._doc.body || this._doc.documentElement); }
  head() { return new JqElement(this._doc.head || this._doc.documentElement); }
  html() { return this._doc.documentElement?.outerHTML || ''; }
  text() { return (this._doc.body?.textContent || '').replace(/\s+/g, ' ').trim(); }
}

const Jsoup = {
  parse(html) { return new JqDocument(new JSDOM(String(html || '')).window.document); },
  parseBodyFragment(html) { return new JqDocument(new JSDOM(`<body>${html || ''}</body>`).window.document); },
  clean(html) { return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ''); },
  isValid(html) { return /<\w+/.test(String(html || '')); },
};

/* ---------------- java.* 兼容层 ---------------- */

/** 按指定字符集做 percent 编码（GBK 站必需） */
function encodeWithCharset(str, charset) {
  const s = String(str ?? '');
  const cs = String(charset || '').toLowerCase();
  if (!cs || /^utf-?8$/.test(cs)) return encodeURIComponent(s);
  const norm = /^(gb2312|gbk|gb18030)$/.test(cs) ? 'gbk' : cs;
  try {
    if (!iconv.encodingExists(norm)) return encodeURIComponent(s);
    return [...iconv.encode(s, norm)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  } catch {
    return encodeURIComponent(s);
  }
}

/** Legado 支持 "url,{json}" 形式，逗号后跟请求配置 */
function splitUrlCfg(u) {
  const str = String(u ?? '');
  const i = str.indexOf(',{');
  if (i <= 0) return { url: str, cfg: null };
  try {
    return { url: str.slice(0, i), cfg: JSON.parse(str.slice(i + 1)) };
  } catch {
    return { url: str, cfg: null };
  }
}

function decodeB64(s) {
  const b = Buffer.from(String(s || ''), 'base64');
  const utf8 = b.toString('utf8');
  // 不是合法 UTF-8 就按 latin1 处理
  return /^\uFFFD/.test(utf8) || utf8.includes('\uFFFD') ? b.toString('latin1') : utf8;
}

function createJava(ctxApi) {
  const java = {
    ajax(url) {
      const { url: u, cfg } = splitUrlCfg(url);
      const headers = { ...ctxApi.headers(), ...((cfg && cfg.headers) || {}) };
      const r = syncFetch(u, {
        headers,
        method: (cfg && cfg.method) || 'GET',
        body: cfg && cfg.body ? cfg.body : null,
      });
      return r.text ?? '';
    },
    ajaxAll(urls) {
      return (urls || []).map(u => {
        try { return java.ajax(u); } catch { return ''; }
      });
    },
    connect(url) { return new Connection(String(url), ctxApi.headers()); },
    get(url, headers) {
      const { url: u, cfg } = splitUrlCfg(url);
      const r = syncFetch(u, {
        headers: { ...ctxApi.headers(), ...((cfg && cfg.headers) || {}), ...(headers || {}) },
      });
      return r.text ?? '';
    },
    post(url, body, headers) {
      const { url: u, cfg } = splitUrlCfg(url);
      const r = syncFetch(u, {
        method: 'POST',
        body: body == null ? '' : String(body),
        headers: { ...ctxApi.headers(), ...((cfg && cfg.headers) || {}), ...(headers || {}) },
      });
      return r.text ?? '';
    },
    getString(rule, html) {
      return ctxApi.resolveStr(rule, html);
    },
    getStringList(rule, html) {
      return ctxApi.resolveList(rule, html).map(x => ctxApi.toText(x));
    },
    getElement(rule, html) {
      return ctxApi.resolveList(rule, html)[0] || null;
    },
    getElements(rule, html) {
      return ctxApi.resolveList(rule, html);
    },
    put(k, v) { memStore.set(String(k), v); },
    get(k) { return memStore.has(String(k)) ? memStore.get(String(k)) : ''; },
    encodeURI(s, charset) { return encodeWithCharset(s, charset); },
    encodeURIComponent(s, charset) { return encodeWithCharset(s, charset); },
    base64Encode(s) { return Buffer.from(String(s ?? ''), 'utf8').toString('base64'); },
    base64Decode(s) { return decodeB64(s); },
    md5Encode(s) { return crypto.createHash('md5').update(String(s ?? ''), 'utf8').digest('hex'); },
    md5Encode16(s) { return crypto.createHash('md5').update(String(s ?? ''), 'utf8').digest('hex').slice(8, 24); },
    md5EncodeHex(s) { return java.md5Encode(s); },
    sha1Encode(s) { return crypto.createHash('sha1').update(String(s ?? ''), 'utf8').digest('hex'); },
    hexEncodeToString(s) { return Buffer.from(String(s ?? ''), 'utf8').toString('hex'); },
    hexDecodeToString(s) {
      const h = String(s ?? '').replace(/[^0-9a-f]/gi, '');
      return Buffer.from(h, 'hex').toString('utf8');
    },
    strToBytes(s) { return [...Buffer.from(String(s ?? ''), 'utf8')]; },
    bytesToStr(b) { return Buffer.from(b || []).toString('utf8'); },
    randomUUID() { return crypto.randomUUID(); },
    randomInt(max) { return Math.floor(Math.random() * (Number(max) || 1)); },
    timeFormat(t) {
      const d = new Date(Number(t) || Date.now());
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },
    log(...a) { ctxApi.log(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')); },
    toast(m) { ctxApi.log('[toast] ' + m); },
    longToast(m) { ctxApi.log('[toast] ' + m); },
    getCookie(u) { return cookieJar.get(String(u)) || ''; },
    setCookie(u, c) { cookieJar.set(String(u), String(c)); },
    androidId() { return '9774d56d682e549c'; },
    getWebViewUA() { return ctxApi.ua; },
    htmlFormat(s) {
      return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n').trim();
    },
    t2s(s) { return String(s ?? ''); },
    s2t(s) { return String(s ?? ''); },
    digestHex(algo, s) {
      const a = String(algo || 'md5').toLowerCase();
      return crypto.createHash(a === 'sha256' ? 'sha256' : a === 'sha1' ? 'sha1' : 'md5')
        .update(String(s ?? ''), 'utf8').digest('hex');
    },
    aesEncode(data, key, mode, iv) { return aesCrypt(true, data, key, mode, iv); },
    aesDecode(data, key, mode, iv) { return aesCrypt(false, data, key, mode, iv); },
  };
  return java;
}

function aesCrypt(enc, data, key, mode, iv) {
  try {
    const keyBuf = Buffer.from(String(key || ''), 'utf8');
    const k = crypto.createHash('md5').update(keyBuf).digest();
    const m = String(mode || 'AES/ECB/PKCS5Padding').toUpperCase();
    const cipherName = m.includes('CBC') ? 'aes-128-cbc' : 'aes-128-ecb';
    const ivBuf = m.includes('CBC') ? crypto.createHash('md5').update(String(iv || '')).digest() : null;
    if (enc) {
      const c = crypto.createCipheriv(cipherName, k, ivBuf);
      return Buffer.concat([c.update(String(data ?? ''), 'utf8'), c.final()]).toString('base64');
    }
    const d = crypto.createDecipheriv(cipherName, k, ivBuf);
    return Buffer.concat([d.update(Buffer.from(String(data ?? ''), 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return enc ? '' : String(data ?? '');
  }
}

/** java.connect(url) 的链式对象 */
class Connection {
  constructor(url, baseHeaders) {
    this.url = url;
    this._headers = { ...baseHeaders };
    this._method = 'GET';
    this._body = null;
    this._charset = null;
  }
  header(k, v) { this._headers[k] = v; return this; }
  headers(obj) { Object.assign(this._headers, obj || {}); return this; }
  method(m) { this._method = String(m).toUpperCase(); return this; }
  timeout(ms) { this._timeout = ms; return this; }
  charset(c) { this._charset = c; return this; }
  get() { return this._run().text ?? ''; }
  post(body) { this._method = 'POST'; this._body = body; return this; }
  postBody() { this._method = 'POST'; return this; }
  body(b) { this._body = b; return this; }
  bytes() { return [...Buffer.from(this._run().text ?? '', 'utf8')]; }
  text() { return this._run().text ?? ''; }
  get responseCode() { return this._run().status ?? 0; }
  get contentType() { return this._run().contentType ?? ''; }
  get responseMessage() { return ''; }
  getUrl() { return this.url; }
  _run() {
    if (this._cached) return this._cached;
    this._cached = syncFetch(this.url, {
      method: this._method,
      body: this._body,
      headers: this._headers,
      timeout: this._timeout,
    });
    return this._cached;
  }
}

/* ---------------- Packages.* ---------------- */

function createPackages(java) {
  return new Proxy({
    java: {
      lang: { System: { currentTimeMillis: () => Date.now() } },
      net: { URLEncoder: { encode: (s) => encodeURIComponent(String(s)) } },
      util: {
        Base64: {
          getEncoder: () => ({ encodeToString: (b) => Buffer.from(b || []).toString('base64') }),
          getDecoder: () => ({ decode: (s) => [...Buffer.from(String(s), 'base64')] }),
        },
        UUID: { randomUUID: () => crypto.randomUUID() },
      },
    },
    org: { jsoup: { Jsoup } },
    com: {},
  }, {
    get(t, k) { return k in t ? t[k] : {}; },
  });
}

/* ---------------- 主入口 ---------------- */

/**
 * 把书源脚本包装成可求值的函数。
 *
 * Rhino 的行为是「整段脚本最后一条语句的值就是返回值」，所以书源里常见
 * 这种写法（多行语句 + 最后一行裸表达式，没有 return）：
 *
 *   let a = 1;
 *   let b = a + 1;
 *   a + b;          ← 取值靠这句
 *
 * 这里按优先级尝试三种包装，哪一种能跑通用哪一种。
 */
function buildCandidates(src, jsLib = '') {
  const t = String(src || '').trim();
  const lib = String(jsLib || '').trim();
  const out = [];

  // 带 jsLib 的版本要排在最前面：规则里常直接调 jsLib 定义的函数（如 fqSearchUrl）
  const push = (body) => {
    const wrapped = `(function(){${body}})()`;
    if (lib) out.push(`(function(){${lib}\n;return ${wrapped};})()`);
    out.push(wrapped);
  };

  // ① 已经有 return 的，直接当函数体
  if (/\breturn\b/.test(t)) push(t);

  // ② 纯表达式
  push(` return (${t}); `);

  // ③ 语句块 + 把最后一条可执行语句改成 return
  const implicit = toImplicitReturn(t);
  if (implicit) push(implicit);

  // ④ 兜底：原样执行
  push(t);
  return out;
}

function toImplicitReturn(src) {
  const lines = src.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    // 块结构结尾（}）不能加 return
    if (line === '}' || line === '};' || line.endsWith('{')) return null;
    const body = line.replace(/;+\s*$/, '');
    if (!body) return null;
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    lines[i] = `${indent}return (${body});`;
    return lines.join('\n');
  }
  return null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Legado 的 source / book / chapter 是 Java 实体，规则里会调
 * getVariable() / getKey() 之类的方法。这里补上这些方法，
 * 让数据字段保持原样可读。
 */
function wrapEntity(obj, kind) {
  const o = Object.assign({}, obj || {});
  let vars = {};
  try {
    const raw = o.variable ?? o.variables ?? '';
    if (typeof raw === 'string' && raw.trim()) vars = JSON.parse(raw);
    else if (raw && typeof raw === 'object') vars = raw;
  } catch { vars = {}; }
  if (!vars || typeof vars !== 'object') vars = {};

  o.getVariable = (k) => (k === undefined || k === null ? vars : (vars[k] ?? ''));
  o.putVariable = (k, v) => { vars[k] = v; };
  o.getVariableStr = () => JSON.stringify(vars);
  o.getKey = () => o.bookSourceUrl || o.bookUrl || o.url || '';
  o.getName = () => o.bookSourceName || o.name || o.title || '';
  o.getUrl = () => o.bookSourceUrl || o.bookUrl || o.url || '';
  // 这些对象会直接出现在沙箱里，属性值会被脚本随便点。
  // 原型置空 + 函数剪链：book.constructor 不再是宿主 Object。
  for (const k of Object.keys(o)) cutFunctionChain(o[k]);
  try { Object.setPrototypeOf(o, null); } catch { /* ignore */ }
  return o;
}

export function runJsRule(code, ctx = {}) {
  const logs = [];
  const headerBag = {};

  const ctxApi = {
    ua: UA,
    log: (m) => { if (logs.length < 50) logs.push(String(m)); },
    headers: () => ({ ...headerBag }),
    toText(x) {
      if (x == null) return '';
      if (typeof x === 'string') return x;
      if (x.__text != null) return String(x.__text);
      if (x.text && typeof x.text === 'function') return x.text();
      if (x.nodeType) return (x.textContent || '').trim();
      if (typeof x === 'object') return JSON.stringify(x);
      return String(x);
    },
    resolveStr(rule, html) {
      if (!helpers) return '';
      const c = subCtx(html);
      return helpers.str(rule, c);
    },
    resolveList(rule, html) {
      if (!helpers) return [];
      const c = subCtx(html);
      return helpers.list(rule, c);
    },
  };

  function subCtx(html) {
    if (html == null || html === '') return ctx;
    const text = typeof html === 'string' ? html : String(html);
    return {
      ...ctx,
      html: text,
      doc: helpers.mkDoc(text),
      node: null,
      json: (() => {
        const t = text.trim();
        if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { return null; } }
        return null;
      })(),
    };
  }

  const java = createJava(ctxApi);

  const sandbox = {
    java,
    Packages: createPackages(java),
    org: { jsoup: { Jsoup } },
    Jsoup,
    result: ctx.result ?? '',
    baseUrl: ctx.baseUrl || '',
    book: wrapEntity(ctx.book, 'book'),
    chapter: wrapEntity(ctx.chapter, 'chapter'),
    source: wrapEntity(ctx.source, 'source'),
    bookSource: wrapEntity(ctx.source, 'source'),
    key: ctx.key ?? '',
    keyword: ctx.key ?? '',
    page: ctx.page ?? 1,
    // 书源变量（源里常用全局 getVariable('x') 读配置）
    getVariable: (k) => {
      let vars = {};
      try {
        const raw = (ctx.source || {}).variable;
        vars = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      } catch { vars = {}; }
      if (!vars || typeof vars !== 'object') vars = {};
      return k === undefined || k === null ? vars : (vars[k] ?? '');
    },
    putVariable: () => {},
    // 部分源用 getArguments(vars, 'key') 取配置项
    getArguments: (vars, k) => {
      if (vars == null) return '';
      if (k === undefined || k === null) return vars;
      try { return vars[k] ?? ''; } catch { return ''; }
    },
    getCookie: (u) => java.getCookie(u),
    removeCookie: () => {},
    setCookie: (u, c) => java.setCookie(u, c),
    cookie: { getCookie: (u) => java.getCookie(u), setCookie: (u, c) => java.setCookie(u, c) },
    cache: {
      get: (k) => java.get(k),
      put: (k, v) => java.put(k, v),
      getFromMemory: (k) => java.get(k),
      putMemory: (k, v) => java.put(k, v),
    },
    console: { log: (...a) => ctxApi.log(a.join(' ')), error: (...a) => ctxApi.log(a.join(' ')) },
    // 这里刻意不注入宿主的 JSON / Math / Object / Date / String…
    // 宿主的 `Object` 顺着 .constructor 一跳就是宿主 Function，等于把
    // `Function('return process')()` 直接递给书源脚本（原来的沙箱就是这么被穿透的）。
    // vm 新建的上下文自带一整套内建对象，普通规则照旧能用，不需要宿主版本。
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sealSandbox(sandbox);

  let out;
  const initialResult = sandbox.result;
  const candidates = buildCandidates(code, (ctx.source || {}).jsLib);
  for (const wrapped of candidates) {
    sandbox.result = initialResult;
    try {
      const context = vm.createContext(sandbox, {
        // 关掉字符串生成代码：沙箱内的 eval / new Function 一律拒绝。
        // 书源规则是"取页面字段"，正常用不到；真需要动态执行的源会在这里明确报错，
        // 而不是悄悄跑一段任意代码。
        codeGeneration: { strings: false, wasm: false },
      });
      try { new vm.Script(SANDBOX_BOOT).runInContext(context, { timeout: 1000 }); } catch { /* 屏蔽失败不致命 */ }
      const script = new vm.Script(wrapped, { filename: 'book-source-rule.js' });
      out = script.runInContext(context, { timeout: 8000 });
      break;
    } catch (e) {
      // 语法错误换下一种包装；运行时错误直接记录并停止
      if (e instanceof SyntaxError) continue;
      ctxApi.log('[JS 规则失败] ' + (e.message || e));
      if (process.env.LEGADO_DEBUG_JS) console.log('[js-error]', e.message);
      out = '';
      break;
    }
  }

  // Legado 另一种返回约定：脚本不 return，而是给 result 赋值
  if (out === undefined || out === null || out === '') {
    const r = sandbox.result;
    if (r !== initialResult && r != null && r !== '') out = r;
  }

  if (logs.length && process.env.LEGADO_DEBUG_JS) {
    console.log('[js]', logs.slice(0, 10).join(' | '));
  }

  if (out == null) return '';

  // jsoup 元素必须保留真实 DOM 引用：后续规则要在这些节点上继续查询。
  // 一旦 JSON 序列化，节点就丢了，bookList 这类规则会整条失效。
  if (out instanceof JqElements) {
    return [...out].map(e => (e instanceof JqElement ? e.node : e));
  }
  if (out instanceof JqElement) return [out.node];
  if (Array.isArray(out)) {
    return out.map(e => (e instanceof JqElement ? e.node : e));
  }

  if (typeof out === 'object') {
    try { return JSON.stringify(out); } catch { return ''; }
  }
  return String(out);
}
