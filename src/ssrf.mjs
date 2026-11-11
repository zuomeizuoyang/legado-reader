/**
 * 出站地址白名单（防 SSRF）。
 *
 * 起因：/api/proxy 和 /api/img 接受客户端传进来的任意 URL，
 * 以前直接抓取，等于给公网留了一个「读服务器本机 / 内网」的把手：
 *   /api/proxy?url=http://127.0.0.1:3000/api/state
 *   /api/proxy?url=http://169.254.169.254/latest/meta-data/
 *
 * 这里在校验阶段就把目标挡掉：
 *   1. 只放行 http / https，不允许带账号密码（user:pass@ 常用来绕 host 解析）
 *   2. 域名先解析成 IP，再按 IP 判私网（域名指向内网同样拦）
 *   3. 重定向逐跳复检（第一跳是公网、第二跳跳回内网是最常见的绕法）
 *
 * 想在本机调试私网书源时，设 LEGADO_ALLOW_PRIVATE=1 放行。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 环境变量开关：需要一个显式动作才能关掉防护 */
export function guardEnabled() {
  const v = String(process.env.LEGADO_ALLOW_PRIVATE || '').trim().toLowerCase();
  return !(v === '1' || v === 'true' || v === 'yes');
}

/** IPv4 / IPv6 字面量是否落在私网、环回、链路本地、保留段 */
export function privateAddress(raw) {
  let ip = String(raw || '').replace(/^\[|\]$/g, '').toLowerCase();

  if (ip.includes(':')) {
    // IPv4-mapped（::ffff:127.0.0.1 / ::ffff:7f00:1）
    if (ip.startsWith('::ffff:')) {
      const tail = ip.slice(7);
      if (isIP(tail) === 4) return privateAddress(tail);
      const w = tail.split(':');
      if (w.length === 2) {
        const n = parseInt(w[0], 16) * 65536 + parseInt(w[1], 16);
        if (Number.isFinite(n)) {
          return privateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
        }
      }
    }
    // 只认全局单播 2000::/3；其余（::/128、::1、fe80::/10、fc00::/7、ff00::/8）一律当私网
    return !/^[23]/.test(ip);
  }

  const n = ip.split('.').map(Number);
  if (n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = n;
  return a === 0                            // 0.0.0.0/8
    || a === 10                             // 私有
    || a === 127                            // 环回
    || a >= 224                             // 组播 / 保留
    || (a === 169 && b === 254)             // 链路本地（含云厂商 metadata）
    || (a === 172 && b >= 16 && b <= 31)    // 私有
    || (a === 192 && b === 168)             // 私有
    || (a === 100 && b >= 64 && b <= 127)   // CGNAT
    || (a === 198 && (b === 18 || b === 19)) // 基准测试段
    || (a === 192 && b === 0);              // 192.0.0.0/24 保留
}

const DNS_TTL = 60 * 1000;
const dnsCache = new Map();   // host -> { at, addrs }

async function resolveHost(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL) return hit.addrs;
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error('域名解析失败：' + host);
  }
  if (!addrs || !addrs.length) throw new Error('域名解析失败：' + host);
  if (dnsCache.size > 500) dnsCache.clear();
  dnsCache.set(host, { at: Date.now(), addrs });
  return addrs;
}

/**
 * 校验一个出站地址；不合规直接抛错。
 * @returns {Promise<URL>}
 */
export async function assertPublicUrl(target) {
  let u;
  try {
    u = new URL(String(target || ''));
  } catch {
    throw new Error('非法地址：' + String(target || '').slice(0, 120));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http/https 地址');
  if (u.username || u.password) throw new Error('地址里不允许带账号密码');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('地址缺少主机名');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) {
    throw new Error('禁止访问本机或内网地址');
  }

  const v = isIP(host);
  const addrs = v ? [{ address: host, family: v }] : await resolveHost(host);
  for (const a of addrs) {
    if (privateAddress(a.address)) {
      throw new Error('禁止访问内网或本机地址（' + host + ' → ' + a.address + '）');
    }
  }
  return u;
}
