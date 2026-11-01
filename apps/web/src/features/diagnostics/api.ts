/**
 * 性能诊断域 API 函数（对照服务端 routes/perf.js 契约）。
 * 采集是同步长请求：服务端要等产物落地（perf 10 秒 / jfr 15 秒）才回包，
 * 故超时必须放大到客户端默认 10 秒之上，否则每次都在服务端还在采的时候就断开。
 */
import { apiPost, type ConnectionConfig } from '@/api/client'
import type { PerfSnapshotKind, PerfSnapshotResponse } from '@mc-commander/schemas'

/**
 * 一次快照请求的超时上限。
 * 服务端侧的上限是「窗口 + 30 秒落地等待」，这里再留 15 秒网络与排队余量：
 * 卡在客户端超时会让用户看到「网络错误」，而服务端其实已经把产物取到手了。
 */
const SNAPSHOT_TIMEOUT_MS = 90_000

/**
 * 取一次性能快照（POST：会在服务器上触发一次采集，不是幂等读取）。
 *
 * 刻意不提供「读前一次结果」的 GET：快照是**一次取样**，服务端不保留历史。
 * 刷新后结论消失是对的——留一个「看着像实时、其实是十分钟前的数」的面板
 * 会让用户按过期结论行动。
 */
export function apiTakePerfSnapshot(
  config: ConnectionConfig,
  instanceId: string,
  kind: PerfSnapshotKind,
  signal?: AbortSignal,
) {
  return apiPost<PerfSnapshotResponse>(
    `/api/v1/instances/${instanceId}/perf/snapshot`,
    config,
    { kind },
    { timeoutMs: SNAPSHOT_TIMEOUT_MS, signal },
  )
}
