/**
 * PerfPage —— 性能诊断页。
 *
 * 这一页回答的问题是「我的服务器为什么卡」，不是「给我一堆指标」。所以版式是：
 * 页头（一个主按钮）→ 结论卡（一句话 + 依据）→ 佐证（耗时分布 / 加载量 / 运行时）。
 *
 * 两条与「诚实呈现」直接相关的取舍：
 * - **这是取样，不是监控**：结果区固定写明取样窗口，页面上不出现曲线、不自动刷新、
 *   不写「实时」。刷新页面结论就没了——比留一个看着像实时、其实是十分钟前的数更可信。
 * - **旧版本不支持时说清是版本问题**：服务端把「命令不被识别」翻成 400 + 中文说明，
 *   这里原样带出并撤掉重试按钮（重试同一个不存在的命令不会成功）。
 *
 * 主口径是 `/perf`（耗时 + 堆 + 热点，直接对应「卡」），备口径是 `/jfr`（GC 与分配）。
 * 两者不并排成两个平级按钮：那是把「选口径」这个实现细节丢给用户。默认 perf，
 * JFR 收在次级按钮里，并写明它回答的是另一个问题（内存侧）。
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Activity, Download, Info, RefreshCw, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText, ErrorCode } from '@/api/errors'
import { ApiError } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { apiDownloadFile } from '@/api/files'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { PageHeader } from '@/components/mcs/page-header'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import { ListSkeleton } from '@/components/mcs/data-states'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import type { PerfSnapshotKind, PerfSnapshotResponse } from '@mc-commander/schemas'
import { useTakePerfSnapshot } from './queries'
import { PerfVerdictCard, PerfIdleHint } from './components/verdict-card'
import { JfrDetailSection, PerfDetailSection, formatWindow } from './components/detail-sections'

/** 采集在途时的提示：窗口是固定的，告诉用户要等多久比转圈更有用 */
const KIND_WAIT_HINT: Record<PerfSnapshotKind, string> = {
  perf: '正在取样 10 秒，请稍候…',
  jfr: '正在录制 15 秒，请稍候…',
}

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

export function PerfPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const instanceRunning = useServerStore((s) => s.status?.isRunning ?? false)
  const mutation = useTakePerfSnapshot(instanceId)
  const queryClient = useQueryClient()

  /**
   * 采集成功后把实例状态查询失效一次：`/perf` 与 `/jfr` 会往 debug/ 写文件，
   * 文件页与磁盘占用读的是同一个实例，不失效会显示采集前的旧值。
   * 用 ref 保证只在 mutation 从「无结果」跨到「有结果」时触发一次，
   * 每次渲染都失效会让查询自己把自己打回去重取。
   */
  const invalidatedRef = useRef(false)
  useEffect(() => {
    if (mutation.isSuccess && instanceId && !invalidatedRef.current) {
      invalidatedRef.current = true
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId) })
    }
    if (mutation.isIdle) invalidatedRef.current = false
  }, [mutation.isSuccess, mutation.isIdle, instanceId, queryClient])

  const error = mutation.error

  const takeSnapshot = (kind: PerfSnapshotKind) => {
    invalidatedRef.current = false
    mutation.mutate(kind, {
      onSuccess: () => toast.success('快照已取到', { duration: 1500 }),
      onError: (err) => toast.error(`取快照失败：${getFriendlyErrorText(err)}`),
    })
  }

  if (!instanceId) {
    return <InstanceRequiredState />
  }

  const snapshot = mutation.data

  return (
    /* @container：结论与佐证两张卡按内容宽决定要不要并排——侧栏折叠会改变可用宽度 */
    <div className="@container flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <PageHeader
        title="性能诊断"
        description="卡了但不知道卡在哪？取一次快照，面板读完给你结论"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => takeSnapshot('perf')}
              disabled={mutation.isPending || !instanceRunning}
            >
              <Activity aria-hidden />
              {mutation.isPending && mutation.variables === 'perf' ? '取样中…' : '取一次快照'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => takeSnapshot('jfr')}
              disabled={mutation.isPending || !instanceRunning}
            >
              <Terminal aria-hidden />
              {mutation.isPending && mutation.variables === 'jfr' ? '录制中…' : '看垃圾回收'}
            </Button>
          </div>
        }
      />

      {/* 实例没在跑：采集要发 RCON 命令，未运行时按钮点了也不会有结果，先说清原因 */}
      {!instanceRunning && (
        <NoticeBanner variant="neutral" icon={Info}>
          服务器未在运行，快照需要向服务端发送命令。启动实例后即可取快照。
        </NoticeBanner>
      )}

      {mutation.isPending && (
        <NoticeBanner variant="neutral" icon={Activity} iconClassName="animate-spin">
          {KIND_WAIT_HINT[mutation.variables ?? 'perf']}
        </NoticeBanner>
      )}

      {error != null && (
        <SnapshotErrorBanner
          error={error}
          onRetry={() => takeSnapshot(mutation.variables ?? 'perf')}
          retrying={mutation.isPending}
        />
      )}

      {mutation.isPending && !snapshot ? (
        <ListSkeleton rows={4} />
      ) : snapshot ? (
        <SnapshotView snapshot={snapshot} />
      ) : (
        <PerfIdleHint />
      )}
    </div>
  )
}

/**
 * 一次快照的完整呈现。
 * 单独拆出来是为了让组件测试能直接喂一份快照数据，不必走 msw 与 mutation。
 */
export function SnapshotView({ snapshot }: { snapshot: PerfSnapshotResponse }) {
  const instanceId = useServerStore((s) => s.instanceId)
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
