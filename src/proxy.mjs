/**
 * 抓取层：服务端直连目标站点，绕开浏览器 CORS。
 * 负责：超时、重试、自定义 Header、字符集探测（GBK/Big5）、内存缓存。
 */
import iconv from 'iconv-lite';
import { assertPublicUrl, guardEnabled } from './ssrf.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_HOPS = 5;

const CACHE_TTL = 3 * 60 * 1000;
const CACHE_MAX = 400;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  // LRU：命中后移到队尾
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, val) {
  cache.set(key, val);
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

/** 从 HTML 头部猜字符集 */
function sniffCharset(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)
    || head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i);
  return m ? m[1].toLowerCase() : '';
}

/** 统一成 iconv 认识的编码名 */
function normCharset(cs) {
  if (!cs) return '';
  cs = String(cs).toLowerCase().replace(/["'\s]/g, '');
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'gb18030') return 'gbk';
  if (cs === 'big5' || cs === 'big5-hkscs') return 'big5';
  if (cs === 'utf8' || cs === 'utf-8') return 'utf-8';
  return iconv.encodingExists(cs) ? cs : '';
}

/** 用某种编码解码，返回替换字符占比 */
function tryDecode(buf, cs) {
  const text = iconv.decode(buf, cs);
  const bad = (text.match(/\uFFFD/g) || []).length;
  return { text, ratio: text.length ? bad / text.length : 1 };
}

/**
 * 决定最终编码。
 *
 * 关键：UTF-8 是自校验编码，非 UTF-8 字节按 UTF-8 解码几乎必然产生 U+FFFD；
 * 而 GBK 是双字节编码，几乎任何字节流都能"成功"解码成汉字（只是乱码）。
 * 所以绝不能盲信 Content-Type 里的声明 —— 声明的 GBK 遇上真 UTF-8 内容，
 * 会解出「鍓戞潵」这种乱码却不带任何错误标记。
 *
 * 顺序：先严格试 UTF-8 → 再信声明 / meta → 最后兜底 GBK。
 */
export function decodeBuffer(buf, ctCharset) {
  // 1. UTF-8 自校验：通过就基本可以确定
  const utf8 = tryDecode(buf, 'utf-8');
  if (utf8.ratio < 0.005) return utf8.text;

  // 2. 不是 UTF-8，用声明或页面 meta 里的编码
  const declared = normCharset(ctCharset) || normCharset(sniffCharset(buf));
  if (declared && declared !== 'utf-8') {
    const r = tryDecode(buf, declared);
    if (r.ratio < 0.02) return r.text;
  }

  // 3. 兜底：谁的错误率低用谁
  const gbk = tryDecode(buf, 'gbk');
  if (gbk.ratio < utf8.ratio) return gbk.text;
  const big5 = tryDecode(buf, 'big5');
  if (big5.ratio < gbk.ratio) return big5.text;
  return utf8.text;
}

export async function fetchRaw(url, opt = {}) {
  const {
    timeout = 15000,
    headers = {},
    noCache = false,
    binary = false,
    retry = 1,
    method = 'GET',
    body = null,
    // guard：出站地址校验（默认开启，重定向逐跳复检）。私网书源调试可设 LEGADO_ALLOW_PRIVATE=1
    guard = opt.guard !== undefined ? opt.guard : guardEnabled(),
  } = opt;

  if (!/^https?:\/\//i.test(url)) throw new Error('非法 URL：' + url);

  const verb = String(method || 'GET').toUpperCase();
  const ck = 'raw:' + verb + ':' + url + '|' + JSON.stringify(headers) + (binary ? '|b' : '') + (body ? '|' + body : '');
  if (!noCache) {
    const hit = cacheGet(ck);
    if (hit) return hit;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    let target = url;          // 每次重试都从原地址重新开始
    let hops = 0;

    try {
      while (true) {
        if (guard) await assertPublicUrl(target);

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout);
        let res;
        try {
          const init = {
            signal: ac.signal,
            // 开了 guard 就自己跟重定向：fetch 的 follow 会把每一跳都藏起来，
            // 没法在跳转后复检目标地址（公网 → 内网 是最常见的绕法）
            redirect: guard ? 'manual' : 'follow',
            method: verb,
            headers: {
              'User-Agent': UA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              ...headers,
            },
          };
          if (verb !== 'GET' && body != null) {
            init.body = body;
            if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
              init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }
          }
          res = await fetch(target, init);
        } catch (e) {
          clearTimeout(timer);
          throw e;
        }
        clearTimeout(timer);

        if (guard && res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          try { await res.arrayBuffer(); } catch { /* 丢弃跳转响应体 */ }
          if (!loc) throw new Error('HTTP ' + res.status + ' 但没有 Location');
          if (++hops > MAX_HOPS) throw new Error('重定向次数过多');
          target = new URL(loc, target).href;
          continue;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('空响应');

        const ctFull = res.headers.get('content-type') || '';
        const ctCharset = (ctFull.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || '';

        const out = {
          status: res.status,
          ok: res.ok,
          url: res.url || target,
          contentType: ctFull,
        };

        if (binary) {
          out.buf = buf;
        } else {
          out.text = decodeBuffer(buf, ctCharset);
          out.buf = buf;
          const t = out.text.trim();
          if (t.startsWith('{') || t.startsWith('[')) {
            try { out.json = JSON.parse(t); } catch { /* 不是 JSON 就算了 */ }
          }
        }

        if (!res.ok) {
          const err = new Error('HTTP ' + res.status);
          err.status = res.status;
          // 4xx 不重试
          if (res.status >= 400 && res.status < 500) throw err;
          lastErr = err;
          break;      // 跳出 hop 循环，走下一次重试
        }

        if (!binary) cacheSet(ck, out);
        return out;
      }
    } catch (e) {
      lastErr = e;
      if (e.status >= 400 && e.status < 500) break;
      if (attempt < retry) await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error((lastErr && lastErr.message) || '请求失败：' + url);
}
