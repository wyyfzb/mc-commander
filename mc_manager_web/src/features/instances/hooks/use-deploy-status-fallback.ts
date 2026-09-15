/**
 * 部署进度兜底查询（J29）：WS 是部署进度的主通道，断线即冻结、刷新页面会丢进度——
 * 本 hook 在挂载与 WS 断线期间查询服务端快照（GET /instances/deploy/status）补位：
 * - 挂载即查一次：刷新页面后不再回落步骤①（服务端仍在部署时进度视图照常恢复）
 * - WS 断线期间按 FALLBACK_POLL_INTERVAL_MS 轮询：断线不再等于进度冻结；
 *   WS 已连接时不轮询（WS 事件为准），部署终态后服务端返回空态 → 轮询自然失去意义
 * - 失败静默降级：保留最后一次已知进度，等下一轮重试（不打断已有展示）
 * - duplicateDeployBlocked：服务端在途 = 禁止再次发起部署（服务端注册表是唯一真值，
 *   页面残留进度/重连补发都可能让客户端误判空闲）
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGetDeployStatus } from '@/api/instances'
import { FALLBACK_POLL_INTERVAL_MS, queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useDeployStore } from '@/stores/deploy'
import { useServerStore } from '@/stores/server'

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
  const everConnected = useServerStore((s) => s.hasConnectedOnce)
  const applyDeployStatus = useDeployStore((s) => s.applyDeployStatus)
  const deploying = useDeployStore((s) => s.deploying)
  const recentActiveDeploy = useDeployStore((s) => s.recentActiveDeploy)

  const query = useQuery({
    queryKey: queryKeys.deployStatus(),
    queryFn: ({ signal }) => apiGetDeployStatus(config, signal, mockScenarioQuery()),
    enabled: connectionReady,
    // 轮询仅在「WS 曾连接过、当前断开、且本页进度视图正在展示」时开启：
    // 未展示进度时不轮询（正常路径由 WS 驱动），断线时长任务仍可见
    refetchInterval:
      !socketConnected && everConnected && deploying ? FALLBACK_POLL_INTERVAL_MS : false,
  })

  // 快照不做乐观渲染：仅在服务端确有在途部署时补位进度视图
  useEffect(() => {
    if (!query.data?.deploying) return
    applyDeployStatus(query.data)
  }, [query.data, applyDeployStatus])

  return {
    /** 服务端报告在途部署时阻止再次发起（挂载/断线兜底查询的结果） */
    duplicateDeployBlocked: recentActiveDeploy !== null,
  }
}
