/**
 * InstanceCards —— 实例卡片网格
 * - 网格列数见 INSTANCE_GRID_CLASS（与加载骨架共用同一声明）
 * - 卡片：状态点（运行 success / 停止 muted）+ 名称 + 「当前」accent 徽章（currentId 命中）
 *   + 副行「运行中 · N 人在线」（success 色）/「已停止」（muted）+ 版本 mono 徽章
 *   （detailStatuses[id]?.mcVersion，组件内不查询；详情在途时仅该卡骨架占位）
 *   + 指标行（在线/TPS/内存/世界大小，detailStatuses 数据，缺省 —）
 *   + 操作（收敛）：主操作最多两个——启停（busyId 防重复触发）/ 切换（非当前实例），
 *     配置、升级、卸载收进「操作菜单」（弹窗类与破坏性操作，低频；卸载另有输入实例名的强确认）
 * - 空态：「暂无已安装的实例」+「部署新实例」按钮（onDeploy 与页面头部入口共用）
 * - 设计纪律：实底卡（玻璃禁区）+ --mcs-* 语义 token，禁硬编码色值/间距/圆角
 */
import {
  ArrowRightLeft,
  ArrowUpCircle,
  Loader2,
  MoreHorizontal,
  Play,
  Server,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatWorldSize } from '@/lib/format'
import { instanceHueFillClass } from '@/lib/instance-hue'
import { instanceLabel } from '@/lib/instance-label'
import { StatusPill } from '@/components/mcs/status-pill'
import { Card } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { EmptyState } from '@/components/mcs/empty-state'
import { DeployGuideTile } from './deploy-guide-tile'
import { useUpgradeStore, isUpgradeTerminal } from '@/stores/upgrade'
import type { InstancePhase } from '@/stores/server'
import type { InstanceStatus, InstanceSummary } from '@/api/types'

/**
 * 实例网格列数（唯一声明源：真实网格与加载骨架共用，防止骨架列数与真实布局分叉）
 * 按**容器内容宽**切档（`@container` 由页面根声明）：视口断点在这里判不准——侧栏可折叠
 * （56px ↔ 208px），同一视口宽下内容宽差 152px：768 视口展开侧栏仅 528px，视口 `md` 判出的
 * 两列每张 258px，卡内四格指标行被压到 44px/格（"3.2 GB" 实测截断）；而 1279 视口内容
 * 已有 1039px，视口差 1px 未达 `xl` 仍给两列（每张 513px），白丢一列。
 * 档位按卡片最小可用宽反推，与仪表盘三卡同档（@2xl 两列 / @5xl 三列）：
 * 四格指标行每格 ≥62px 才放得下 "32.0 GB"（实测 63px 格不截断、54px 格的 3.2GB 也够），
 * 故 672px（@2xl）起两列（每张 330px，格 62px）、1024px（@5xl）起三列（每张 333px，格 63px）。
 * 低于 672px 只给一列：两列会把卡片压到 258px 级（44px/格，"3.2 GB" 实测截断），
 * 而单列拉到 660px 只是指标格变疏（144px/格），不损失信息——与仪表盘顶卡同档取舍
 * 列数不随实例数变化，骨架与真实网格永不跳变——单实例下由引导块跨两列补满整行
 * （DeployGuideTile 的 `@5xl:col-span-2`，与三列档同源）
 */
export const INSTANCE_GRID_CLASS = 'grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3'

export interface InstanceCardsProps {
  /** 实例摘要列表（GET /instances 结果） */
  instances: InstanceSummary[]
  /** 当前实例 id（命中渲染「当前」徽章；非当前实例才显示切换按钮） */
  currentId: string | null
  /** 逐卡详情（GET /instances/:id 结果，含 mcVersion/playerCount 等；由页面传入，组件不查询） */
  detailStatuses: Record<string, InstanceStatus>
  /** 详情加载中的实例 id 集合（仅该卡版本徽章位置显示骨架） */
  loadingIds: ReadonlySet<string>
  /** 详情查询失败的实例 id 集合（该卡指标区改显失败提示 + 重试，不把故障呈现成「—」） */
  detailErrorIds: ReadonlySet<string>
  /** 重试某实例的详情查询（详情失败卡的重试入口） */
  onRetryDetail: (instanceId: string) => void
  /** 卸载中的实例 id（该卡操作菜单的「卸载实例」项禁用 + 文案切换为「卸载中」，触发器转 spinner） */
  uninstallingId: string | null
  /** 切换当前实例 */
  onSwitch: (instance: InstanceSummary) => void
  /** 启动配置 → 实例设置弹窗（页面打开 InstanceSettingsDialog） */
  onOpenSettings: (instance: InstanceSummary) => void
  /** 卸载实例 */
  onUninstall: (instance: InstanceSummary) => void
  /** 升级实例（已停止时可用） */
  onUpgrade: (instance: InstanceSummary) => void
  /** 启动实例 */
  onStart: (instance: InstanceSummary) => void
  /** 停止实例（页面负责确认弹窗） */
  onStop: (instance: InstanceSummary) => void
  /** 启停请求在途的实例 id（对应卡启停按钮禁用 + spinner） */
  busyId: string | null
  /** 启停中间态表（issue 334：starting/stopping 期间对应卡禁用；与 busyId 叠加） */
  phaseById: Record<string, InstancePhase>
  /** 部署新实例入口（空态按钮与页面头部共用） */
  onDeploy: () => void
}

export function InstanceCards({
  instances,
  currentId,
  detailStatuses,
  loadingIds,
  detailErrorIds,
  onRetryDetail,
  uninstallingId,
  onSwitch,
  onOpenSettings,
  onUninstall,
  onUpgrade,
  onStart,
  onStop,
  busyId,
  phaseById,
  onDeploy,
}: InstanceCardsProps) {
  if (instances.length === 0) {
    return (
      /* 空态（EmptyState 统一组件；保留独立卡容器描边，绿实底 CTA 对齐原默认 variant） */
      <EmptyState
        icon={Server}
        title="暂无已安装的实例"
        hint="使用部署向导创建第一个实例"
        action={{ label: '部署新实例', onClick: onDeploy }}
        actionVariant="greenFilled"
        className="h-auto rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted py-12"
      />
    )
  }

  return (
    <div className={INSTANCE_GRID_CLASS}>
      {instances.map((instance, index) => (
        <InstanceCard
          key={instance.id}
          instance={instance}
          isCurrent={currentId === instance.id}
          detail={detailStatuses[instance.id]}
          detailLoading={loadingIds.has(instance.id)}
          detailFailed={detailErrorIds.has(instance.id)}
          onRetryDetail={() => onRetryDetail(instance.id)}
          isUninstalling={uninstallingId === instance.id}
          isBusy={busyId === instance.id}
          phase={phaseById[instance.id] ?? null}
          onSwitch={onSwitch}
          onOpenSettings={onOpenSettings}
          onUpgrade={onUpgrade}
          onUninstall={onUninstall}
          onStart={onStart}
          onStop={onStop}
          className={`animate-mcs-fade-up mcs-delay-${Math.min(index + 1, 6)}`}
        />
      ))}
      {instances.length === 1 && (
        <DeployGuideTile
          onDeploy={onDeploy}
          className="animate-mcs-fade-up mcs-delay-2 @5xl:col-span-2"
        />
      )}
    </div>
  )
}

/** 单张实例卡：状态点 + 名称 + 徽章 + 副行 + 操作按钮 */
function InstanceCard({
  instance,
  isCurrent,
  detail,
  detailLoading,
  detailFailed,
  onRetryDetail,
  isUninstalling,
  isBusy,
  phase,
  onSwitch,
  onOpenSettings,
  onUninstall,
  onUpgrade,
  onStart,
  onStop,
  className,
}: {
  instance: InstanceSummary
  isCurrent: boolean
  detail: InstanceStatus | undefined
  detailLoading: boolean
  /** 详情查询失败（无旧值可留——有旧值时仍按旧值渲染，不打扰用户） */
  detailFailed: boolean
  onRetryDetail: () => void
  isUninstalling: boolean
  isBusy: boolean
  phase: InstancePhase | null
  onSwitch: (instance: InstanceSummary) => void
  onOpenSettings: (instance: InstanceSummary) => void
  onUninstall: (instance: InstanceSummary) => void
  onUpgrade: (instance: InstanceSummary) => void
  onStart: (instance: InstanceSummary) => void
  onStop: (instance: InstanceSummary) => void
  /** 入场 stagger（页面组合处注入，组件内不内嵌动效类） */
  className?: string
}) {
  const { id, isRunning, playerCount } = instance
  // 展示名与操作按钮的可访问名统一走 instanceLabel（空名回退 id，避免出现无名按钮）
  const name = instanceLabel(instance)
  const mcVersion = detail?.mcVersion
  // 升级中标识（issue 352）：WS 订阅补发/实时事件驱动；终态残留不误显示
  // （终态 store 清理由升级弹窗打开时做，卡片只认非终态）
  const upgradeStage = useUpgradeStore((s) => s.progress[id]?.stage)
  const upgrading = upgradeStage != null && !isUpgradeTerminal(upgradeStage)

  return (
    <Card
      as="div"
      data-instance-id={id}
      className={cn(
        // min-w-0：卡片是网格项，网格项的 min-width 默认 auto ⇒ 长实例名会把整列按 min-content 撑宽
        // （卡内名字虽有 truncate，但外层不松绑就轮不到它截断），窄屏下表现为卡片与引导块被挤出视口
        'mcs-edge-top relative flex min-w-0 flex-col gap-3 p-4',
        className,
        isCurrent ? 'border-mcs-accent-border' : 'border-mcs-border-muted',
        detail?.circuitBreakerTripped && 'border-mcs-error-border',
      )}
    >
      {/* 实例固定色相标识（非语义 identity）：贴左缘、上下各内缩 12px 的长色条（2px 宽、随卡高伸缩），
          与首行状态点（success/muted，语义）各司其职——色条说「是哪个实例」，状态点说「现在怎么样」；
          颜色与卡片描边/熔断描边无关，不随之换色 */}
      <span
        data-instance-hue
        aria-hidden
        className={cn('absolute inset-y-3 left-0 w-0.5 rounded-full', instanceHueFillClass(id))}
      />
      {/* 首行：状态点 + 名称 + 「当前」徽章 + 升级中徽章 + 版本 mono 徽章（加载中骨架占位） */}
      <div className="flex items-center gap-2">
        <span
          data-instance-status={isRunning ? 'running' : 'stopped'}
          aria-hidden
          className={cn(
            'size-2 shrink-0 rounded-full',
            isRunning ? 'bg-mcs-success-fg' : 'bg-mcs-text-muted',
          )}
        />
        <span
          className="min-w-0 flex-1 truncate text-mcs-sm font-semibold text-mcs-text-default"
          title={name}
        >
          {name}
        </span>
        {isCurrent && (
          <StatusPill tone="accent" className="text-mcs-2xs font-semibold">
            当前
          </StatusPill>
        )}
        {upgrading && (
          <StatusPill
            tone="accent"
            className="gap-1 text-mcs-2xs font-semibold"
            title={`正在升级 ${name}`}
          >
            <Loader2 className="size-3 animate-spin" aria-hidden />
            升级中
          </StatusPill>
        )}
        {detailLoading ? (
          <Skeleton className="h-4 w-12 shrink-0" />
        ) : mcVersion ? (
          <StatusPill tone="muted" className="font-mono text-mcs-2xs" title={mcVersion}>
            {mcVersion}
          </StatusPill>
        ) : detailFailed ? (
          /* 取值失败与「本来就没有版本号」必须可区分：静默消失会让用户以为实例没问题 */
          <StatusPill tone="warning" className="text-mcs-2xs" title="版本号获取失败">
            版本未知
          </StatusPill>
        ) : null}
      </div>

      {/* 副行：「运行中 · N 人在线」/「已停止」 */}
      <p className={cn('text-mcs-xs', isRunning ? 'text-mcs-success-fg' : 'text-mcs-text-muted')}>
        {isRunning ? `运行中 · ${playerCount} 人在线` : '已停止'}
      </p>

      {/* 指标行（在线/TPS/内存/世界大小；详情缺省 —）
          这里的 memoryUsage 是**进程驻留内存**（服务端 stats-collector 三平台分支分别取
          Windows WorkingSet / Linux statm RSS / macOS ps rss），不是 JVM 堆——要显示真实堆
          需服务端另采指标。数值以「数字 + GB」展示，精度随采集端平台而异（世界大小另有 MB 档，不与之共用格式化）。
          统计未就绪初值为 0，此时显示 —（运行中却报 0 会被读成「内存耗光」） */}
      <div className="grid grid-cols-4 gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-3 py-2 shadow-mcs-card">
        <Metric label="在线" value={isRunning ? `${playerCount}` : '—'} />
        <Metric
          label="TPS"
          value={isRunning && detail?.tps != null ? detail.tps.toFixed(1) : '—'}
        />
        <Metric
          label="内存"
          value={isRunning && detail && detail.memoryUsage > 0 ? `${detail.memoryUsage} GB` : '—'}
        />
        <Metric label="世界" value={formatWorldSize(detail?.worldSize)} />
      </div>

      {/* 详情失败行：指标区此时满屏「—」，不说明就等于宣称「这台机器没有 TPS/内存/世界大小」。
          只在无旧值可留时出现——有旧值时旧数据仍在卡片上，加提示反而打断（同 lib/query-phase 口径） */}
      {detailFailed && !detail && (
        <NoticeBanner variant="warning" icon={TriangleAlert}>
          <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span>运行详情获取失败，上方指标不可用</span>
            <Button size="xs" variant="outline" onClick={onRetryDetail}>
              重试
            </Button>
          </span>
        </NoticeBanner>
      )}

      {/* 熔断告警行（feat-5） */}
      {detail?.circuitBreakerTripped && (
        <NoticeBanner variant="error" icon={ShieldAlert}>
          崩溃循环熔断已触发，自动重启已禁用
        </NoticeBanner>
      )}
      {detail && !detail.circuitBreakerTripped && detail.consecutiveCrashes > 0 && (
        <NoticeBanner variant="warning" icon={ShieldAlert}>
          近期崩溃 {detail.consecutiveCrashes} 次
        </NoticeBanner>
      )}

      {/* 操作行：主操作只留启停（状态类，按 phase 中间态禁用：starting/stopping
          spinner，WS 确认后解锁 issue 334）与切换（非当前实例的导航）；
          配置/升级/卸载收进操作菜单——弹窗类与破坏性操作低频，且卸载另有输入实例名的强确认，
          五个按钮平铺会把卡片右下角挤满。菜单项文案对齐各自弹窗标题。
          「停止」有中断服务与断连玩家的后果，走 destructive 变体；危险语义色只从变体取，
          不在调用点手写第二份色类（否则变体一改、这里就静默掉队） */}
      <div className="mt-auto flex items-center justify-end gap-1.5">
        {isRunning ? (
          <Button
            variant="destructive"
            size="sm"
            aria-label={phase === 'stopping' ? `正在停止 ${name}` : `停止 ${name}`}
            title="停止"
            disabled={isBusy || phase !== null}
            onClick={() => onStop(instance)}
          >
            {isBusy || phase === 'stopping' ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Square aria-hidden />
            )}
            停止
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label={phase === 'starting' ? `正在启动 ${name}` : `启动 ${name}`}
            title="启动"
            disabled={isBusy || phase !== null}
            onClick={() => onStart(instance)}
          >
            {isBusy || phase === 'starting' ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Play aria-hidden />
            )}
            启动
          </Button>
        )}
        {!isCurrent && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`切换到 ${name}`}
            title={`切换到 ${name}`}
            onClick={() => onSwitch(instance)}
          >
            <ArrowRightLeft aria-hidden />
            切换
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* 卸载在途时触发器转 spinner + aria-busy：卸载反馈原本挂在行内按钮上，
                收进菜单后若不在此处承接，卡片面在整段卸载期间无任何进行中信号 */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${name} 操作菜单`}
              aria-busy={isUninstalling}
            >
              {isUninstalling ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <MoreHorizontal aria-hidden />
              )}
            </Button>
          </DropdownMenuTrigger>
          {/* 走 radix 的 onSelect 而非 onClick：DropdownMenuItem 的 disabled 只拦 onSelect
              （onClick 被原样组合到 DOM 上，仅靠 data-disabled:pointer-events-none 兜底），
              卸载中的禁用必须由 JS 拦住第二次请求，不能只依赖一条工具类 */}
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpenSettings(instance)}>
              <Settings aria-hidden />
              启动配置
            </DropdownMenuItem>
            {!isRunning && (
              <DropdownMenuItem onSelect={() => onUpgrade(instance)}>
                <ArrowUpCircle aria-hidden />
                升级版本
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={isUninstalling}
              onSelect={() => onUninstall(instance)}
            >
              {isUninstalling ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              {isUninstalling ? '卸载中' : '卸载实例'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  )
}

/** 指标小格（label 上、数值下；tnum 对齐） */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-mcs-2xs text-mcs-text-muted">{label}</div>
      <div
        className="mcs-num truncate text-mcs-sm leading-none font-semibold text-mcs-text-default"
        title={value}
      >
        {value}
      </div>
    </div>
  )
}
