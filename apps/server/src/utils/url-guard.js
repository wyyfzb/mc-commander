/**
 * URL SSRF 防护（url-guard）
 * - 拒绝指向私网/环回/链路本地/保留地址的 URL（IPv4 + IPv6 + localhost 主机名）
 * - DNS rebinding 防护：域名先解析，校验全部解析结果均为公网 IP 后才放行
 * - 纯函数无副作用，lookup 可注入便于测试
 */
import dns from 'dns';
import net from 'net';

// 私网/保留 IPv4 段（CIDR 表示：[网络地址, 掩码位数]）
const PRIVATE_IPV4_RANGES = [
  ['0.0.0.0', 8], // 本网络（含 0.0.0.0 未指定地址）
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // CGNAT 运营商级 NAT 共享地址
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地（含云元数据端点 169.254.169.254）
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议保留
  ['192.0.2.0', 24], // TEST-NET-1（文档保留）
  ['192.88.99.0', 24], // 6to4 中继任播（已废弃）
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 网络基准测试
  ['198.51.100.0', 24], // TEST-NET-2（文档保留）
  ['203.0.113.0', 24], // TEST-NET-3（文档保留）
  ['224.0.0.0', 3], // 组播 + 保留段（224.0.0.0 - 255.255.255.255）
];

/** IPv4 点分十进制 → 32 位无符号整数；非法返回 null */
function ipv4ToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function inPrivateIpv4(ip) {
  const value = ipv4ToLong(ip);
  if (value === null) return false;
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const baseVal = ipv4ToLong(base);
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (baseVal & mask);
  });
}

function isPrivateIpv6(ip) {
  const addr = ip.toLowerCase();
  // IPv4-mapped（::ffff:10.0.0.1 等）按映射的 IPv4 判定
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return inPrivateIpv4(mapped[1]);
  // WHATWG URL 序列化会把 IPv4-mapped 规范化为十六进制形式（::ffff:7f00:1）
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return inPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  if (addr === '::' || addr === '::1') return true; // 未指定 / 环回
  if (/^f[cd]/.test(addr)) return true; // 唯一本地 fc00::/7
  if (/^fe[89ab]/.test(addr)) return true; // 链路本地 fe80::/10
  if (/^ff/.test(addr)) return true; // 组播 ff00::/8
  if (addr.startsWith('64:ff9b')) return true; // NAT64 转换前缀（常用于内网访问）
  return false;
}

/** 是否私网/保留 IP 字面量（接受带方括号的 IPv6 形式） */
export function isPrivateIp(ip) {
  if (typeof ip !== 'string' || ip === '') return false;
  const bare = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return inPrivateIpv4(bare);
  if (net.isIPv6(bare)) return isPrivateIpv6(bare);
  return false;
}

/** 主机名是否为本机（localhost 及其子域） */
export function isLocalHostname(hostname) {
  const h = String(hostname).toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain';
}

/**
 * 地址对公网玩家是否可达（'public' | 'private'）。
 *
 * 判据只看**地址本身**，不看它从哪来：同一个 IP 无论是经 PUBLIC_IP 注入、写进
 * server.properties 的 server-ip，还是从本机网卡回退得到，都必须给出同一个答案。
 * 按来源判会出现「PUBLIC_IP=100.64.0.1 标 public、server-ip=100.64.0.1 却标 private」
 * 这类同值两判（实测），既误导用户又无法解释。
 *
 * 复用 isPrivateIp 的网段表：地址「能不能发给玩家」与「能不能作为出站目标」是
 * 同一套可达性语义，各写一份正则会漂移（如漏掉 100.64.0.0/10 CGNAT 段）。
 * 非 IP 的主机名按公网处理（域名正是玩家该用的形式），本机名按私网。
 */
export function addressReachability(host) {
  if (typeof host !== 'string' || host === '') return 'private';
  return isLocalHostname(host) || isPrivateIp(host) ? 'private' : 'public';
}

/**
 * 校验 URL 是否安全可投递（SSRF 防护核心）
 * - 仅允许 http/https 协议
 * - 主机名：拒绝 localhost 字面量与私网/保留 IP 字面量
 * - 域名：DNS 解析后校验全部地址均为公网（防 DNS rebinding）
 * @param {string} url 待校验 URL
 * @param {{lookup?: (host: string) => Promise<Array<{address: string, family: number}>>}} [opts]
 *        lookup 可注入（测试用）；默认 dns.promises.lookup all:true
 * @returns {Promise<{ok: true, resolved: string[]} | {ok: false, reason: string}>}
 */
export async function checkPublicUrl(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'URL 格式无效' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅允许 http/https 协议' };
  }

  const hostname = parsed.hostname;
  if (isLocalHostname(hostname)) {
    return { ok: false, reason: 'URL 指向本机地址（localhost），已拒绝' };
  }

  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isPrivateIp(bare)) {
      return { ok: false, reason: 'URL 指向私网/保留 IP 地址，已拒绝' };
    }
    return { ok: true, resolved: [bare] };
  }

  // 域名：解析后校验全部地址（防 DNS rebinding：解析结果含任一私网 IP 即拒绝）
  const lookup =
    opts.lookup || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
  let addresses;
  try {
    addresses = await lookup(bare);
  } catch {
    return { ok: false, reason: '域名解析失败' };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: '域名无可用解析记录' };
  }
  const resolved = addresses.map((a) => a.address);
  const blocked = resolved.find((ip) => isPrivateIp(ip));
  if (blocked) {
    return { ok: false, reason: '域名解析到私网/保留 IP 地址，已拒绝' };
  }
  return { ok: true, resolved };
}
