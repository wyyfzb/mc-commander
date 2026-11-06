/**
 * 快照的佐证区：结论下面那些「为什么」。
 *
 * 三块内容各自回答一个问题，不合并成一张大表：
 * - tick 内耗时分布 → 「时间花在哪」，这是「卡」的直接归因；
 * - 各维度区块与实体数 → 「世界里堆了多少东西」，这是卡顿的来源侧；
 * - JFR 的 GC 与分配 → 「内存侧有没有问题」，主口径看不出来的另一半。
 *
 * 全部按**一次取样**呈现：标题里写明窗口长度，不出现「实时」「当前」这类会让人以为
 * 它在自己更新的措辞。
 */
import type { JfrDetail, PerfDetail } from '@mc-commander/schemas'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'

function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value == null) return '未取到'
  return value.toFixed(digits)
}

/** 窗口长度：服务端给的是毫秒，界面说「秒」更好读；不足 1 秒如实说毫秒 */
export function formatWindow(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '窗口未知'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

/**
 * tick 内耗时分布（横条）。
 * 比例是「占 tick 内部耗时的百分比」，不是占整段时间——后者含等下一刻的空转（实测 99.85%），
 * 画出来会让每一项都贴着 0。
 */
export function HotspotList({ hotspots }: { hotspots: PerfDetail['hotspots'] }) {
  if (hotspots.length === 0) {
    return (
      <p className="text-mcs-xs text-mcs-text-muted">
        这次产物里没有逐段耗时数据（该版本可能不产出 profiling 树）。
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {hotspots.map((spot) => (
        <li key={spot.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-mcs-xs text-mcs-text-default" title={spot.name}>
              {spot.name}
            </span>
            <span className="mcs-num shrink-0 text-mcs-2xs text-mcs-text-muted">
              {formatNumber(spot.sharePercent, 1)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-mcs-bg-subtle">
            <div
              className="h-full rounded-full bg-mcs-accent-fg"
              style={{ width: `${Math.min(100, Math.max(0, spot.sharePercent))}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function PerfDetailSection({
  detail,
  windowMs,
  hotspots,
}: {
  detail: PerfDetail
  windowMs: number
  hotspots: PerfDetail['hotspots']
}) {
  return (
    <div className="grid gap-3 @lg:grid-cols-2">
      <Card className="flex flex-col gap-3" data-testid="perf-hotspots">
        <CardHeader className="justify-between gap-2">
          <CardTitle as="h3">tick 内耗时分布</CardTitle>
          <span className="text-mcs-2xs text-mcs-text-muted">
            占 tick 内部耗时的比例 · {formatWindow(windowMs)} 取样
          </span>
        </CardHeader>
        <CardBody>
          <HotspotList hotspots={hotspots} />
        </CardBody>
      </Card>

      <Card className="flex flex-col gap-3" data-testid="perf-dimensions">
        <CardHeader className="justify-between gap-2">
          <CardTitle as="h3">各维度加载量</CardTitle>
          <span className="text-mcs-2xs text-mcs-text-muted">取样瞬间</span>
        </CardHeader>
        <CardBody>
          {detail.dimensions.length === 0 ? (
            <p className="text-mcs-xs text-mcs-text-muted">产物里没有维度数据。</p>
          ) : (
            <table className="w-full text-mcs-xs">
              <thead>
                <tr className="text-mcs-2xs text-mcs-text-muted">
                  <th scope="col" className="px-0 py-1 text-left font-normal">
                    维度
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-normal">
                    区块
                  </th>
                  <th scope="col" className="px-0 py-1 text-right font-normal">
                    实体
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.dimensions.map((dim) => (
                  <tr key={dim.name} className="border-t border-mcs-border-muted">
                    <td className="px-0 py-2 text-mcs-text-default">{dim.name}</td>
                    <td className="mcs-num px-2 py-2 text-right text-mcs-text-default">
                      {dim.chunks}
                    </td>
                    <td className="mcs-num px-0 py-2 text-right text-mcs-text-default">
                      {dim.entities}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card className="flex flex-col gap-3 @lg:col-span-2" data-testid="perf-runtime">
        <CardHeader className="justify-between gap-2">
          <CardTitle as="h3">运行时环境</CardTitle>
          <span className="text-mcs-2xs text-mcs-text-muted">取自产物里的 system.txt</span>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-mcs-xs text-mcs-text-muted">Minecraft</dt>
            <dd className="text-mcs-xs text-mcs-text-default">{detail.mcVersion ?? '未取到'}</dd>
            <dt className="text-mcs-xs text-mcs-text-muted">Java</dt>
            <dd className="text-mcs-xs text-mcs-text-default">{detail.javaVersion ?? '未取到'}</dd>
            <dt className="text-mcs-xs text-mcs-text-muted">CPU 核数</dt>
            <dd className="mcs-num text-mcs-xs text-mcs-text-default">{detail.cpus ?? '未取到'}</dd>
            <dt className="text-mcs-xs text-mcs-text-muted">进程平均 CPU</dt>
            <dd className="mcs-num text-mcs-xs text-mcs-text-default">
              {formatNumber(detail.processCpuPercent, 2)}%{/* 含「，」即按句子处理，最低 xs */}
              <span className="ml-1 text-mcs-xs text-mcs-text-muted">（自启动以来，单核口径）</span>
            </dd>
          </dl>
        </CardBody>
      </Card>
    </div>
  )
}

export function JfrDetailSection({ detail }: { detail: JfrDetail }) {
  return (
    <Card className="flex flex-col gap-3" data-testid="jfr-detail">
      <CardHeader className="justify-between gap-2">
        <CardTitle as="h3">垃圾回收与分配</CardTitle>
        <span className="text-mcs-2xs text-mcs-text-muted">
          {formatWindow(detail.durationMs)} 录制
        </span>
      </CardHeader>
      <CardBody>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-mcs-xs text-mcs-text-muted">GC 次数 / 累计耗时</dt>
          <dd className="mcs-num text-mcs-xs text-mcs-text-default">
            {detail.gcCount ?? '未取到'} 次 / {formatNumber(detail.gcTotalDurationMs)} ms
          </dd>
          <dt className="text-mcs-xs text-mcs-text-muted">分配速率</dt>
          <dd className="mcs-num text-mcs-xs text-mcs-text-default">
            {detail.allocationRateMiBPerSecond == null
              ? '未取到'
              : `${formatNumber(detail.allocationRateMiBPerSecond)} MiB/秒`}
          </dd>
          <dt className="text-mcs-xs text-mcs-text-muted">JVM CPU 平均占用</dt>
          <dd className="mcs-num text-mcs-xs text-mcs-text-default">
            {detail.cpuJvmAveragePercent == null
              ? '未取到'
              : `${formatNumber(detail.cpuJvmAveragePercent, 2)}%`}
          </dd>
          <dt className="text-mcs-xs text-mcs-text-muted">单刻耗时（平均 / 峰值）</dt>
          <dd className="mcs-num text-mcs-xs text-mcs-text-default">
            {detail.tickAverageMs == null ? '未取到' : `${formatNumber(detail.tickAverageMs, 3)}`}
            {detail.tickMaxMs == null ? '' : ` / ${formatNumber(detail.tickMaxMs, 3)}`} ms
          </dd>
        </dl>
      </CardBody>
    </Card>
  )
}
