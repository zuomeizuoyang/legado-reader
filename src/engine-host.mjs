/**
 * 引擎线程池（主线程侧）。
 *
 * 职责只有三件：排队、限时、兜底重建。
 *   · 排队：同一时刻最多 ENGINE_WORKERS 个任务在跑，其余排队；队列满直接拒绝，
 *     免得一个疯掉的客户端把几百个书源请求堆进内存。
 *   · 限时：每个任务有硬超时，到点直接 terminate 那个线程——卡死的规则不能
 *     靠"再等一会儿"解决，只能把线程换掉。
 *   · 兜底重建：线程崩了（vm 内存炸、jsdom 异常）自动换新线程，主进程不受影响。
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKER_URL = new URL('./engine-worker.mjs', import.meta.url);

const SIZE = Math.max(1, Math.min(8, Number(process.env.ENGINE_WORKERS || 2)));
const QUEUE_MAX = Math.max(8, Number(process.env.ENGINE_QUEUE_MAX || 48));
const LOW_WATER = 6;      // 低优先级任务（预取）在队列超过这个数时直接放弃

const TIMEOUTS = {
  search: 30000,
  info: 30000,
  toc: 45000,
  content: 45000,
  feed: 30000,
  feedContent: 30000,
};

const slots = [];         // { worker, job, timer, started }
let queue = [];
let jobSeq = 0;
let permDenied = false;   // 当前 Node 不支持权限模型时，退化成普通 worker

function workerOptions() {
  const base = {
    // 只给引擎线程看它自己的开关，服务器上的其它环境变量（口令、token）一律不外泄
    env: { LEGADO_ALLOW_PRIVATE: String(process.env.LEGADO_ALLOW_PRIVATE || '') },
    resourceLimits: {
      maxOldGenerationSizeMb: Number(process.env.ENGINE_HEAP_MB || 256),
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  };
  if (permDenied) return base;
  // 权限模型：即使书源脚本跳出了 vm 沙箱，也只能读项目目录，写盘和起子进程都会被拒
  return {
    ...base,
    execArgv: [
      '--experimental-permission',
      `--allow-fs-read=${ROOT}`,
      '--allow-worker',       // jsengine 的 java.ajax 还要起一个同步抓取线程
    ],
  };
}

function spawnSlot() {
  let worker;
  try {
    worker = new Worker(WORKER_URL, workerOptions());
  } catch (e) {
    // 老版本 Node 不认 --experimental-permission，退回不加权限模型的线程
    if (!permDenied) {
      permDenied = true;
      console.error('[engine] 权限模型不可用，退回普通线程：', e.message);
      worker = new Worker(WORKER_URL, workerOptions());
    } else {
      throw e;
    }
  }

  const slot = { worker, job: null, timer: null, started: Date.now() };

  worker.on('message', (msg) => {
    if (!msg || msg.type === 'ready') return;
    const job = slot.job;
    if (!job || msg.id !== job.id) return;
    if (msg.ok) settle(slot, null, msg.value);
    else {
      const err = new Error(msg.error || '规则执行失败');
      if (msg.code) err.code = msg.code;
      settle(slot, err, null);
    }
  });

  worker.on('error', (e) => {
    const msg = String((e && e.message) || e);
    const job = slot.job;
    slot.job = null;
    clearTimeout(slot.timer);
    retire(slot);

    if (!permDenied && /permission|execArgv|ERR_WORKER_INVALID_EXEC_ARGV/i.test(msg) && !job) {
      permDenied = true;
      console.error('[engine] 权限模型启动失败，改走普通线程：', msg);
      dispatch();
      return;
    }
    console.error('[engine] 线程异常：', msg);
    if (job) job.reject(new Error('引擎线程异常：' + msg));
    dispatch();
  });

  // 线程退出（被 terminate 或自己退出）：把槽位清掉，别让调度器派活给死线程
  worker.on('exit', () => {
    const job = slot.job;
    slot.job = null;
    clearTimeout(slot.timer);
    retire(slot);
    if (job) job.reject(new Error('引擎线程已退出'));
    dispatch();
  });

  worker.unref?.();   // 线程不该单独撑住事件循环
  slots.push(slot);
  return slot;
}

function retire(slot) {
  slot.dead = true;
  slot.job = null;
  clearTimeout(slot.timer);
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  try { slot.worker.terminate(); } catch { /* ignore */ }
}

function settle(slot, err, value) {
  const job = slot.job;
  if (!job) return;
  slot.job = null;
  clearTimeout(slot.timer);
  slot.timer = null;
  if (err) job.reject(err); else job.resolve(value);
  dispatch();
}

function dispatch() {
  while (queue.length && slots.length < SIZE) {
    const before = slots.length;
    try {
      spawnSlot();
    } catch (e) {
      console.error('[engine] 线程创建失败：', e.message);
      break;
    }
    if (slots.length === before) break;
  }
  for (const slot of [...slots]) {
    if (slot.job || slot.dead) continue;
    const job = queue.shift();
    if (!job) return;
    slot.job = job;
    const limit = job.timeout || TIMEOUTS[job.op] || 30000;
    slot.timer = setTimeout(() => {
      if (slot.job !== job) return;
      console.error('[engine] 任务超时（' + job.op + ' ' + limit + 'ms），替换线程');
      job.reject(new Error('书源执行超时（' + Math.round(limit / 1000) + ' 秒），已中止'));
      retire(slot);
      dispatch();
    }, limit);
    if (slot.timer.unref) slot.timer.unref();
    try {
      slot.worker.postMessage({ type: 'job', id: job.id, op: job.op, args: job.args });
    } catch (e) {
      clearTimeout(slot.timer);
      slot.job = null;
      job.reject(new Error('引擎不可用：' + e.message));
    }
  }
}

/**
 * 执行一个引擎操作。
 * @param {'search'|'info'|'toc'|'content'} op
 * @param {any[]} args
 * @param {{timeout?:number, priority?:'normal'|'low'}} [opt]
 */
export function run(op, args = [], opt = {}) {
  const low = opt.priority === 'low';
  if (low && queue.length > LOW_WATER) {
    return Promise.reject(new Error('引擎繁忙，预取已跳过'));
  }
  if (queue.length >= QUEUE_MAX) {
    return Promise.reject(new Error('引擎排队过多，请稍后重试'));
  }
  return new Promise((resolve, reject) => {
    const job = { id: ++jobSeq, op, args, timeout: opt.timeout, resolve, reject };
    if (low) queue.push(job); else queue.unshift(job);   // unshift + shift = 后进先出，正常请求优先
    dispatch();
  });
}

export function engineStats() {
  return {
    workers: slots.length,
    busy: slots.filter(s => s.job).length,
    queued: queue.length,
    limit: SIZE,
    permissionModel: !permDenied,
  };
}

/** 预热：启动时就建好一个线程，首个请求不用等 jsdom 加载 */
export function warmup() {
  try { if (!slots.length) spawnSlot(); } catch (e) {
    console.error('[engine] 预热失败：', e.message);
  }
}
