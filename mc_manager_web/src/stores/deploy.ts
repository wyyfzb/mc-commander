/**
 * 部署进度状态（WS deployProgress 事件落点）
 * - 部署流程：idle → deploying（POST 在途 + WS 进度）→ complete / error
 * - 进度事件由 use-server-socket 分派（deployProgress case）
 * - 卸载（uninstallingId）为实例卡片按钮态，与部署无关
 */
import { create } from 'zustand'
import type { DeployProgress } from '@/api/types'

/** 部署阶段中文标签 */
export const DEPLOY_STAGE_LABELS: Record<string, string> = {
  download: '正在下载服务端核心…',
  download_complete: '下载完成，正在准备…',
  forge_install: '正在安装 Forge…',
  first_launch: '首次启动生成配置…',
  complete: '部署完成',
  error: '部署失败',
}

interface DeployState {
  /** 当前进度（null = 无部署进行中） */
  progress: DeployProgress | null
  /** 部署中标记（POST 请求在途，尚未收到 WS 事件） */
  deploying: boolean
  /** 最近一次部署结果（成功实例 id / 失败错误信息） */
  lastResult: { ok: boolean; instanceId?: string; error?: string } | null
  /** 应用 WS deployProgress 事件（use-server-socket 调用） */
  applyDeployProgress: (p: DeployProgress) => void
  /** 部署开始（POST 发出前调用；进度回 0） */
  startDeploy: () => void
  /** 部署完成/失败落定（POST 响应后调用） */
  finishDeploy: (result: { ok: boolean; instanceId?: string; error?: string }) => void
  /** 重置（关闭部署对话框时清理） */
  resetDeploy: () => void
}

export const useDeployStore = create<DeployState>()((set) => ({
  progress: null,
  deploying: false,
  lastResult: null,
  applyDeployProgress: (p) => set({ progress: p, deploying: true }),
  startDeploy: () => set({ progress: null, deploying: true, lastResult: null }),
  finishDeploy: (result) =>
    set(() => ({
      deploying: false,
      lastResult: result,
      progress:
        result.ok
          ? { stage: 'complete', percent: 1, transferred: 0, total: 0 }
          : { stage: 'error', percent: 0, transferred: 0, total: 0, error: result.error },
    })),
  resetDeploy: () => set({ progress: null, deploying: false, lastResult: null }),
}))
