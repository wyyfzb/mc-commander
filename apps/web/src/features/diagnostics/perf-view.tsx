/**
 * 性能诊断的呈现件（Sheet 的内容由 perf-sheet.tsx 组装，这里只管「怎么显示」）。
 *
 * 两条与「诚实呈现」直接相关的取舍：
 * - **这是取样，不是监控**：结果区固定写明取样窗口，不出现曲线、不自动刷新、不写「实时」。
 *   关掉再打开不会自动重取，看到的仍是同一份结果——这比留一个看着像实时、其实是十分钟前
 *   的数更可信。
 * - **旧版本不支持时说清是版本问题**：服务端把「命令不被识别」译成专用错误码 + 中文说明，
 *   这里原样带出并撤掉重试按钮（重试同一个不存在的命令不会成功）。
 *
 * 主口径是 `/perf`（耗时 + 堆 + 热点，直接对应「卡」），备口径是 `/jfr`（GC 与分配）。
 */
import { Download, Info, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText, ErrorCode } from '@/api/errors'
import { ApiError } from '@/api/client'
import { apiDownloadFile } from '@/api/files'
import { useConnectionStore } from '@/stores/connection'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import type { PerfSnapshotResponse } from '@mc-commander/schemas'
import { PerfVerdictCard } from './components/verdict-card'
import { JfrDetailSection, PerfDetailSection, formatWindow } from './components/detail-sections'

/**
 * 「该服务端版本不支持」判定——决定要不要给重试入口。
 *
 * 判据只能锚**错误码**：展示层会按码覆盖 message（40000 被映射成「请求参数校验失败」），
 * 任何基于文案的判断都会在下游被吞掉、永久失效。独立码让「能力缺失」与「入参写错」分开：
 * 前者重试无意义（要升级服务端），后者该重试。
 */
export function isPerfUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.code === ErrorCode.PERF_UNSUPPORTED
}

/**
 * 采集失败的横幅，含「要不要给重试入口」这条判断的**接线**。
 *
 * 单独成组件是为了让「码 → 是否显示重试」整条链可测：只测 `isPerfUnsupported` 这个纯函数
 * 不够——页面把它接成 `false`（或忘了用）时纯函数照样是对的，而症状（重试按钮该消失时不消失）
 * 恰好在接线上。
 */
export function SnapshotErrorBanner({
  error,
  onRetry,
  retrying,
}: {
  error: unknown
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <NoticeBanner variant="error" icon={Info} role="alert">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <b>没取到快照</b> · {getFriendlyErrorText(error)}
        </span>
        {!isPerfUnsupported(error) && (
          <Button size="xs" variant="outline" onClick={onRetry} disabled={retrying}>
            <RefreshCw className="size-3" aria-hidden />
            重试
          </Button>
        )}
      </span>
    </NoticeBanner>
  )
}

/**
 * 一次快照的完整呈现。
 * 单独拆出来是为了让组件测试能直接喂一份快照数据，不必走 msw 与 mutation。
 */
export function SnapshotView({
  snapshot,
  instanceId,
}: {
  snapshot: PerfSnapshotResponse
  /** 发起采集的那台实例：入口可能来自别的实例的告警条/卡片，读当前选中实例会下错文件 */
  instanceId: string | null
}) {
  const archivePath = snapshot.archivePath

  const download = async () => {
    if (!instanceId || !archivePath) return
    const name = archivePath.split('/').pop() ?? archivePath
    const toastId = `perf-download-${name}`
    try {
      toast.loading(`正在下载 ${name}…`, { id: toastId })
      const { fileName } = await apiDownloadFile(useConnectionStore.getState(), instanceId, {
        path: archivePath,
        name,
      })
      toast.success(`已下载 ${fileName}`, { id: toastId, duration: 1500 })
    } catch (err) {
      toast.error(`下载失败：${getFriendlyErrorText(err)}`, { id: toastId })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 取样口径声明：这一行是「诚实呈现」的落点，不能省 */}
      <p className="text-mcs-xs text-mcs-text-muted" data-testid="perf-window">
        {snapshot.kind === 'perf' ? '性能快照' : 'JFR 录制'} · 取样窗口{' '}
        {formatWindow(snapshot.windowMs)} · 取于{' '}
        {new Date(snapshot.collectedAt).toLocaleTimeString('zh-CN')}（这是一次取样，不会自动更新）
      </p>

      <PerfVerdictCard verdict={snapshot.verdict} />

      {snapshot.parseWarnings.length > 0 && (
        <NoticeBanner variant="warning" icon={Info} form="card">
          <p className="text-mcs-xs font-medium text-mcs-text-default">产物里有读不出来的部分</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
            {snapshot.parseWarnings.map((warning) => (
              <li key={warning} className="text-mcs-xs text-mcs-text-muted">
                {warning}
              </li>
            ))}
          </ul>
        </NoticeBanner>
      )}

      {snapshot.kind === 'perf' && snapshot.perf && (
        <PerfDetailSection
          detail={snapshot.perf}
          windowMs={snapshot.windowMs}
          hotspots={snapshot.perf.hotspots}
        />
      )}

      {snapshot.kind === 'jfr' && snapshot.jfr && <JfrDetailSection detail={snapshot.jfr} />}

      <Card className="flex flex-col gap-2">
        <CardHeader className="justify-between gap-2">
          <CardTitle as="h3">原始产物</CardTitle>
          <span className="text-mcs-2xs text-mcs-text-muted">下载后可发给别人看</span>
        </CardHeader>
        <CardBody className="flex flex-wrap items-center gap-2">
          {archivePath ? (
            <Button size="sm" variant="outline" onClick={() => void download()}>
              <Download aria-hidden />
              下载产物
            </Button>
          ) : (
            <span className="text-mcs-xs text-mcs-text-muted">这次没有取到可下载的产物。</span>
          )}
          {archivePath && (
            <code className="min-w-0 truncate text-mcs-2xs text-mcs-text-muted">{archivePath}</code>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
