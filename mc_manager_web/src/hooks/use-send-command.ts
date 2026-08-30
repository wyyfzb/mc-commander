import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiSendCommand } from '@/api/players'
import { ApiError } from '@/api/client'
import { getFriendlyErrorMessage } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 通用命令发送 hook（POST /command + 终端/Toast 反馈；仪表盘驾驶舱多卡共用）
 * - 发送前乐观回显命令到终端（command 级绿字），RCON 成功文本追加 stdout
 * - 未运行 / RCON 缺失时静默忽略（控件已禁用，此为防御兜底）
 */
export function useSendCommand() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const isRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const pushEntry = useTerminalStore((s) => s.pushEntry)

  const mutation = useMutation({
    mutationFn: async (command: string) => {
      if (!instanceId) throw new ApiError(40401, 404, 'Instance not found', null)
      return apiSendCommand(config, instanceId, command)
    },
    onMutate: (command) => {
      if (instanceId) pushEntry(instanceId, command.trim().replace(/^\//, ''), 'command')
    },
    onSuccess: (resp) => {
      const text =
        typeof resp === 'string'
          ? resp.trim()
          : (resp as { response?: string } | null)?.response?.trim()
      if (text && instanceId) pushEntry(instanceId, text, 'stdout')
      // 成功不弹 toast：终端已有 command + stdout 回显，双重反馈是噪音（连续运维时刷屏）
    },
    onError: (err) => {
      const friendly = err instanceof ApiError ? getFriendlyErrorMessage(err.code, err.message) : '网络错误'
      toast.error(`命令发送失败: ${friendly}`)
    },
  })

  const send = (command: string) => {
    const trimmed = command.trim()
    if (!trimmed || !isRunning || !instanceId || mutation.isPending) return false
    mutation.mutate(trimmed)
    return true
  }

  return { send, isRunning, sending: mutation.isPending }
}
