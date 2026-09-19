/**
 * 部署进度 store 终态语义（src/stores/deploy.ts）：
 * 三个终态（complete/error/cancelled）都要收敛 deploying 与门控；取消终态还要落
 * 「已取消」结果位（不是失败），且取消中不被在途进度事件打断
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useDeployStore } from '../deploy'

const inFlight = {
  stage: 'download',
  percent: 0.3,
  transferred: 30,
  total: 100,
  instanceId: 'paper-abc1',
}

beforeEach(() => {
  useDeployStore.getState().resetDeploy()
})

describe('useDeployStore 终态收敛', () => {
  it('在途进度：deploying 与门控同真，实例归属随事件透传', () => {
    useDeployStore.getState().applyDeployProgress(inFlight)
    const s = useDeployStore.getState()
    expect(s.progress?.instanceId).toBe('paper-abc1')
    expect(s.deploying).toBe(true)
    expect(s.deployInFlight).toBe(true)
  })

  it('cancelled 终态：收敛 deploying 与门控，并落「已取消」结果位', () => {
    useDeployStore.getState().applyDeployProgress(inFlight)
    useDeployStore
      .getState()
      .applyDeployProgress({ stage: 'cancelled', percent: 0, transferred: 0, total: 0 })

    const s = useDeployStore.getState()
    expect(s.deploying).toBe(false)
    expect(s.deployInFlight).toBe(false)
    expect(s.cancelling).toBe(false)
    expect(s.progress?.stage).toBe('cancelled')
    expect(s.lastResult).toEqual({ ok: false, cancelled: true })
  })

  it('取消中收到在途进度：cancelling 保持真（按钮不闪回，避免重复取消请求）', () => {
    useDeployStore.getState().applyDeployProgress(inFlight)
    useDeployStore.getState().setCancelling(true)
    useDeployStore.getState().applyDeployProgress({ ...inFlight, percent: 0.4 })

    expect(useDeployStore.getState().cancelling).toBe(true)
    // 进度本身照常推进（取消尚未生效前用户仍应看到真实阶段）
    expect(useDeployStore.getState().progress?.percent).toBe(0.4)
  })

  it('取消回声（POST 409 TASK_CANCELLED）：走已取消结果位而不是失败', () => {
    useDeployStore.getState().startDeploy()
    useDeployStore.getState().setCancelling(true)
    useDeployStore.getState().finishDeploy({ ok: false, cancelled: true })

    const s = useDeployStore.getState()
    expect(s.lastResult).toEqual({ ok: false, cancelled: true })
    expect(s.progress?.stage).toBe('cancelled')
    expect(s.deploying).toBe(false)
    expect(s.cancelling).toBe(false)
  })

  it('取消回声不抹掉已到的收尾明细（WS 终态带的清理结果要留到界面）', () => {
    useDeployStore.getState().startDeploy()
    useDeployStore.getState().applyDeployProgress({
      stage: 'cancelled',
      percent: 0,
      transferred: 0,
      total: 0,
      error: '实例目录未能删除（EBUSY: resource busy）',
    })
    // POST 回声晚于 WS 终态到达：两者对同一终态的描述必须一致
    useDeployStore.getState().finishDeploy({ ok: false, cancelled: true })

    expect(useDeployStore.getState().progress?.error).toBe(
      '实例目录未能删除（EBUSY: resource busy）',
    )
  })

  it('WS 断线时靠回声 details 补收尾明细（否则会把「收尾未完成」显示成「已清理」）', () => {
    useDeployStore.getState().startDeploy()
    // 无 WS 终态事件，只有 POST 409 回声带出的 cleanup 明细
    useDeployStore.getState().finishDeploy({
      ok: false,
      cancelled: true,
      error: '实例目录未能删除（EBUSY: resource busy）',
    })
    expect(useDeployStore.getState().progress?.error).toBe(
      '实例目录未能删除（EBUSY: resource busy）',
    )
  })

  it('兜底快照空态：在途标记清空（服务端已无在途部署）', () => {
    useDeployStore.getState().applyDeployProgress(inFlight)
    useDeployStore.getState().setCancelling(true)
    useDeployStore.getState().applyDeployStatus({ deploying: false })

    const s = useDeployStore.getState()
    expect(s.deploying).toBe(false)
    expect(s.deployInFlight).toBe(false)
    expect(s.cancelling).toBe(false)
    expect(s.progress).toBeNull()
  })

  it('startDeploy 清掉上一轮的取消标记（新一轮部署不受上轮残留影响）', () => {
    useDeployStore.getState().setCancelling(true)
    useDeployStore.getState().startDeploy()
    expect(useDeployStore.getState().cancelling).toBe(false)
    expect(useDeployStore.getState().lastResult).toBeNull()
  })
})
