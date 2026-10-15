/**
 * loopback 探测必须逐地址族做——只探 IPv4 会把「服务已绑在 IPv6」判成「没起来」。
 *
 * 为什么需要这道测试：该缺陷在开发机上不可见（本机 /etc/hosts 的 `::1` 行不含 localhost，
 * 监听方一律绑 IPv4），只有 CI runner 暴露，代价是整条 CI 红一轮。这里用「自己绑 ::1 再探」
 * 把跨环境差异压回本进程，使回归在提交前就转红。
 */
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LOOPBACK_HOSTS, portOpen, probeHost } from '../vision/lib/loopback-probe.mjs'

let server = null

afterEach(async () => {
  if (server) {
    await new Promise((r) => server.close(r))
    server = null
  }
})

/** 绑到指定地址并让系统分配端口，返回该端口（免去猜一个「应该空闲」的固定端口） */
function listenOn(host) {
  return new Promise((resolve, reject) => {
    server = createServer(() => {})
    server.once('error', reject)
    server.listen(0, host, () => resolve(server.address().port))
  })
}

describe('loopback 端口探测', () => {
  it('监听在 IPv4 loopback 上时可探到', async () => {
    const port = await listenOn('127.0.0.1')
    expect(await portOpen(port)).toBe(true)
  })

  it('监听在 IPv6 loopback 上时同样可探到', async () => {
    const port = await listenOn('::1')
    expect(await portOpen(port)).toBe(true)
  })

  it('两个地址族都在候选里（只留 IPv4 会让上面的用例转红）', () => {
    expect(LOOPBACK_HOSTS).toContain('127.0.0.1')
    expect(LOOPBACK_HOSTS).toContain('::1')
  })

  it('无人监听时不误报为已监听', async () => {
    const port = await listenOn('127.0.0.1')
    await new Promise((r) => server.close(r))
    server = null
    expect(await portOpen(port)).toBe(false)
  })

  it('单地址探测只对实际绑定的那一族返回 true', async () => {
    const port = await listenOn('::1')
    expect(await probeHost(port, '::1')).toBe(true)
    expect(await probeHost(port, '127.0.0.1')).toBe(false)
  })
})
