/**
 * 书源引擎 worker：所有规则求值（含 vm 沙箱、jsdom 解析、java.ajax 阻塞）
 * 都在这个线程里跑。
 *
 * 为什么必须独立线程：
 *   java.ajax() 是同步语义，靠 Atomics.wait 真阻塞。以前它跑在 HTTP 主线程上，
 *   一个假书源（或者只是源站特别慢）就能把整个进程卡住——连健康检查、静态页
 *   都要排队等它。现在阻塞只卡住这个 worker，HTTP 线程永远在收发。
 *
 * 这里的进程级隔离：
 *   · 由 engine-host 用 --experimental-permission 启动（能写文件/起子进程都会被拒）
 *   · env 只透传 LEGADO_ALLOW_PRIVATE，其余环境变量（密钥之类）看不见
 *   · resourceLimits 限制堆大小，跑飞了就是线程崩掉，不会拖垮整机
 */
import { parentPort } from 'node:worker_threads';
import { search, info, toc, content } from './book.mjs';
import { feedArticles, feedContent } from './feed.mjs';

const OPS = { search, info, toc, content, feed: feedArticles, feedContent };

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'job') return;
  const { id, op, args } = msg;
  const fn = OPS[op];
  if (!fn) {
    parentPort.postMessage({ id, ok: false, error: '未知引擎操作：' + op });
    return;
  }
  try {
    const value = await fn(...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, ok: true, value });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: String((e && e.message) || e || '规则执行失败'),
      code: (e && e.code) || '',
    });
  }
});

parentPort.postMessage({ type: 'ready' });
