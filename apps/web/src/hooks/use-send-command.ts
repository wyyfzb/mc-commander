import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiSendCommand, commandResponseText } from '@/api/players'
import { getFriendlyErrorText } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useTerminalStore } from '@/stores/terminal'

/** 驾驶舱共用命令入口；终端区分游戏回执与 stdin 投递。 */
export function useSendCommand() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const isRunning = useServerStore(
    (s) =>
      s.status?.id === s.instanceId &&
      s.status?.isRunning === true &&
      s.status.startupState !== 'starting',
  )
  const pushEntry = useTerminalStore((s) => s.pushEntry)

  const mutation = useMutation({
    mutationFn: ({
      id,
      command,
      onResponse,
    }: {
      id: string
      command: string
      onResponse?: () => void
    }) =>
      onResponse
        ? apiSendCommand(config, id, command, undefined, { requireResponse: true })
        : apiSendCommand(config, id, command),
    onMutate: ({ id, command }) => {
      pushEntry(id, command.replace(/^\//, ''), 'command')
    },
    onSuccess: (response, { id, onResponse }) => {
      const text = commandResponseText(response)
      pushEntry(id, text, 'stdout')
      if (response !== null && useServerStore.getState().instanceId === id) onResponse?.()
    },
    onError: (err) => {
      toast.error(`命令发送失败：${getFriendlyErrorText(err)}`)
    },
  })

  const send = (command: string, onResponse?: () => void) => {
    const trimmed = command.trim()
    if (!trimmed || !isRunning || !instanceId) return false
    mutation.mutate({ id: instanceId, command: trimmed, onResponse })
    return true
  }

  return { send, isRunning, sending: mutation.isPending }
}
