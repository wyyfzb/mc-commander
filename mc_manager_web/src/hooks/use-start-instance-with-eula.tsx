/**
 * useStartInstanceWithEula —— 启动指令共享 mutation + EULA 首启特例（issue 312，清单 A4-1）
 * - 两入口复用：实例页卡片「启动」/ 仪表盘 InstanceControls「启动」
 * - EULA 特例：start 失败含 EULA_NOT_ACCEPTED → 弹同意对话框（中文说明）→
 *   同意后写入 eula.txt（POST /eula {agreed:true}）并自动续启
 * - 回调经 callbacksRef 保留：EULA 续启路径复用入口注册的 onStarted/onSettled
 * - 调用方在返回树中渲染 eulaDialog；未提供 onStartError 时 hook 内 toast 兜底
 */
import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { apiPost, ApiError } from '@/api/client'
import { getFriendlyErrorText, getFriendlyErrorMessage } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

/** 启动回调（入口差异化行为：仪表盘轮询等待/实例页即时反馈） */
export interface StartInstanceCallbacks {
  /** start 指令成功（启动过程异步继续：轮询/终端联动由调用方负责） */
  onStarted?: () => void | Promise<void>
  /** 非 EULA 启动错误；未提供时 hook 内 toast 兜底 */
  onStartError?: (err: unknown) => void
  /** start 结束（成功/失败/EULA 拦截均触发；调用方按钮 busy 复位） */
  onSettled?: () => void
}

/** EULA 需求错误判定（服务端 start 前置检查：eula.txt 缺失或 eula=false） */
export function isEulaError(err: unknown): boolean {
  return err instanceof ApiError && err.message.includes('EULA_NOT_ACCEPTED')
}

export function useStartInstanceWithEula() {
  const config = useConnectionStore()
  const setPhase = useServerStore((s) => s.setPhase)
  /** 待同意 EULA 的实例（非空即弹窗） */
  const [eulaTargetId, setEulaTargetId] = useState<string | null>(null)
  const [eulaBusy, setEulaBusy] = useState(false)
  /** 入口注册的回调（EULA 续启时复用同一组 onStarted/onSettled） */
  const callbacksRef = useRef<StartInstanceCallbacks | null>(null)

  const startMutation = useMutation({
    mutationFn: async (id: string) => {
      // phase 中间态（issue 334）：发令即置 starting（按钮禁用防连点）；
      // WS started 确认清除；异常路径（失败/EULA 拦截/onStarted 链终了）兜底清除
      setPhase(id, 'starting')
      await apiPost(`/api/v1/instances/${id}/start`, config)
      return id
    },
  })

  /** 发启动指令（EULA 特例内置：命中即弹同意对话框） */
  const startInstance = (id: string, callbacks?: StartInstanceCallbacks) => {
    callbacksRef.current = callbacks ?? null
    startMutation.mutate(id, {
      onSuccess: () => {
        // onStarted 可能是长链（仪表盘 waitForStart 轮询）：链终了兜底清 phase
        void Promise.resolve(callbacksRef.current?.onStarted?.())
          .catch(() => {})
          .finally(() => setPhase(id, null))
      },
      onError: (err) => {
        setPhase(id, null)
        if (isEulaError(err)) {
          setEulaTargetId(id)
          return
        }
        if (callbacksRef.current?.onStartError) {
          callbacksRef.current.onStartError(err)
          return
        }
        toast.error(`启动失败：${getFriendlyErrorText(err)}`)
      },
      onSettled: () => {
        callbacksRef.current?.onSettled?.()
      },
    })
  }

  /** EULA 处置：同意写入 eula.txt 后自动续启；拒绝仅提示 */
  const resolveEula = async (agreed: boolean) => {
    const id = eulaTargetId
    setEulaTargetId(null)
    if (!id) return
    if (!agreed) {
      toast.warning('已拒绝 EULA，无法启动服务器')
      return
    }
    const callbacks = callbacksRef.current
    setEulaBusy(true)
    try {
      await apiPost(`/api/v1/instances/${id}/eula`, config, { agreed: true })
      toast.success('EULA 已同意，正在启动服务器...')
      await startMutation.mutateAsync(id, {
        onSuccess: () => {
          void Promise.resolve(callbacks?.onStarted?.())
            .catch(() => {})
            .finally(() => setPhase(id, null))
        },
        onSettled: () => {
          callbacks?.onSettled?.()
        },
      })
    } catch (err) {
      setPhase(id, null)
      if (isEulaError(err)) {
        // 同意写入后仍报 EULA（极端竞态）：重新弹窗引导
        setEulaTargetId(id)
        return
      }
      if (callbacks?.onStartError) {
        callbacks.onStartError(err)
        return
      }
      toast.error(
        err instanceof ApiError
          ? getFriendlyErrorMessage(err.code, err.message)
          : `启动失败：${getFriendlyErrorText(err)}`,
      )
    } finally {
      setEulaBusy(false)
    }
  }

  const eulaDialog = (
    <ConfirmDialog
      open={eulaTargetId !== null}
      onOpenChange={(open) => {
        if (!open) setEulaTargetId(null)
      }}
      title="Minecraft EULA 协议"
      description="启动失败：Mojang 要求必须同意 EULA 协议才能运行服务器。同意后将在 eula.txt 中写入 agreed=true 并自动启动服务器。"
      confirmText="同意并启动"
      cancelText="不同意"
      loading={eulaBusy}
      onConfirm={() => void resolveEula(true)}
      onCancel={() => void resolveEula(false)}
    />
  )

  return {
    startInstance,
    startPending: startMutation.isPending,
    /** 进行中启动的实例 id（配合 startPending 判断按钮 busy） */
    pendingStartId: startMutation.variables ?? null,
    eulaBusy,
    eulaDialog,
  }
}
