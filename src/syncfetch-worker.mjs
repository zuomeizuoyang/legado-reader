/**
 * 同步抓取 worker：在独立线程里做异步 fetch，结果写进 SharedArrayBuffer。
 * 协议见 syncfetch.mjs。
 */
import { workerData } from 'node:worker_threads';
import { decodeBuffer } from './proxy.mjs';
import { assertPublicUrl, guardEnabled } from './ssrf.mjs';

const { sab } = workerData;
const ctl = new Int32Array(sab, 0, 2);
const region = new Uint8Array(sab, 8);
const dataBytes = region.length;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function writeBack(obj) {
  let out = Buffer.from(JSON.stringify(obj), 'utf8');
  // 数据区前 4 字节留给 seq
  const cap = dataBytes - 4;
  if (out.length > cap) {
    out = Buffer.from(JSON.stringify({
      ...obj,
      text: (obj.text || '').slice(0, 200) + '…[响应过大已截断]',
      truncated: true,
    }), 'utf8');
    if (out.length > cap) out = out.subarray(0, cap);
  }
  new DataView(sab, 8, 4).setUint32(0, obj.seq >>> 0, true);
  region.set(out, 4);
  Atomics.store(ctl, 1, out.length + 4);
  Atomics.store(ctl, 0, 2);
  Atomics.notify(ctl, 0);
}

async function handle(req) {
  const seq = req.seq >>> 0;
  try {
    // 书源脚本里 java.ajax 的目标同样要过出站校验：
    // 恶意/被改坏的书源不能借这条同步通道去读本机与内网服务。
    if (guardEnabled()) await assertPublicUrl(req.url);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 14000);
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      body: req.method && req.method !== 'GET' ? req.body : undefined,
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(req.headers || {}),
      },
    });
    clearTimeout(timer);

    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    const ctCharset = (ct.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || '';

    if (req.binary) {
      // 二进制不适用这个通道，交给调用方走异步
      writeBack({ seq, status: res.status, url: res.url, contentType: ct, error: 'java.ajax 不支持二进制' });
      return;
    }

    writeBack({
      seq,
      status: res.status,
      ok: res.ok,
      url: res.url || req.url,
      contentType: ct,
      text: buf.length ? decodeBuffer(buf, ctCharset) : '',
    });
  } catch (e) {
    writeBack({ seq, status: 0, error: e.name === 'AbortError' ? '请求超时' : (e.message || '请求失败') });
  }
}

// 循环等待主线程投递请求。state 1 = 有请求待处理。
while (true) {
  Atomics.wait(ctl, 0, 0, 30000);
  if (Atomics.load(ctl, 0) !== 1) continue;
  const len = Atomics.load(ctl, 1);
  if (len <= 0 || len > dataBytes) {
    Atomics.store(ctl, 0, 0);
    continue;
  }
  let req;
  try {
    req = JSON.parse(Buffer.from(region.subarray(0, len)).toString('utf8'));
  } catch {
    Atomics.store(ctl, 0, 0);
    continue;
  }
  try {
    await handle(req);
  } catch (e) {
    writeBack({ seq: req.seq, status: 0, error: String(e && e.message || e) });
  }
}
