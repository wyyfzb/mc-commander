import { useState } from 'react'
import { Loader2, Play, RefreshCw, Save, Square } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiGet, apiPost, ApiError } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'
import { useUiStore } from '@/stores/ui'
import { useStartInstanceWithEula } from '@/hooks/use-start-instance-with-eula'
import { useStopInstance } from '@/hooks/use-instance-stop'
import type { InstanceStatus } from '@/api/types'

/**
 * 启停管理
 * - 启动/重启/停止：ConfirmDialog 强制显式确认（barrierDismissible:false）
 * - 启动：共享 mutation useStartInstanceWithEula（EULA 首启特例内置，与实例页同源）
 * - 启动等待：每 2s 轮询至 isRunning，60s 超时；崩溃/宽限期判定
 * - 停止：等待 2s 后刷新；重启：等待 3s 后刷新
 * - 保存（save-all）：无确认直接发送
 */

type BusyAction = '启动' | '停止' | '重启' | '保存' | null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function InstanceControls() {
  const queryClient = useQueryClient()
  const config = useConnectionStore()
  const status = useServerStore((s) => s.status)
  const instanceId = useServerStore((s) => s.instanceId)
  const currentPhase = useServerStore((s) => (s.instanceId ? (s.phase[s.instanceId] ?? null) : null))
  const resetTerminal = useTerminalStore((s) => s.resetForRestart)
  const setLastOutputInstanceId = useUiStore((s) => s.setLastOutputInstanceId)
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [confirmAction, setConfirmAction] = useState<'启动' | '停止' | '重启' | null>(null)

  const isRunning = status?.isRunning ?? false

  // 启动：共享 mutation（EULA 首启特例内置：命中 → 弹同意 → 续启；与实例页同源）
  const { startInstance, startPending, pendingStartId, eulaDialog } = useStartInstanceWithEula()

  // 停止：共享 mutation（issue 334 收敛：与实例页同源，phase 中间态防连点）
  const stopMutation = useStopInstance()

  // 重启/保存（启动/停止已拆出共享 hook）
  const mutation = useMutation({
    mutationFn: async (action: 'restart' | 'save') => {
      if (!instanceId) throw new ApiError(40401, 404, 'Instance not found', null)
      if (action === 'save') {
        await apiPost(`/api/v1/instances/${instanceId}/command`, config, { command: 'save-all' })
        return
      }
      await apiPost(`/api/v1/instances/${instanceId}/${action}`, config)
    },
    onSuccess: async (_data, action) => {
      if (action === 'restart') {
        // 终端联动：手动重启清空终端+重拉新进程历史
        resetTerminal()
        await sleep(3000)
        await queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId ?? '') })
        toast.success('服务器已重启')
      } else {
        toast.success('已发送保存指令')
      }
    },
    onError: (err, action) => {
      const friendly = getFriendlyErrorText(err)
      toast.error(`${action === 'save' ? '保存失败' : '重启失败'}：${friendly}`)
    },
  })

  /** 启动轮询：每 2s 查 isRunning，60s 超时 */
  async function waitForStart(id: string): Promise<{ ok: boolean; message: string; instanceId?: string }> {
    let wasRunning = false
    for (let i = 0; i < 30; i++) {
      await sleep(2000)
      try {
        const st = await apiGet<InstanceStatus>(`/api/v1/instances/${id}`, config)
        if (st.isRunning) {
          // 15s 宽限期：曾运行后停止 → 判定立即崩溃
          return { ok: true, message: '' }
        }
        if (st.totalUptime > 0) wasRunning = true
      } catch {
        // 单次探测失败继续
      }
    }
    if (wasRunning) {
      return {
        ok: false,
        message: '服务器启动后立即崩溃，请检查日志',
        // 深入链接：一键查看进程末尾日志（issue 343，消费 lastOutput）
        instanceId: id,
      }
    }
    return { ok: false, message: '服务器启动失败，请检查配置和日志', instanceId: id }
  }

  const doConfirm = () => {
    const action = confirmAction
    setConfirmAction(null)
    if (!action) return
    if (action === '启动') {
      setBusyAction('启动')
      startInstance(instanceId ?? '', {
        onStarted: async () => {
          // start：终端联动 + 轮询至运行
          resetTerminal()
          const result = await waitForStart(instanceId ?? '')
          if (result.ok) {
            toast.success('服务器已启动')
          } else {
            toast.error(result.message, {
              // 深入链接：失败时进程可能已留下末尾输出（issue 343）
              ...(result.instanceId
                ? { action: { label: '查看末尾日志', onClick: () => setLastOutputInstanceId(result.instanceId!) } }
                : {}),
            })
          }
          await queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId ?? '') })
        },
        onStartError: (err) => {
          toast.error(`启动失败：${getFriendlyErrorText(err)}`)
        },
        onSettled: () => setBusyAction(null),
      })
      return
    }
    setBusyAction(action)
    if (action === '停止') {
      stopMutation.mutate(instanceId ?? '', { onSettled: () => setBusyAction(null) })
      return
    }
    mutation.mutate('restart', {
      onSettled: () => setBusyAction(null),
    })
  }

  // 在线玩家名（停止确认时动态展示）
  const playerNames = (status?.players as Array<{ name?: string }> | undefined)
    ?.map((p) => p.name)
    .filter(Boolean) ?? []

  // 启动按钮 busy：共享 hook 的启动中（含 EULA 同意后续启）或本页确认弹窗链路；
  // phase 中间态（issue 334）：starting/stopping 期间全部启停按钮禁用（WS 确认后解锁）
  const startBusy = (startPending && pendingStartId === instanceId) || busyAction === '启动' || currentPhase === 'starting'
  const stopBusy = stopMutation.isPending || currentPhase === 'stopping'

  const buttons = [
    {
      action: '启动' as const,
      icon: Play,
      disabled: isRunning || busyAction !== null || startBusy,
      color: 'text-mcs-success-fg',
      confirm: { title: '启动服务器', description: '确定要启动服务器吗？' },
    },
    {
      action: '停止' as const,
      icon: Square,
      disabled: !isRunning || (busyAction !== null && busyAction !== '停止') || currentPhase !== null,
      color: 'text-mcs-error-fg',
      confirm: {
        title: '关闭服务器',
        description:
          playerNames.length > 0
            ? `${playerNames.length} 名玩家当前在线（${playerNames.slice(0, 3).join('、')}${playerNames.length > 3 ? '…' : ''}），停止后他们将断开连接。`
            : '确定要关闭服务器吗？',
        danger: true,
      },
    },
    {
      action: '重启' as const,
      icon: RefreshCw,
      disabled: !isRunning || (busyAction !== null && busyAction !== '重启') || currentPhase !== null,
      color: 'text-mcs-info-fg',
      confirm: { title: '重启服务器', description: '确定要重启服务器吗？重启期间玩家将断开连接。' },
    },
    {
      action: '保存' as const,
      icon: Save,
      disabled: !isRunning || busyAction !== null || currentPhase !== null,
      color: 'text-mcs-accent-fg',
      confirm: null, // 保存无确认直接发送
    },
  ]

  return (
    <>
      <div className="flex items-center gap-1">
        {buttons.map((b) => (
          <Tooltip key={b.action}>
            <TooltipTrigger asChild>
              <Button
                variant={b.action === '停止' ? 'destructive' : 'ghost'}
                size="sm"
                disabled={b.disabled}
                aria-label={b.action}
                onClick={() => {
                  if (b.confirm) setConfirmAction(b.action)
                  else {
                    setBusyAction('保存')
                    mutation.mutate('save', { onSettled: () => setBusyAction(null) })
                  }
                }}
              >
                {busyAction === b.action || (b.action === '启动' && startBusy) || (b.action === '停止' && stopBusy) ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <b.icon className={`size-4 ${b.color}`} aria-hidden />
                )}
                {/* 文字标签（≥480px 显示）：启停为低频高危操作，文字消除图标歧义；
                    窄视口回退纯图标（tooltip 兜底） */}
                <span className="hidden text-mcs-xs xs:inline">{b.action}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{b.action}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmAction ? (buttons.find((b) => b.action === confirmAction)?.confirm?.title ?? '') : ''}
        description={
          confirmAction ? (buttons.find((b) => b.action === confirmAction)?.confirm?.description ?? '') : ''
        }
        confirmText={confirmAction ?? '确定'}
        danger={confirmAction === '停止'}
        loading={busyAction !== null}
        onConfirm={doConfirm}
      />

      {/* EULA 首启特例（共享 hook：同意写入 eula.txt 后自动续启） */}
      {eulaDialog}
    </>
  )
}
