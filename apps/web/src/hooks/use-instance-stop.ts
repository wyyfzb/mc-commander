/**
 * useStopInstance —— 停止指令共享 mutation（issue 334）
 * - 两入口收敛：实例页卡片「停止」/ 仪表盘 InstanceControls「停止」（原先各自实现）
 * - phase 中间态：发令前置 'stopping'（按钮禁用防连点）；WS stopped 确认清除（hook 层），
 *   mutation settled 兜底清除（WS 断线时防按钮永久禁用）
 * - 成功反馈与列表刷新保持原两处语义：toast + 失效实例详情/列表缓存
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiPost } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

export function useStopInstance() {
  const config = useConnectionStore()
  const queryClient = useQueryClient()
  const setPhase = useServerStore((s) => s.setPhase)

  return useMutation({
    mutationFn: async (id: string) => {
      setPhase(id, 'stopping')
      await apiPost(`/api/v1/instances/${id}/stop`, config)
      return id
    },
    onSuccess: (_data, id) => {
      toast.success('停止指令已发送')
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
    },
    onError: (e) => {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    },
    onSettled: (_data, _error, id) => {
      // 兜底清除：正常路径由 WS stopped 事件确认清除（幂等无害）
      setPhase(id, null)
    },
  })
}
