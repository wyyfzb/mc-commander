/**
 * 设置页「数据与卸载」子页：面板自身去留。
 *
 * 三种意图分开呈现，因为它们对数据的处置相反：停用（全留）、导出（全留且带走）、
 * 彻底删除（默认全删，可勾选保留存档）。
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useConnectionStore } from '@/stores/connection'
import {
  apiExportPanel,
  apiPanelData,
  apiRemovalPreview,
  apiRequestRemoval,
  apiStopPanel,
  type RemovalRequest,
} from '@/api/panel'
import { DangerZonePanel, RemovalProgress } from './danger-zone-panel'
import { MigrateDataSection } from './migrate-data-section'

export function DataPanel() {
  const config = useConnectionStore()
  const [stopping, setStopping] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const [removalStarted, setRemovalStarted] = useState(false)
  // 重新发起时要沿用上一次勾选的「保留存档」：重置成默认值会让用户以为存档没了
  const [startedKeepData, setStartedKeepData] = useState(false)

  const dataQuery = useQuery({
    queryKey: ['panel-data'],
    queryFn: () => apiPanelData(config),
    staleTime: 30_000,
  })

  const previewQuery = useQuery({
    queryKey: ['panel-removal-preview'],
    queryFn: () => apiRemovalPreview(config),
    staleTime: 30_000,
  })

  const stopMutation = useMutation({
    mutationFn: () => apiStopPanel(config),
    onMutate: () => setStopping(true),
    onSuccess: () => toast.success('面板正在停止，数据全部保留', { duration: 4000 }),
    onError: (e: Error) => {
      setStopping(false)
      toast.error(e.message || '停用失败')
    },
  })

  const removeMutation = useMutation({
    mutationFn: (payload: RemovalRequest) => apiRequestRemoval(config, payload),
    onMutate: (payload) => {
      setRemoveError('')
      setStartedKeepData(payload.keepData === true)
    },
    onSuccess: () => {
      setRemovalStarted(true)
      toast.success('已开始清理，本页面稍后会断开', { duration: 8000 })
    },
    onError: (e: Error) => setRemoveError(e.message || '删除失败'),
  })

  // 认证走 Authorization 头，<a download> 带不上它（必然 401），故取回 blob 再存盘
  const handleExport = async () => {
    setExporting(true)
    try {
      const { blob, fileName } = await apiExportPanel(config)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName ?? 'mc-commander-backup.tar.gz'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 立即 revoke 会在浏览器真正读取该 URL 之前把它吊销，下载静默失败
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast.success('备份已下载')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  if (removalStarted) {
    return (
      <RemovalProgress
        baseUrl={config.baseUrl}
        keepData={startedKeepData}
        onRetry={() => {
          // 回到确认表单：密码与「彻底删除」要重填一次，删除是不可逆动作，不给一键重试
          setRemovalStarted(false)
          setRemoveError('')
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <MigrateDataSection items={dataQuery.data?.items ?? []} loading={dataQuery.isLoading} />
      <DangerZonePanel
        items={dataQuery.data?.items ?? []}
        loading={dataQuery.isLoading}
        exporting={exporting}
        stopping={stopping || stopMutation.isPending}
        onExport={handleExport}
        onStop={() => stopMutation.mutate()}
        totpEnabled={previewQuery.data?.totpEnabled ?? false}
        initialKeepData={startedKeepData}
        removing={removeMutation.isPending}
        removeError={removeError}
        onRemove={(payload) => removeMutation.mutate(payload)}
      />
    </div>
  )
}
