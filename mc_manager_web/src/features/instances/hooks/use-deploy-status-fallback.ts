/**
 * 部署进度兜底查询（J29）：WS 是部署进度的主通道，断线即冻结、刷新页面会丢进度——
 * 本 hook 在挂载与 WS 断线期间查询服务端快照（GET /instances/deploy/status）补位：
 * - 挂载即查一次：刷新页面后不再回落步骤①（服务端仍在部署时进度视图照常恢复）
 * - WS 断线期间按 FALLBACK_POLL_INTERVAL_MS 轮询：断线不再等于进度冻结；
 *   WS 已连接时不轮询（WS 事件为准），不产生冗余请求
 * - 空态必须落 store：服务端已无在途部署（部署完成或 15 分钟死快照超时）时，
 *   空态是收敛「部署中」视图与轮询的唯一真值，丢弃它会让进度永久冻结
 * - 失败静默降级：保留最后一次已知进度，等下一轮重试（不打断已有展示）
 * - duplicateDeployBlocked：服务端在途 = 禁止再次发起部署（服务端注册表是唯一真值，
 *   页面残留进度/重连补发都可能让客户端误判空闲）
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGetDeployStatus } from '@/api/instances'
import { FALLBACK_POLL_INTERVAL_MS, queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useDeployStore } from '@/stores/deploy'
import { useServerStore } from '@/stores/server'

/**
 * 实时通道握手宽限期：冷启动即断线（反代未放行 Upgrade）与正常握手无法从
 * 「尚未连上」这一个瞬间区分，等满宽限期仍未连上才判定为不可用，
 * 否则降级横幅会在每次加载时闪一下
 */
export const WS_HANDSHAKE_GRACE_MS = 5_000

/**
 * e2e mock 场景开关（localStorage）：真实服务端忽略该参数，mock 据此返回在途快照，
 * 供 Playwright 复现「页面刷新/断线后服务端仍在部署」而无需改动全局 mock 状态。
 */
function mockScenarioQuery(): string {
  try {
    return localStorage.getItem('mcs-deploy-mock') === 'in-flight' ? '?mockInFlight=1' : ''
  } catch {
    return ''
  }
}

export function useDeployStatusFallback() {
  const config = useConnectionStore()
  const connectionReady = useConnectionStore((s) => s.status === 'ready')
  const socketConnected = useServerStore((s) => s.socketConnected)
  const hasConnectedOnce = useServerStore((s) => s.hasConnectedOnce)
  const applyDeployStatus = useDeployStore((s) => s.applyDeployStatus)
  const deploying = useDeployStore((s) => s.deploying)
  const deployInFlight = useDeployStore((s) => s.deployInFlight)
  const [graceElapsed, setGraceElapsed] = useState(false)

  const query = useQuery({
    queryKey: queryKeys.deployStatus(),
    queryFn: ({ signal }) => apiGetDeployStatus(config, signal, mockScenarioQuery()),
    enabled: connectionReady,
    // 轮询条件是「确有在途进展 + socket 未连接」：不以曾连接过为前提，否则冷启动
    // 即断线（反代未放行 Upgrade）时兜底从不轮询、挂载恢复的进度视图永久冻结
    refetchInterval:
      !socketConnected && (deploying || deployInFlight) ? FALLBACK_POLL_INTERVAL_MS : false,
  })

  // 快照（含空态）据实落 store：空态不得覆盖已有终态回执的判定在 store 内
  useEffect(() => {
    if (!query.data) return
    applyDeployStatus(query.data)
  }, [query.data, applyDeployStatus])

  // 从未连上的连接计时：到点仍未连上才算实时通道不可用（hasConnectedOnce 一旦为真
  // 就不会回退，故滞回标志无需复位，由下方派生条件负责失效）
  useEffect(() => {
    if (!connectionReady || socketConnected || hasConnectedOnce) return
    const timer = setTimeout(() => setGraceElapsed(true), WS_HANDSHAKE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [connectionReady, socketConnected, hasConnectedOnce])

  return {
    /** 服务端报告在途部署时阻止再次发起（WS 事件或挂载/断线兜底查询的结果） */
    duplicateDeployBlocked: deployInFlight,
    /** 实时通道超宽限期仍未建立（冷启动即断线的据实提示） */
    connectStalled: connectionReady && !socketConnected && !hasConnectedOnce && graceElapsed,
  }
}
