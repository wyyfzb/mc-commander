/**
 * loopback 端口探测：判断端口在**任一** loopback 地址上是否已被监听。
 *
 * 为什么不能只探 127.0.0.1：监听方绑哪个地址族不由调用方决定——vite dev 默认绑 `localhost`，
 * 而它解析到 IPv4 还是 IPv6 取决于运行环境的 /etc/hosts 与 getaddrinfo 顺序（GitHub runner 的
 * `::1` 行含 localhost，本机该行不含）⇒ 同一份代码在 runner 上只绑 IPv6。实测该形态下
 * connect 127.0.0.1 报 ECONNREFUSED，只探 IPv4 会把「服务已起」判成「没起」并空等超时。
 * 逐族探测、任一通即算已监听，与浏览器加载 http://localhost 时的双栈回退同构。
 *
 * 探测必须在本进程内做：走子进程 + 管道 stdio 的实现在受限沙箱（子进程禁开管道）下恒返回
 * false ⇒ 必然报「端口等待超时」，把真因掩盖成「端口没起来」。
 */
import { connect } from 'node:net'

/** 候选 loopback 地址，顺序即探测顺序；未启用 IPv6 的环境里 ::1 会立刻 ECONNREFUSED，不影响结论 */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1']

/** 单个地址是否可连上（TCP connect 成功即算，不关心其上跑的是什么服务） */
export function probeHost(port, host, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 任一候选地址可连上即 true */
export async function portOpen(port) {
  for (const host of LOOPBACK_HOSTS) {
    if (await probeHost(port, host)) return true
  }
  return false
}
