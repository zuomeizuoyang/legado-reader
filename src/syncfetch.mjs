/**
 * 同步抓取桥。
 *
 * Legado 书源里的 `java.ajax(url)` 是同步返回的（Rhino 环境）。
 * 而 Node 的 fetch 是异步的，同步代码里拿不到结果。
 *
 * 做法：主线程用 Atomics.wait 真阻塞，把请求写进 SharedArrayBuffer；
 * 常驻 worker 用异步 fetch 抓完后写回并 notify。主线程醒来直接读结果。
 *
 * 因为同步执行期间事件循环停转，天然串行，不存在并发冲突。
 */
import { Worker } from 'node:worker_threads';

const DATA_BYTES = 24 * 1024 * 1024; // 24MB 数据区，够放整章 HTML
const SAB = new SharedArrayBuffer(DATA_BYTES + 8);
const ctl = new Int32Array(SAB, 0, 2); // [0]=state, [1]=length
const region = new Uint8Array(SAB, 8);

const CTRL_STATE = 0;
const CTRL_LEN = 1;

let worker = null;
let seqCounter = 0;
let broken = false;

function ensureWorker() {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL('./syncfetch-worker.mjs', import.meta.url), {
      workerData: { sab: SAB },
    });
    worker.on('error', (e) => {
      console.error('[syncfetch] worker 异常：', e.message);
      broken = true;
    });
    worker.unref?.();
  } catch (e) {
    console.error('[syncfetch] 启动 worker 失败：', e.message);
    broken = true;
  }
  return worker;
}

/**
 * 同步抓取。只能在同步代码路径里调用。
 * @returns {{status:number, url:string, contentType:string, text:string}}
 */
export function syncFetch(url, opt = {}) {
  if (broken) throw new Error('同步抓取不可用');
  ensureWorker();
  if (!worker) throw new Error('同步抓取 worker 未就绪');

  const seq = ++seqCounter;
  const req = {
    seq,
    url,
    method: opt.method || 'GET',
    body: opt.body || null,
    headers: opt.headers || {},
    binary: !!opt.binary,
  };

  let payload;
  try {
    payload = Buffer.from(JSON.stringify(req), 'utf8');
  } catch (e) {
    throw new Error('请求序列化失败');
  }
  if (payload.length > DATA_BYTES - 1024) throw new Error('请求过大');

  region.set(payload, 0);
  Atomics.store(ctl, CTRL_LEN, payload.length);
  Atomics.store(ctl, CTRL_STATE, 1);
  Atomics.notify(ctl, CTRL_STATE);

  const timeout = opt.timeout || 15000;
  const w = Atomics.wait(ctl, CTRL_STATE, 1, timeout);

  if (w === 'timed-out') {
    // 尝试把状态复位，避免 worker 回写污染下一次
    Atomics.store(ctl, CTRL_STATE, 0);
    throw new Error('java.ajax 超时（' + timeout + 'ms）：' + url);
  }

  const state = Atomics.load(ctl, CTRL_STATE);
  const len = Atomics.load(ctl, CTRL_LEN);

  if (state === 0) {
    Atomics.store(ctl, CTRL_STATE, 0);
    throw new Error('同步抓取被中断');
  }
  if (len <= 0 || len > DATA_BYTES) {
    Atomics.store(ctl, CTRL_STATE, 0);
    throw new Error('同步抓取响应异常');
  }

  // 数据区前 4 字节是 seq 校验
  const seqBack = new DataView(SAB, 8, 4).getUint32(0, true);
  if (seqBack !== seq) {
    Atomics.store(ctl, CTRL_STATE, 0);
    throw new Error('同步抓取序号错位（seq ' + seqBack + ' ≠ ' + seq + '）');
  }

  const body = Buffer.from(region.subarray(4, len)).toString('utf8');
  Atomics.store(ctl, CTRL_STATE, 0);

  let resp;
  try {
    resp = JSON.parse(body);
  } catch (e) {
    throw new Error('同步抓取响应解析失败');
  }
  if (resp.error) {
    const err = new Error(resp.error);
    err.status = resp.status || 0;
    err.body = resp.text || '';
    throw err;
  }
  return resp;
}

export function shutdownSyncFetch() {
  try { worker?.terminate(); } catch { /* ignore */ }
  worker = null;
}
