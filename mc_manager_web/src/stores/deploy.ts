/**
 * 部署进度状态（WS deployProgress 事件落点 + HTTP 兜底快照）
 * - 部署流程：idle → deploying（POST 在途 + WS 进度 + 兜底快照）→ complete / error / cancelled
 * - 进度事件由 use-server-socket 分派（deployProgress case）
 * - WS 断线/刷新页面时由 use-deploy-status-fallback 查询服务端快照补位
 *   （applyDeployStatus），避免回落步骤①与重复发起部署
 * - 卸载（uninstallingId）为实例卡片按钮态，与部署无关
 */
import { create } from 'zustand'
import type { DeployProgress, DeployStatusResponse } from '@/api/types'

/** 部署阶段中文标签 */
export const DEPLOY_STAGE_LABELS: Record<string, string> = {
  download: '正在下载服务端核心…',
  download_complete: '下载完成，正在准备…',
  forge_install: '正在安装 Forge…',
  first_launch: '首次启动生成配置…',
  complete: '部署完成',
  error: '部署失败',
  cancelled: '部署已取消',
}

/** 部署结果（cancelled 与 ok:false 分开：用户取消不是失败，文案与配色都不同档） */
export interface DeployResultState {
  ok: boolean
  instanceId?: string
  error?: string
  cancelled?: boolean
}

interface DeployState {
  /** 当前进度（null = 无部署进行中） */
  progress: DeployProgress | null
  /** 部署中标记（POST 请求在途 / WS 事件 / 兜底快照报告在途） */
  deploying: boolean
  /** 最近一次部署结果（成功实例 id / 失败错误信息 / 已取消） */
  lastResult: DeployResultState | null
  /**
   * 服务端在途部署门控（true = 禁止再次发起部署）。与 deploying 分开：
   * deploying 还含本页 POST 的乐观置位（startDeploy），门控只认服务端真值。
   * 两个通道（WS deployProgress / 兜底快照）都必须写入本字段：只由快照单通道写会让
   * WS 报完终态、横幅消失后入口仍禁用，反向则漏掉仅由 WS 观察到的在途部署。
   * 故它是布尔而非实例归属对象：实例归属另存于 progress.instanceId
   * （取消部署需要它做服务端精确匹配）。
   */
  deployInFlight: boolean
  /** 取消请求已发出、终态事件未到（进度视图显示「正在取消…」并挡住重复点击） */
  cancelling: boolean
  /** 应用 WS deployProgress 事件（use-server-socket 调用） */
  applyDeployProgress: (p: DeployProgress) => void
  /** 应用 HTTP 兜底快照（use-deploy-status-fallback 调用；空态即服务端真值） */
  applyDeployStatus: (status: DeployStatusResponse) => void
  /** 部署开始（POST 发出前调用；进度回 0） */
  startDeploy: () => void
  /** 部署完成/失败/取消落定（POST 响应或取消终态事件后调用） */
  finishDeploy: (result: DeployResultState) => void
  /** 取消请求的在途标记（发出前置真、请求失败后置假） */
  setCancelling: (value: boolean) => void
  /** 重置（关闭部署对话框时清理） */
  resetDeploy: () => void
}

/** 部署终态：进度视图的收敛条件（deploying 不再为真） */
function isTerminalStage(stage: string | undefined): boolean {
  return stage === 'complete' || stage === 'error' || stage === 'cancelled'
}

export const useDeployStore = create<DeployState>()((set) => ({
  progress: null,
  deploying: false,
  lastResult: null,
  deployInFlight: false,
  cancelling: false,
  // 终态（complete/error/cancelled）不再延续 deploying：进度视图由 progress 终态驱动到
  // POST 响应落定（finishDeploy），避免刷新恢复场景下终态后 deploying 残留
  // 导致向导无法关闭（部署中禁关拦截读的就是 deploying）。门控随终态一并释放：
  // 部署可能由别处发起（另一客户端/别的标签页），WS 终态即服务端注册表已结束
  applyDeployProgress: (p) => {
    const inFlight = !isTerminalStage(p.stage)
    // 在途进度不改 cancelling：取消请求已发出但终态未到时，进度仍会继续推送
    // （下载每 1% 一次），清掉标记会让按钮闪回「取消部署」并诱发重复取消请求
    if (inFlight) return set({ progress: p, deploying: true, deployInFlight: true })
    return set({
      progress: p,
      deploying: false,
      deployInFlight: false,
      cancelling: false,
      // 取消终态先落 lastResult：本页 POST 的 409 回声随后经由 finishDeploy 到达，
      // 若没有它，视图会被改写成「部署失败」（用户动作被显示成故障）
      ...(p.stage === 'cancelled' ? { lastResult: { ok: false, cancelled: true } } : {}),
    })
  },
  // POST 已在本页给出终态结果（lastResult 非空）时兜底快照不再是真值来源：
  // 部署刚结束的窗口内服务端快照可能仍是最后一条在途记录，覆盖会把「部署成功」
  // 视图打回进度视图。快照仅在本次会话尚无结果时补位
  applyDeployStatus: (status) =>
    set((s) => {
      if (!status.deploying) {
        // 空态即服务端真值：清掉在途标记与门控（部署已终态/死快照超时），
        // 否则进度视图与 30s 轮询都不会收敛；progress 仅在确实在途时清空，
        // 已有终态展示位（deploying 已假）保留。本分支必须先于下面的终态回执守卫：
        // 终态后门控又被 WS 占回时，被守卫吞掉的空态会让入口永久禁用
        return {
          deploying: false,
          deployInFlight: false,
          cancelling: false,
          progress: s.deploying ? null : s.progress,
        }
      }
      if (s.lastResult !== null) return s
      return {
        progress: {
          stage: status.stage,
          percent: status.percent,
          transferred: status.transferred,
          total: status.total,
          ...(status.error ? { error: status.error } : {}),
          instanceId: status.instanceId,
          instanceName: status.instanceName,
          type: status.type,
          mcVersion: status.mcVersion,
        },
        deploying: true,
        deployInFlight: true,
      }
    }),
  startDeploy: () => set({ progress: null, deploying: true, lastResult: null, cancelling: false }),
  // 本页自己发起的部署已结束（POST 有响应）：清在途标记——服务端快照可能仍是
  // 最后一条在途记录，留着会一直禁用「部署新实例」（兜底查询的下一次真值到来前）。
  // 取消回声（TASK_CANCELLED）走 cancelled 分支：进度的终态事件可能已把视图
  // 切到「已取消」，此处不能把它覆盖成失败
  finishDeploy: (result) =>
    set((s) => {
      if (result.cancelled) {
        // 取消回声不覆盖已到的终态事件：WS 的 cancelled 事件可能带收尾结果
        // （收尾未完成时的明细），丢掉它界面就只剩「已清理」这一种说法。
        // 回声自带明细（服务端响应 details.cleanup）时用它补上，WS 断线场景同样据实
        const already = s.progress?.stage === 'cancelled' ? s.progress : null
        const cleanupDetail = already?.error ?? result.error
        return {
          deploying: false,
          deployInFlight: false,
          cancelling: false,
          lastResult: { ok: false, cancelled: true },
          progress: {
            stage: 'cancelled',
            percent: 0,
            transferred: 0,
            total: 0,
            ...(cleanupDetail ? { error: cleanupDetail } : {}),
          },
        }
      }
      return {
        deploying: false,
        deployInFlight: false,
        cancelling: false,
        lastResult: result,
        progress: result.ok
          ? { stage: 'complete', percent: 1, transferred: 0, total: 0 }
          : { stage: 'error', percent: 0, transferred: 0, total: 0, error: result.error },
      }
    }),
  setCancelling: (value) => set({ cancelling: value }),
  resetDeploy: () =>
    set({
      progress: null,
      deploying: false,
      lastResult: null,
      deployInFlight: false,
      cancelling: false,
    }),
}))
