/**
 * 实例总览的取数装配（聚合视图唯一取数点）。
 *
 * 只走既有两条端点：`GET /instances` 一次拿全部实例的完整状态，`GET /overview` 拿整机资源。
 * 刻意不逐台打 `GET /instances/:id`：列表端点返回的已经是同一份 toStatus() 产物，
 * 逐台再拉一遍是把同一份数据取 N+1 次，而每次 toStatus() 在服务端都要碰一次世界目录。
 *
 * 本 hook 复用 `queryKeys.instances()`——与顶栏/侧栏/实例页同一个缓存条目，切页不重发请求。
 * 声明成 `InstanceStatus[]` 而非 `InstanceSummary[]`：列表端点出参本就是完整状态
 * （服务端按 instanceStatusSchema 校验后回包），只是通用 hook 的类型写窄了。
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import { FALLBACK_POLL_INTERVAL_MS, queryKeys, useOverview } from '@/api/queries'
import { queryPhase, type QueryPhase } from '@/lib/query-phase'
import { useConnectionStore } from '@/stores/connection'
import type { InstanceStatus, OverviewData } from '@/api/types'

/** 全量实例状态（与 `useInstances()` 同键同源，仅类型更精确） */
function useFleetInstances() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.instances(),
    queryFn: ({ signal }) => apiGet<InstanceStatus[]>(`/api/v1/instances`, config, signal),
    enabled: config.status === 'ready',
    refetchInterval: FALLBACK_POLL_INTERVAL_MS,
  })
}

export interface FleetData {
  /** 全量实例状态（列表端点原样；页面据它排序与判定健康） */
  instances: InstanceStatus[]
  /** 整机资源；overview 未就绪时为 undefined（与「读到 0」区分） */
  overview: OverviewData | undefined
  /** 首帧未落定且无数据（清单给骨架） */
  isLoading: boolean
  /** 列表相位：失败且有旧值 ⇒ stale（保留主体 + 非阻断告警） */
  phase: QueryPhase
  listError: unknown
  refetchList: () => void
}

export function useFleetData(): FleetData {
  const instancesQuery = useFleetInstances()
  const overviewQuery = useOverview()

  return {
    instances: instancesQuery.data ?? [],
    overview: overviewQuery.data,
    // 有旧值时不退化成骨架：轮询抖动不该把整张清单换成占位
    isLoading: instancesQuery.isLoading && instancesQuery.data == null,
    phase: queryPhase(instancesQuery),
    listError: instancesQuery.error,
    refetchList: () => void instancesQuery.refetch(),
  }
}
