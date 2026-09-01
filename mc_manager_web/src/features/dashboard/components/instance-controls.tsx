import { useState } from 'react'
import { Loader2, Play, RefreshCw, Save, Square } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiGet, apiPost } from '@/api/client'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'
import type { InstanceStatus } from '@/api/types'

/**
 * 启停管理
 * - 启动/重启/停止：ConfirmDialog 强制显式确认（barrierDismissible:false）
 * - 启动等待：每 2s 轮询至 isRunning，60s 超时；崩溃/宽限期判定
 * - 停止：等待 2s 后刷新；重启：等待 3s 后刷新
 * - 保存（save-all）：无确认直接发送
 * - EULA 特例：启动失败含 EULA_NOT_ACCEPTED → 引导同意对话框
 */

type BusyAction = '启动' | '停止' | '重启' | '保存' | null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function InstanceControls({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient()
  const config = useConnectionStore()
  const status = useServerStore((s) => s.status)
  const instanceId = useServerStore((s) => s.instanceId)
  const resetTerminal = useTerminalStore((s) => s.resetForRestart)
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [confirmAction, setConfirmAction] = useState<'启动' | '停止' | '重启' | null>(null)
  const [eulaOpen, setEulaOpen] = useState(false)

  const isRunning = status?.isRunning ?? false

  const mutation = useMutation({
    mutationFn: async (action: 'start' | 'stop' | 'restart' | 'save') => {
      if (!instanceId) throw new ApiError(40401, 404, 'Instance not found', null)
      if (action === 'save') {
        await apiPost(`/api/v1/instances/${instanceId}/command`, config, { command: 'save-all' })
        return
      }
      await apiPost(`/api/v1/instances/${instanceId}/${action}`, config)
    },
    onSuccess: async (_data, action) => {
      if (action === 'stop') {
        await sleep(2000)
        await queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId ?? '') })
        toast.success('服务器已停止')
      } else if (action === 'restart') {
        // 终端联动：手动重启清空终端+重拉新进程历史
        resetTerminal()
        await sleep(3000)
        await queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId ?? '') })
        toast.success('服务器已重启')
      } else if (action === 'save') {
        toast.success('已发送保存指令')
      } else {
        // start：终端联动 + 轮询至运行
        resetTerminal()
        const result = await waitForStart(instanceId ?? '')
        if (result.ok) {
          toast.success('服务器已启动')
        } else {
          toast.error(result.message)
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId ?? '') })
      }
    },
    onError: (err, action) => {
      const friendly = err instanceof ApiError
        ? getFriendlyErrorMessage(err.code, err.message)
        : `${action}失败，请检查服务器连接`
      // EULA 特例
      if (err instanceof ApiError && err.message.includes('EULA_NOT_ACCEPTED')) {
        setEulaOpen(true)
        return
      }
      toast.error(`${action === 'save' ? '保存失败' : `${action}失败`}: ${friendly}`)
    },
  })

  /** 启动轮询：每 2s 查 isRunning，60s 超时 */
  async function waitForStart(id: string): Promise<{ ok: boolean; message: string }> {
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
    if (wasRunning) return { ok: false, message: '服务器启动后立即崩溃，请检查日志' }
    return { ok: false, message: '服务器启动失败，请检查配置和日志' }
  }

  const doConfirm = () => {
    const action = confirmAction
    setConfirmAction(null)
    if (!action) return
    setBusyAction(action)
    mutation.mutate(action === '启动' ? 'start' : action === '停止' ? 'stop' : 'restart', {
      onSettled: () => setBusyAction(null),
    })
  }

  const handleEulaAgree = async (agreed: boolean) => {
    setEulaOpen(false)
    if (!instanceId) return
    try {
      await apiPost(`/api/v1/instances/${instanceId}/eula`, config, { agreed })
      if (agreed) {
        toast.success('EULA 已同意，正在启动服务器...')
        setBusyAction('启动')
        mutation.mutate('start', { onSettled: () => setBusyAction(null) })
      } else {
        toast.warning('已拒绝 EULA，无法启动服务器')
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError ? getFriendlyErrorMessage(err.code, err.message) : 'EULA 操作失败',
      )
    }
  }

  // 在线玩家名（停止确认时动态展示）
  const playerNames = (status?.players as Array<{ name?: string }> | undefined)
    ?.map((p) => p.name)
    .filter(Boolean) ?? []

  const buttons = [
    {
      action: '启动' as const,
      icon: Play,
      disabled: isRunning || busyAction !== null,
      color: 'text-mcs-success-fg',
      confirm: { title: '启动服务器', description: '确定要启动服务器吗？' },
    },
    {
      action: '停止' as const,
      icon: Square,
      disabled: !isRunning || (busyAction !== null && busyAction !== '停止'),
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
      disabled: !isRunning || (busyAction !== null && busyAction !== '重启'),
      color: 'text-mcs-info-fg',
      confirm: { title: '重启服务器', description: '确定要重启服务器吗？重启期间玩家将断开连接。' },
    },
    {
      action: '保存' as const,
      icon: Save,
      disabled: !isRunning || busyAction !== null,
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
                size="icon-sm"
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
                {busyAction === b.action ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <b.icon className={`size-4 ${b.color}`} aria-hidden />
                )}
                {!compact && <span className="ml-1.5 text-mcs-xs">{b.action}</span>}
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

      {/* EULA 特例对话框 */}
      <ConfirmDialog
        open={eulaOpen}
        onOpenChange={setEulaOpen}
        title="Minecraft EULA 协议"
        description="启动失败：Mojang 要求必须同意 EULA 协议才能运行服务器。同意后将在 eula.txt 中写入 agreed=true 并启动服务器。"
        confirmText="同意并启动"
        cancelText="不同意"
        onConfirm={() => void handleEulaAgree(true)}
        onCancel={() => void handleEulaAgree(false)}
      />
    </>
  )
}
