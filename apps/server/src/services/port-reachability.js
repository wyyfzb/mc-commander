import net from 'node:net';
import { isPrivateIp, isLocalHostname } from '../utils/url-guard.js';

/**
 * 实例端口的外部可达性。
 *
 * 三层判据缺一不可：本地没在监听时，公网连不上是「服务器没启动」而不是「端口没放行」；
 * 只有本地在听、公网连不上，才能断定是云平台那一层拦住了。只探一层会把两种原因
 * 混成同一句提示，用户照着改也改不对。
 */
const PROBE_TIMEOUT_MS = 4000;

export const REACHABLE = 'reachable';
export const BLOCKED = 'blocked';
export const NOT_LISTENING = 'not_listening';
export const NO_PUBLIC_ADDRESS = 'no_public_address';

function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/** 本地端口是否真的在听——判「服务器没启动」与「端口没放行」的分界 */
export function isListeningLocally(port) {
  return tcpProbe('127.0.0.1', port);
}

/**
 * @returns {Promise<{state: string, detail: string, publicHost: string|null, port: number}>}
 */
export async function checkInstanceReachability({ port, publicHost }) {
  if (!Number.isInteger(port) || port <= 0) {
    return { state: NOT_LISTENING, detail: '实例端口未知', publicHost: null, port };
  }
  if (!publicHost || isPrivateIp(publicHost) || isLocalHostname(publicHost)) {
    // 面板自己都拿不到公网地址，就没有可判的外部入口——此时说「已可达」是编的
    return {
      state: NO_PUBLIC_ADDRESS,
      detail: '面板未配置公网地址',
      publicHost: publicHost || null,
      port,
    };
  }

  if (!(await isListeningLocally(port))) {
    return { state: NOT_LISTENING, detail: '服务器未运行，端口尚未监听', publicHost, port };
  }
  const ok = await tcpProbe(publicHost, port);
  return ok
    ? { state: REACHABLE, detail: '已确认可以从外网连接', publicHost, port }
    : { state: BLOCKED, detail: '本地已在监听，但外网连不进来', publicHost, port };
}
