/**
 * 服务入口：静态站点 + 书源业务 API + 抓取代理 + 图片代理。
 *
 * 为什么要后端：书源规则里有大量 @js:（java.ajax / org.jsoup），
 * 浏览器既没有 Rhino 也没有跨域权限，只能在服务端跑。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchRaw } from './src/proxy.mjs';
import { run as engineRun, engineStats, warmup as engineWarmup } from './src/engine-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* =========================================================
   数据目录与代码目录分离
   ---------------------------------------------------------
   本地直接 `node server.mjs` 时默认仍是 ./data，行为不变；
   用 Docker / npx / 解压到只读位置时，用 DATA_DIR 指向可写目录。
   这样代码可以被升级覆盖，书架和阅读进度不会跟着丢——
   也保证了别人拿到的发行包里不含任何本机的私人书架。
   ========================================================= */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

// 随包发布的只读内置书源（永远躺在代码目录里）
const BUNDLED_PRESET = path.join(__dirname, 'data', 'classic.json');
// 实际生效的内置书源（在数据目录里，用户可自行替换；首次运行从上面铺一份）
const PRESET_FILE = path.join(DATA_DIR, 'classic.json');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// 公网部署时设置：只有带对 key 的请求才放行（首次访问后前端会记住）
const ACCESS_KEY = process.env.ACCESS_KEY || '';
let PRESET_CACHE = null;

/* 内置书源优先读数据目录（用户可覆盖），没有就退回随包的只读副本。 */
function presetPath() {
  try {
    if (fs.existsSync(PRESET_FILE)) return PRESET_FILE;
  } catch { /* 权限问题就退回包内副本 */ }
  return BUNDLED_PRESET;
}

/* =========================================================
   跨设备书架
   ---------------------------------------------------------
   书架本来只存在浏览器 IndexedDB 里，换台设备就是空的。
   这里用一个小 JSON 存一份，作为多设备对齐的锚点：
     · shelf   书架条目（不含目录，目录等点开再拉，省体积）
     · removed 删除墓碑，防止另一台设备把删掉的书又推回来
   文件落在 data/state.json；写不了（只读文件系统）就退化成内存态，
   进程活着期间多设备照样能对齐。
   ========================================================= */
const STATE_FILE = path.join(DATA_DIR, 'state.json');
// 书源也落一份在服务端：iOS「添加到主屏幕」的 PWA 是独立存储容器，
// 和 Safari 标签页的 IndexedDB 不互通，只存本地的话换个入口就全没了。
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');
let STATE = null;
let stateTimer = null;

/* 首次运行时把随包的内置书源铺到数据目录。
   两者本来就是同一个文件（本地开发、DATA_DIR 未设）时跳过，
   免得自己拷自己。 */
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn(`[data] 数据目录不可写：${DATA_DIR} — ${e.message}`);
    console.warn('[data] 书架与进度将只存在内存里，重启即丢。请检查挂载/权限。');
    return;
  }
  if (path.resolve(PRESET_FILE) === path.resolve(BUNDLED_PRESET)) return;
  if (fs.existsSync(PRESET_FILE)) return;
  try {
    fs.copyFileSync(BUNDLED_PRESET, PRESET_FILE);
    console.log(`[data] 已铺入内置书源 → ${PRESET_FILE}`);
  } catch (e) {
    console.warn(`[data] 内置书源复制失败（不影响启动，只是新设备没有预置源）：${e.message}`);
  }
}

function loadState() {
  if (STATE) return STATE;
  try {
    STATE = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    STATE = { shelf: [], removed: {}, updatedAt: 0 };
  }
  if (!Array.isArray(STATE.shelf)) STATE.shelf = [];
  if (!STATE.removed || typeof STATE.removed !== 'object') STATE.removed = {};
  return STATE;
}

function flushState() {
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(loadState()));
  } catch (e) { /* 只读盘：内存态仍可跨设备可见 */ }
}

/* 阅读进度会频繁上报，攒 300ms 再落盘，别把磁盘打成筛子 */
function scheduleFlush() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; flushState(); }, 300);
  if (stateTimer.unref) stateTimer.unref();
}

/* 合并规则：按 id 并集，同 id 取 updatedAt 更新的那份；
   带墓碑且墓碑时间不早于该条目的改动时间，就丢弃这条。 */
function mergeShelfState(body) {
  const st = loadState();
  if (body && body.reset === true) { st.shelf = []; st.removed = {}; }   // 测试/维护用：整份重置
  const items = Array.isArray(body.shelf) ? body.shelf : [];
  const removed = Array.isArray(body.removed) ? body.removed : [];
  const now = Date.now();

  for (const id of removed) {
    if (id) st.removed[String(id)] = now;
  }

  const byId = new Map(st.shelf.filter(b => b && b.id).map(b => [b.id, b]));
  for (const it of items) {
    if (!it || !it.id) continue;
    const t = Number(it.updatedAt || it.addedAt || 0);
    const del = st.removed[it.id];
    if (del && del >= t) continue;          // 别的设备已经删除，且比这次改动更新
    const old = byId.get(it.id);
    if (!old || Number(old.updatedAt || old.addedAt || 0) <= t) byId.set(it.id, it);
  }

  // 墓碑生效：删掉时间不晚于墓碑的条目（删完再加回来的，addedAt 更新，能留下）
  for (const [id, b] of [...byId]) {
    const del = st.removed[id];
    if (del && del >= Number(b.updatedAt || b.addedAt || 0)) byId.delete(id);
  }

  // 墓碑只留最近 200 条，别让文件无限长
  const tombs = Object.entries(st.removed).sort((a, b) => b[1] - a[1]).slice(0, 200);
  st.removed = Object.fromEntries(tombs);

  st.shelf = [...byId.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  st.updatedAt = now;
  scheduleFlush();
  return st;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/* =========================================================
   订阅包导入辅助
   ========================================================= */

/** 站点详情页链接转成对应的 JSON 接口（书源聚合站常见这种跳转） */
function normalizePackUrl(u) {
  const s = String(u || '').trim();
  // .../content/id/1331.html  →  .../json/id/1331.json
  const m = s.match(/^(https?:\/\/[^/]+(?:\/[^?#]*?))\/content\/id\/(\d+)\.html/i);
  if (m) return `${m[1]}/json/id/${m[2]}.json`;
  return s;
}

function origin(u) {
  try { return new URL(u).origin + '/'; } catch { return ''; }
}

/**
 * 宽松解析书源包。很多站返回的是 HTML 包在 JSON 里的二次编码，
 * 或者带 BOM / 前后杂字符，这里按常见形态逐个试。
 */
function parseSourcePack(text) {
  let s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) throw new Error('返回内容为空');

  const toArray = d => {
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.bookSources)) return d.bookSources;
    if (d && Array.isArray(d.sources)) return d.sources;
    if (d && Array.isArray(d.data)) return d.data;
    if (d && (d.bookSourceUrl || d.sourceUrl)) return [d];
    return null;
  };

  let data = null;
  try { data = JSON.parse(s); } catch { /* 继续尝试 */ }

  // 二次编码：内容本身是一段 JSON 字符串
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* ignore */ } }

  if (data) {
    const arr = toArray(data);
    if (arr) {
      const kept = arr.filter(x => x && typeof x === 'object' && (x.bookSourceUrl || x.sourceUrl));
      if (!kept.length) throw new Error('JSON 里没有有效的书源（缺 bookSourceUrl）');
      return kept;
    }
  }

  // 从杂字符里截取 JSON 数组 / 对象
  const cands = [];
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) cands.push(s.slice(a, b + 1));
  const c = s.indexOf('{'), d = s.lastIndexOf('}');
  if (c >= 0 && d > c) cands.push(s.slice(c, d + 1));

  for (const cand of cands) {
    try {
      let v = JSON.parse(cand);
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* ignore */ } }
      const arr = toArray(v);
      if (arr && arr.length) {
        return arr.filter(x => x && typeof x === 'object' && (x.bookSourceUrl || x.sourceUrl));
      }
    } catch { /* 换下一个 */ }
  }

  throw new Error('不是合法的书源 JSON');
}

function readBody(req, limit = 8 * 1024 * 1024) {  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  // 防目录穿越
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(full).pipe(res);
  });
}

function checkKey(u, req) {
  if (!ACCESS_KEY) return true;
  const k = u.searchParams.get('k') || req.headers['x-access-key'] || '';
  return k === ACCESS_KEY;
}

/* 简单限流：同一 IP 的并发抓取不超过 8 */
const inflight = new Map();
function guard(ip) {
  const n = inflight.get(ip) || 0;
  // 公网部署时所有人可能共用反代 IP，阈值放宽；单机本地仍是防打满的作用
  if (n >= 40) return false;
  inflight.set(ip, n + 1);
  return true;
}
function unguard(ip) {
  const n = (inflight.get(ip) || 1) - 1;
  if (n <= 0) inflight.delete(ip); else inflight.set(ip, n);
}

/* =========================================================
   章节内容缓存 + 后台预取
   ---------------------------------------------------------
   实测：抓一章 0.5–3 秒（全在等源站网络），解析只要 10 毫秒。
   所以「点下一章 1 秒内出全文」不能靠优化解析，只能靠提前取。
   客户端在读第 N 章时把 N+1 的请求发过来，这里排队预取；
   用户真翻页时直接命中缓存，几十毫秒返回。
   ========================================================= */
const CH_TTL = 30 * 60 * 1000;   // 缓存半小时：一本书连着读足够
const CH_MAX = 500;              // 上限，超了按最久未用淘汰
const CH_CACHE = new Map();      // key -> { html, at }

function chKey(source, chapter) {
  return `${source.bookSourceUrl || ''}|${chapter.url || ''}|${JSON.stringify(source.ruleContent || {}).length}`;
}

function chGet(k) {
  const hit = CH_CACHE.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CH_TTL) { CH_CACHE.delete(k); return null; }
  hit.at = Date.now();          // LRU：命中即刷新
  return hit.html;
}

function chSet(k, html) {
  if (!html) return;
  if (CH_CACHE.size >= CH_MAX) {
    let oldK = null, oldAt = Infinity;
    for (const [kk, vv] of CH_CACHE) if (vv.at < oldAt) { oldAt = vv.at; oldK = kk; }
    if (oldK) CH_CACHE.delete(oldK);
  }
  CH_CACHE.set(k, { html, at: Date.now() });
}

// 预取队列 + 在途去重：同一章无论被预取还是被用户点开，都只抓一次
const PRE_INFLIGHT = new Set();
const CH_INFLIGHT = new Map();   // key -> Promise<html>
const PRE_QUEUE = [];
let preRunning = 0;

/** 取一章正文：先看缓存，再看有没有别的请求正在抓（合并），最后才真去抓 */
function loadChapter(source, chapter, baseUrl, priority = 'normal') {
  const k = chKey(source, chapter);
  const hit = chGet(k);
  if (hit) return Promise.resolve(hit);

  let p = CH_INFLIGHT.get(k);
  if (!p) {
    p = engineRun('content', [source, chapter, baseUrl], { priority })
      .then(html => { chSet(k, html); return html; })
      .finally(() => { CH_INFLIGHT.delete(k); });
    CH_INFLIGHT.set(k, p);
  }
  return p;
}

function warmChapter(source, chapter, book) {
  if (!source || !chapter || !chapter.url) return false;
  const k = chKey(source, chapter);
  if (CH_CACHE.has(k) || PRE_INFLIGHT.has(k)) return false;
  if (PRE_QUEUE.length > 200) return false;   // 防御：队列爆了就丢
  PRE_INFLIGHT.add(k);
  PRE_QUEUE.push({ k, source, chapter, book });
  pumpPrefetch();
  return true;
}

function pumpPrefetch() {
  // 只开 2 条并发，并且每个任务之间错开 200ms：
  // 同一批请求打太猛，源站会限速甚至挂住（实测冷抓偶发 10 秒以上）
  while (preRunning < 2 && PRE_QUEUE.length) {
    const job = PRE_QUEUE.shift();
    preRunning++;
    setTimeout(() => {
      loadChapter(job.source, job.chapter, job.book && job.book.bookUrl, 'low')
        .catch(() => { /* 预取失败无所谓，用户翻页时再正常走一次 */ })
        .finally(() => { PRE_INFLIGHT.delete(job.k); preRunning--; pumpPrefetch(); });
    }, 200);
  }
}

/* 详情/目录也缓存：info 常常要跑 JS 规则，实测能到 7 秒 */
const META_TTL = 10 * 60 * 1000;
const INFO_CACHE = new Map();
const TOC_CACHE = new Map();
const FEED_CACHE = new Map();          // 订阅源文章列表
const FEED_CONTENT_CACHE = new Map();  // 订阅文章正文

function metaGet(map, k) {
  const hit = map.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > META_TTL) { map.delete(k); return null; }
  hit.at = Date.now();
  return hit.v;
}
function metaSet(map, k, v, max = 100) {
  if (map.size >= max) {
    let oldK = null, oldAt = Infinity;
    for (const [kk, vv] of map) if (vv.at < oldAt) { oldAt = vv.at; oldK = kk; }
    if (oldK) map.delete(oldK);
  }
  map.set(k, { v, at: Date.now() });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  // 反代后面 remoteAddress 全是同一个网关，优先取真实来源
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || '?';

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,x-access-key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    }).end();
    return;
  }

  try {
    /* ---------- 健康检查（前端用它判断是否处于后端模式） ---------- */
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        mode: 'backend',
        version: '2.2.0',
        node: process.version,
        time: Date.now(),
        needKey: !!ACCESS_KEY,
        // 引擎跑在独立线程池里：这里能看到有没有积压、线程有没有被打死重开
        engine: engineStats(),
        // 缓存就是「翻章一秒内」的关键，暴露出来方便排查
        cache: { chapters: CH_CACHE.size, info: INFO_CACHE.size, toc: TOC_CACHE.size, prefetching: preRunning, queued: PRE_QUEUE.length },
      });
    }

    /* ---------- 内置书源（新设备首次打开直接可用，免去手动导入） ---------- */
    // 版本号 = 文件大小 + mtime。前端先查版本，变了才拉全量（内置源包接近 1MB）
    if (p === '/api/preset/version') {
      let v = '';
      try {
        const st = fs.statSync(presetPath());
        v = `${st.size}-${Math.floor(st.mtimeMs)}`;
      } catch { /* 文件没了就给空版本 */ }
      return json(res, 200, { version: v });
    }

    if (p === '/api/preset') {
      let preset = PRESET_CACHE;
      if (!preset) {
        try {
          const raw = fs.readFileSync(presetPath(), 'utf8');
          const parsed = JSON.parse(raw);
          preset = Array.isArray(parsed) ? parsed : (parsed.sources || []);
          PRESET_CACHE = preset;
        } catch (e) {
          return json(res, 500, { error: '内置书源读取失败：' + e.message, sources: [] });
        }
      }
      let version = '';
      try {
        const st = fs.statSync(presetPath());
        version = `${st.size}-${Math.floor(st.mtimeMs)}`;
      } catch { /* ignore */ }
      return json(res, 200, { sources: preset, total: preset.length, version });
    }

    /* ---------- 书架：拉取（手机加的书，电脑打开时从这里补上） ---------- */
    /* ---------- 书源：跨入口共享（Safari 与主屏 PWA 是两套存储） ---------- */
    if (p === '/api/sources' && req.method !== 'POST') {
      if (!checkKey(u, req)) return json(res, 401, { error: '需要访问口令' });
      try {
        const arr = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
        return json(res, 200, { sources: Array.isArray(arr) ? arr : [], total: Array.isArray(arr) ? arr.length : 0 });
      } catch {
        return json(res, 200, { sources: [], total: 0 });   // 还没存过
      }
    }

    if (p === '/api/state' && req.method !== 'POST') {
      if (!checkKey(u, req)) return json(res, 401, { error: '需要访问口令' });
      const st = loadState();
      return json(res, 200, {
        shelf: st.shelf,
        removed: Object.keys(st.removed),
        updatedAt: st.updatedAt || 0,
      });
    }

    /* ---------- 抓取代理（兼容纯前端模式的 URL 形态） ---------- */
    if (p === '/api/proxy') {
      if (!checkKey(u, req)) return json(res, 401, { error: '需要访问口令' });
      const target = u.searchParams.get('url');
      if (!target) return json(res, 400, { error: '缺少 url' });
      if (!guard(ip)) return json(res, 429, { error: '请求过于频繁' });
      try {
        const referer = u.searchParams.get('referer') || '';
        // guard:true —— 客户端给什么就抓什么的话，这就是一个「读本机/内网」的把手
        const r = await fetchRaw(target, { headers: referer ? { Referer: referer } : {}, guard: true });
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        return res.end(r.text || '');
      } catch (e) {
        return json(res, 400, { error: String((e && e.message) || e) });
      } finally { unguard(ip); }
    }

    /* ---------- 图片代理（解决防盗链 403） ---------- */
    if (p === '/api/img') {
      if (!checkKey(u, req)) return res.writeHead(401).end();
      const target = u.searchParams.get('url');
      if (!target) return res.writeHead(400).end();
      try {
        const referer = u.searchParams.get('referer') || (() => {
          try { return new URL(target).origin + '/'; } catch { return ''; }
        })();
        const r = await fetchRaw(target, {
          binary: true,
          headers: referer ? { Referer: referer } : {},
          timeout: 12000,
          guard: true,
        });
        res.writeHead(200, {
          'Content-Type': r.contentType || 'image/jpeg',
          'Content-Length': r.buf.length,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(r.buf);
      } catch (e) {
        return res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('图片抓取失败：' + e.message);
      }
    }

    /* ---------- 业务 API ---------- */
    if (p.startsWith('/api/') && req.method === 'POST') {
      if (!checkKey(u, req)) return json(res, 401, { error: '需要访问口令' });
      if (!guard(ip)) return json(res, 429, { error: '请求过于频繁' });
      try {
        const body = await readJson(req);

        /* 书源：整份存下来，供另一个入口（主屏 PWA / 另一台设备）拉取 */
        if (p === '/api/sources') {
          const arr = Array.isArray(body.sources) ? body.sources : [];
          try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(SOURCES_FILE, JSON.stringify(arr));
            return json(res, 200, { ok: true, total: arr.length });
          } catch (e) {
            return json(res, 500, { error: '书源保存失败：' + e.message });
          }
        }

        /* 书架：推上来并回传合并结果，调用方以此为准 */
        if (p === '/api/state') {
          const st = mergeShelfState(body);
          return json(res, 200, {
            ok: true,
            shelf: st.shelf,
            removed: Object.keys(st.removed),
            updatedAt: st.updatedAt,
          });
        }

        /* 订阅包导入：浏览器受 CORS 限制根本抓不到，
           而且书源整合包动辄几 MB，公共代理也撑不住，只能服务端来。 */
        if (p === '/api/import') {
          const raw = String(body.url || '').trim();
          if (!raw) return json(res, 400, { error: '缺少 url' });
          const target = normalizePackUrl(raw);
          if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: '只支持 http/https 链接' });

          const t0 = Date.now();
          let r;
          try {
            r = await fetchRaw(target, {
              timeout: 45000,
              retry: 0,
              guard: true,
              headers: { Referer: origin(target), Accept: 'application/json,text/plain,*/*' },
            });
          } catch (e) {
            return json(res, 502, { error: '下载失败：' + (e.message || e) + '（' + target + '）' });
          }

          let arr;
          try {
            arr = parseSourcePack(r.text);
          } catch (e) {
            const head = String(r.text || '').slice(0, 120).replace(/\s+/g, ' ');
            return json(res, 422, { error: e.message + '；返回内容开头：' + head });
          }

          return json(res, 200, {
            sources: arr,
            total: arr.length,
            bytes: Buffer.byteLength(r.text || ''),
            url: target,
            meta: { ms: Date.now() - t0 },
          });
        }

        if (p === '/api/search') {
          const { source, key, page } = body;
          if (!source || !source.searchUrl) return json(res, 400, { error: '缺少书源或 searchUrl' });
          const t0 = Date.now();

          try {
            const books = await engineRun('search', [source, String(key || ''), Number(page) || 1]);
            return json(res, 200, {
              books,
              meta: { source: source.bookSourceName, count: books.length, ms: Date.now() - t0 },
            });
          } catch (e) {
            // 单个源的规则跑不通是常态（几百个源的整合包里尤其多），
            // 不该当成服务端错误——否则浏览器控制台会被 500 刷满。
            // 但必须把原因带回去：warn 存在时前端会记成「源报错」而不是「没这本书」。
            return json(res, 200, {
              books: [],
              warn: String((e && e.message) || e),
              meta: { source: source.bookSourceName, count: 0, ms: Date.now() - t0 },
            });
          }
        }

        if (p === '/api/info') {
          const { source, book } = body;
          if (!source || !book) return json(res, 400, { error: '缺少参数' });
          const t0 = Date.now();
          const ck = `info|${source.bookSourceUrl || ''}|${book.bookUrl || ''}`;
          const hit = metaGet(INFO_CACHE, ck);
          if (hit) return json(res, 200, { info: hit, cached: true, meta: { ms: Date.now() - t0 } });
          const data = await engineRun('info', [source, book]);
          if (data && !data.error) metaSet(INFO_CACHE, ck, data);
          return json(res, 200, { info: data, meta: { ms: Date.now() - t0 } });
        }

        if (p === '/api/toc') {
          const { source, book, info: infoData, firstChapter, warm } = body;
          if (!source || !book) return json(res, 400, { error: '缺少参数' });
          const t0 = Date.now();
          const ck = `toc|${source.bookSourceUrl || ''}|${book.bookUrl || ''}`;
          const hit = metaGet(TOC_CACHE, ck);
          const data = hit || await engineRun('toc', [source, book, infoData]);
          if (!hit && data && Array.isArray(data.list) && data.list.length) metaSet(TOC_CACHE, ck, data);
          // 拿目录的同时就把第一章排进预取队列：读者开书那一刻正文往往已经在路上
          if (warm !== false && data && Array.isArray(data.list) && data.list.length) {
            const first = firstChapter && firstChapter.url ? firstChapter : data.list[0];
            warmChapter(source, first, book);
            if (data.list[1]) warmChapter(source, data.list[1], book);
          }
          return json(res, 200, { ...data, cached: !!hit, meta: { ms: Date.now() - t0 } });
        }

        if (p === '/api/content') {
          const { source, chapter, baseUrl, next, book } = body;
          if (!source || !chapter) return json(res, 400, { error: '缺少参数' });
          const t0 = Date.now();
          const ck = chKey(source, chapter);

          // 后面的章节先跑起来（并行），不用等当前这章抓完
          if (Array.isArray(next)) for (const c of next) warmChapter(source, c, book);

          const hit = chGet(ck);
          if (hit) return json(res, 200, { content: hit, cached: true, meta: { ms: Date.now() - t0 } });

          const html = await loadChapter(source, chapter, baseUrl);
          return json(res, 200, { content: html, meta: { ms: Date.now() - t0 } });
        }

        /* ---------- 订阅源（RSS / 网页） ---------- */
        if (p === '/api/feed') {
          const { source, sortUrl, page } = body;
          if (!source || !(source.sourceUrl || source.sortUrl)) return json(res, 400, { error: '缺少订阅源地址' });
          const t0 = Date.now();
          const ck = `feed|${source.sourceUrl || ''}|${sortUrl || ''}|${Number(page) || 1}`;
          const hit = metaGet(FEED_CACHE, ck);
          if (hit) return json(res, 200, { ...hit, cached: true, meta: { ms: Date.now() - t0 } });
          try {
            const data = await engineRun('feed', [source, { sortUrl: sortUrl || '', page: Number(page) || 1 }]);
            if (data && Array.isArray(data.items) && data.items.length) metaSet(FEED_CACHE, ck, data, 120);
            return json(res, 200, { ...data, meta: { ms: Date.now() - t0 } });
          } catch (e) {
            // 订阅源失效是常态，别当服务端错误
            return json(res, 200, {
              items: [], mode: 'error', url: '', nextUrl: '',
              warn: String((e && e.message) || e),
              meta: { ms: Date.now() - t0 },
            });
          }
        }

        if (p === '/api/feed/content') {
          const { source, article } = body;
          if (!source || !article) return json(res, 400, { error: '缺少参数' });
          const t0 = Date.now();
          const ck = `fch|${source.sourceUrl || ''}|${article.url || ''}`;
          const hit = metaGet(FEED_CONTENT_CACHE, ck);
          if (hit) return json(res, 200, { ...hit, cached: true, meta: { ms: Date.now() - t0 } });
          try {
            const data = await engineRun('feedContent', [source, article]);
            if (data && data.html) metaSet(FEED_CONTENT_CACHE, ck, data, 80);
            return json(res, 200, { ...data, meta: { ms: Date.now() - t0 } });
          } catch (e) {
            return json(res, 200, {
              html: String((article && article.content) || ''),
              why: 'error',
              warn: String((e && e.message) || e),
              meta: { ms: Date.now() - t0 },
            });
          }
        }

        /* 纯预取：立刻返回，正文在后台排队抓 */
        if (p === '/api/prefetch') {
          const { source, chapters, book } = body;
          if (!source || !Array.isArray(chapters)) return json(res, 400, { error: '缺少参数' });
          let queued = 0, cached = 0;
          for (const ch of chapters.slice(0, 5)) {
            if (!ch || !ch.url) continue;
            if (chGet(chKey(source, ch))) cached++;
            else if (warmChapter(source, ch, book)) queued++;
          }
          return json(res, 200, { queued, cached });
        }

        return json(res, 404, { error: '未知接口 ' + p });
      } finally { unguard(ip); }
    }

    /* ---------- 静态资源 ---------- */
    if (p === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }

    res.writeHead(405).end('method not allowed');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message || '服务内部错误' });
    else try { res.end(); } catch { /* ignore */ }
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  ensureDataDir();
  engineWarmup();          // 先把引擎线程拉起来，首个请求不用等 jsdom 加载
  const lines = [
    '',
    '  书源阅读 · 后端模式已启动',
    '  ─────────────────────────────',
    `  本机：   http://localhost:${PORT}`,
  ];
  for (const ip of lanAddresses()) lines.push(`  局域网： http://${ip}:${PORT}`);
  if (ACCESS_KEY) lines.push(`  口令：   ${ACCESS_KEY}（首次访问加 ?k=口令）`);
  lines.push(`  数据：   ${DATA_DIR}`);
  lines.push(`  内置源： ${presetPath()}`);
  lines.push(`  引擎：   ${JSON.stringify(engineStats())}`);
  lines.push('');

  const exposed = !/^(127\.0\.0\.1|localhost|::1)$/.test(HOST);
  if (exposed && !ACCESS_KEY) {
    lines.push('  !! 未设置 ACCESS_KEY，且正在监听全部网卡。');
    lines.push('     同一网络（或整个公网）的任何人都能拿这台机器当抓取代理，');
    lines.push('     流量和法律风险都算你的。对外提供访问请这样启动：');
    lines.push('       ACCESS_KEY=你的口令 PORT=8899 node server.mjs');
    lines.push('');
  }
  console.log(lines.join('\n'));
});
