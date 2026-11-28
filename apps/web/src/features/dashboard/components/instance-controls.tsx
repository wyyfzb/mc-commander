import { useState } from 'react'
import { Loader2, Play, RefreshCw, Save, Square } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { SEMANTIC_TONE_CLASSES } from '@/components/mcs/tone'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ApiError } from '@/api/client'
import { apiRestartInstance, apiSaveInstance, INSTANCE_RESTART_SPAWNED } from '@/api/instances'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'
import { useStartInstanceWithEula } from '@/hooks/use-start-instance-with-eula'
import { useStopInstance } from '@/hooks/use-instance-stop'

export function InstanceControls() {
  const queryClient = useQueryClient()
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const status = useServerStore((s) => (s.status?.id === instanceId ? s.status : null))
  const currentPhase = useServerStore((s) => (instanceId ? s.phase[instanceId] : undefined))
  const resetTerminal = useTerminalStore((s) => s.resetForRestart)
  const [confirmation, setConfirmation] = useState<{
    instanceId: string
    action: '停止' | '重启'
  } | null>(null)

  const { startInstance, startPending, pendingStartId, eulaDialog } = useStartInstanceWithEula()
  const stopMutation = useStopInstance()

  const refreshLifecycle = (id: string) => {
    if (useServerStore.getState().instanceId === id) resetTerminal()
    void queryClient.invalidateQueries({ queryKey: queryKeys.instance(id), exact: true })
    void queryClient.invalidateQueries({ queryKey: queryKeys.instances(), exact: true })
  }

  const mutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'restart' | 'save' }) => {
      if (action === 'save') {
        await apiSaveInstance(config, id)
      } else {
        await apiRestartInstance(config, id)
      }
    },
    onSuccess: (_data, { id, action }) => {
      if (action === 'restart') {
        toast.success(INSTANCE_RESTART_SPAWNED)
        refreshLifecycle(id)
      } else {
        toast.success('存档已写入磁盘')
      }
    },
    onError: (err, { action }) => {
      if (
        action === 'save' &&
        err instanceof ApiError &&
        err.code === ErrorCode.BACKUP_IN_PROGRESS
      ) {
        toast.error('备份期间无法手动存档，请等备份结束后重试')
        return
      }
      toast.error(
        `${action === 'save' ? '未确认存档完成' : '重启失败'}：${getFriendlyErrorText(err)}`,
      )
    },
  })

  const isRunning = status?.isRunning === true
  const isStarting = status?.startupState === 'starting'
  const startBusy = (startPending && pendingStartId === instanceId) || currentPhase === 'starting'
  const stopBusy =
    (stopMutation.isPending && stopMutation.variables === instanceId) || currentPhase === 'stopping'
  const pendingAction =
    mutation.isPending && mutation.variables.id === instanceId ? mutation.variables.action : null
  const lifecycleBusy = stopBusy || pendingAction === 'restart'
  const canRestart = isRunning && !lifecycleBusy && !pendingAction
  const canSave = canRestart && !isStarting && !startBusy
  const confirmAction = confirmation?.instanceId === instanceId ? confirmation?.action : undefined

  const playerNames =
    (status?.players as Array<{ name?: string }> | undefined)?.map((p) => p.name).filter(Boolean) ??
    []

  const buttons = [
    {
      action: '启动' as const,
      icon: Play,
      disabled: !status || isRunning || isStarting || startBusy || lifecycleBusy,
      color: SEMANTIC_TONE_CLASSES.success.text,
      confirm: null,
    },
    {
      action: '停止' as const,
      icon: Square,
      disabled: (!isRunning && !isStarting) || lifecycleBusy,
      color: SEMANTIC_TONE_CLASSES.error.text,
      confirm: {
        title: '关闭服务器',
        description:
          playerNames.length > 0
            ? `${playerNames.length} 名玩家当前在线（${playerNames.slice(0, 3).join('、')}${playerNames.length > 3 ? '…' : ''}），停止后他们将断开连接。`
            : isStarting
              ? '如果服务器没有响应，面板将强制结束进程。'
              : '确定要关闭服务器吗？',
      },
    },
    {
      action: '重启' as const,
      icon: RefreshCw,
      disabled: !canRestart,
      color: SEMANTIC_TONE_CLASSES.info.text,
      confirm: { title: '重启服务器', description: '确定要重启服务器吗？重启期间玩家将断开连接。' },
    },
    {
      action: '保存' as const,
      icon: Save,
      disabled: !canSave,
      color: SEMANTIC_TONE_CLASSES.accent.text,
      confirm: null,
    },
  ]
  const confirmButton = buttons.find((b) => b.action === confirmAction)

  const doStart = (id: string) => {
    startInstance(id, {
      onStarted: () => {
        toast.success('启动指令已发送')
        refreshLifecycle(id)
      },
    })
  }

  const doConfirm = () => {
    setConfirmation(null)
    if (!instanceId || !confirmButton || confirmButton.disabled) return
    if (confirmAction === '停止') {
      stopMutation.mutate(instanceId)
    } else if (confirmAction === '重启') {
      mutation.mutate({ id: instanceId, action: 'restart' })
    }
  }

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
                  if (!instanceId) return
                  if (b.action === '启动') {
                    doStart(instanceId)
                  } else if (b.action === '保存') {
                    mutation.mutate({ id: instanceId, action: 'save' })
                  } else {
                    setConfirmation({ instanceId, action: b.action })
                  }
                }}
              >
                {(b.action === '启动' && (startBusy || isStarting)) ||
                (b.action === '停止' && stopBusy) ||
                (b.action === '重启' && pendingAction === 'restart') ||
                (b.action === '保存' && pendingAction === 'save') ? (
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
        open={!!confirmButton}
        onOpenChange={(open) => !open && setConfirmation(null)}
        title={confirmButton?.confirm?.title ?? ''}
        description={confirmButton?.confirm?.description ?? ''}
        confirmText={confirmAction ?? '确定'}
        danger={confirmAction === '停止'}
        confirmDisabled={confirmButton?.disabled}
        onConfirm={doConfirm}
      />

      {/* EULA 首启特例（共享 hook：同意写入 eula.txt 后自动续启） */}
      {eulaDialog}
    </>
  )
}
