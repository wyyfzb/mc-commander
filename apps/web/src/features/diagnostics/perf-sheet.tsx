/**
 * PerfSheet —— 性能诊断的全站唯一实例（store 驱动，挂 AppShell 末尾）。
 *
 * 为什么是 Sheet 而不是独立页：诊断只有一个动作（取一次快照）和一段结果，用户在
 * 告警条上看到「TPS 低」时想就地知道「为什么低」，把他导航到另一个页面等于让他丢掉
 * 当前正在看的上下文。Sheet 保住了下面那屏。
 *
 * 为什么是**唯一实例 + 存实例 id**：三个入口（告警条 / 崩溃卡 / 实例卡）可能从**别的实例**
 * 的上下文点进来。存 id 而不是读 `useServerStore().instanceId`，才能保证「从 A 的告警条
 * 点开、查的是 A」——否则在多实例下会静默查错服务器。
 *
 * 为什么采集 mutation 挂在这一层而**不在 SheetContent 里**：Sheet 关闭时内容会被卸载，
 * 挂在里面会让进行中的采集随关闭一起消失，重开只能从头再来（用户白等一轮 10 秒）。
 * 挂在常驻外壳上，关闭只是不可见，请求照常跑完、重开即见结果。
 */
import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import {
  PERF_SNAPSHOT_WINDOW_MS,
  type PerfSnapshotKind,
  type PerfSnapshotResponse,
} from '@mc-commander/schemas'
import { getFriendlyErrorText } from '@/api/errors'
import { apiTakePerfSnapshot } from './api'
import { useConnectionStore } from '@/stores/connection'
import { queryKeys, useInstanceStatus } from '@/api/queries'
import { useUiStore } from '@/stores/ui'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { NoticeBanner, NoticeBannerAction } from '@/components/mcs/notice-banner'
import { ListSkeleton } from '@/components/mcs/data-states'
import { SnapshotErrorBanner, SnapshotView, isPerfUnsupported } from './perf-view'
import { PerfIdleHint } from './components/verdict-card'

/** 采集在途时的提示：窗口固定，告诉用户要等多久比只转圈更有用（秒数由契约包的窗口派生） */
const KIND_WAIT_HINT: Record<PerfSnapshotKind, string> = {
  perf: `正在取样 ${PERF_SNAPSHOT_WINDOW_MS.perf / 1000} 秒，请稍候…`,
  jfr: `正在录制 ${PERF_SNAPSHOT_WINDOW_MS.jfr / 1000} 秒，请稍候…`,
}

export function PerfSheet() {
  const instanceId = useUiStore((s) => s.perfSheetInstanceId)
  const setInstanceId = useUiStore((s) => s.setPerfSheetInstanceId)
  const config = useConnectionStore()
  const statusQuery = useInstanceStatus(instanceId)
  /* 运行态三档：true 在跑 / false 已停止 / null 还不知道（首帧或详情读失败）。
     只在**已知已停止**时禁用——采集要发 RCON 命令，那时点了必然失败；状态未知时放行，
     由服务端判定并回一条人话。未知即禁用会让「服务器卡了」这个最需要诊断的时刻点不动 */
  const running = statusQuery.data?.isRunning ?? null
  /** 读失败（而非首帧未回）才算「状态未知」：此时用户需要知道为什么按钮没被拦住 */
  const runningUnknown = running === null && statusQuery.isError

  const mutation = useMutation({
    mutationFn: async (kind: PerfSnapshotKind) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiTakePerfSnapshot(config, instanceId, kind)
    },
  })

  const error = mutation.error
  const unsupported = isPerfUnsupported(error)
  const snapshot: PerfSnapshotResponse | undefined = mutation.data

  /**
   * 关掉再重开**同一台**实例时保留上一轮结果：Sheet 的语义是「看一眼、关掉、回来还在」，
   * 关一次就清空会让用户误以为快照没取成功。
   *
   * 换实例必须重置：这个组件在 AppShell 里只挂一次，mutation 的 data 不会随 instanceId
   * 变化而清空 ⇒ 不清就会把 A 的结论显示在 B 的标题下，而「下载产物」用的是**当前**
   * instanceId 拼路径，会把 B 的请求发到 A 的路径上。
   */
  const resultFor = useRef<string | null>(null)
  useEffect(() => {
    if (instanceId === null) return
    if (resultFor.current !== null && resultFor.current !== instanceId) mutation.reset()
    resultFor.current = instanceId
  }, [instanceId, mutation])

  const close = () => setInstanceId(null)

  /* 采集会往 debug/ 写文件：文件页与实例详情的磁盘占用读的是同一份数据，
     不失效就会显示采集前的旧值。目标取发起采集的那台实例（不是当前选中实例） */
  const queryClient = useQueryClient()
  const take = (kind: PerfSnapshotKind) => {
    const target = instanceId
    mutation.mutate(kind, {
      onSuccess: () => {
        toast.success('快照已取到', { duration: 1500 })
        if (target) void queryClient.invalidateQueries({ queryKey: queryKeys.instance(target) })
      },
      onError: (err) => toast.error(`取快照失败：${getFriendlyErrorText(err)}`),
    })
  }

  return (
    <Sheet
      open={instanceId !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      {/* w-full 覆盖基座 3/4，sm:max-w-3xl 覆盖基座 384px：诊断结果是多栏表格与长文本，
          384px 下「维度/区块/实体」三列会被挤成每列几个字符 */}
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl data-[side=right]:w-full"
      >
        <SheetHeader className="shrink-0 border-b border-mcs-border-muted px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-mcs-lg">
            <Activity className="size-4 text-mcs-accent-fg" aria-hidden />
            性能诊断
          </SheetTitle>
          <SheetDescription className="text-mcs-xs">
            卡了但不知道卡在哪？取一次快照，面板读完给你结论
          </SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-mcs-border-muted px-4 py-2.5">
          <Button
            size="sm"
            onClick={() => take('perf')}
            disabled={mutation.isPending || running === false}
          >
            <Activity aria-hidden />
            {mutation.isPending && mutation.variables === 'perf' ? '取样中…' : '取一次快照'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => take('jfr')}
            disabled={mutation.isPending || running === false}
          >
            <Terminal aria-hidden />
            {mutation.isPending && mutation.variables === 'jfr' ? '录制中…' : '看垃圾回收'}
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {/* 未在运行：采集要发 RCON 命令，按钮点了也不会有结果，先说清原因 */}
          {running === false && (
            <NoticeBanner variant="neutral" icon={Activity}>
              服务器未在运行，快照需要向服务端发送命令。启动实例后即可取快照。
            </NoticeBanner>
          )}

          {/* 读数失败与「已停止」是两回事：后者是事实，前者说明我们不知道它到底在不在跑。
              按钮此时仍可点（点击后服务端会给出确切答复），故这里只交代读数是旧的 */}
          {runningUnknown && (
            <NoticeBanner variant="warning" icon={Activity}>
              <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0">
                  读不到实例运行状态（服务端暂时不可用），按钮不会被拦——若确实没在运行，取快照会直接报错。
                </span>
                <NoticeBannerAction onClick={() => void statusQuery.refetch()}>
                  重试
                </NoticeBannerAction>
              </span>
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
              onRetry={() => take(mutation.variables ?? 'perf')}
              retrying={mutation.isPending}
            />
          )}

          {mutation.isPending && !snapshot ? (
            <ListSkeleton rows={4} />
          ) : snapshot ? (
            <SnapshotView snapshot={snapshot} instanceId={instanceId} />
          ) : unsupported ? null : (
            <PerfIdleHint />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
