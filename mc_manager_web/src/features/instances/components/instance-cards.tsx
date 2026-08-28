/**
 * InstanceCards —— 实例卡片网格
 * - 网格 gap-3 sm:grid-cols-2 xl:grid-cols-3（页面头部由实例页渲染，本组件只负责网格与空态）
 * - 卡片：状态点（运行 success / 停止 muted）+ 名称 + 「当前」accent 徽章（currentId 命中）
 *   + 副行「运行中 · N 人在线」（success 色）/「已停止」（muted）+ 版本 mono 徽章
 *   （detailStatuses[id]?.mcVersion，组件内不查询；详情在途时仅该卡骨架占位）
 *   + 指标行（在线/TPS/JVM 堆/世界大小，detailStatuses 数据，缺省 —）
 *   + 操作：启停（运行中→停止 danger / 停止→启动 primary，busyId 防重复触发）/
 *     切换（非当前实例）/ 启动配置 / 卸载（danger outlined，卸载中禁用 + 「卸载中」）
 * - 空态：「暂无已安装的实例」+「部署新实例」按钮（onDeploy 与页面头部入口共用）
 * - 设计纪律：实底卡（玻璃禁区）+ --mcs-* 语义 token，禁硬编码色值/间距/圆角
 */
import { ArrowRightLeft, Loader2, Play, Server, Settings, ShieldAlert, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Chip } from '@/components/mcs/chip'
import type { InstanceStatus, InstanceSummary } from '@/api/types'

export interface InstanceCardsProps {
  /** 实例摘要列表（GET /instances 结果） */
  instances: InstanceSummary[]
  /** 当前实例 id（命中渲染「当前」徽章；非当前实例才显示切换按钮） */
  currentId: string | null
  /** 逐卡详情（GET /instances/:id 结果，含 mcVersion/playerCount 等；由页面传入，组件不查询） */
  detailStatuses: Record<string, InstanceStatus>
  /** 详情加载中的实例 id 集合（仅该卡版本徽章位置显示骨架） */
  loadingIds: ReadonlySet<string>
  /** 卸载中的实例 id（对应卡卸载按钮禁用 + 「卸载中」） */
  uninstallingId: string | null
  /** 切换当前实例 */
  onSwitch: (instance: InstanceSummary) => void
  /** 启动配置 → 实例设置弹窗（页面打开 InstanceSettingsDialog） */
  onOpenSettings: (instance: InstanceSummary) => void
  /** 卸载实例 */
  onUninstall: (instance: InstanceSummary) => void
  /** 启动实例 */
  onStart: (instance: InstanceSummary) => void
  /** 停止实例（页面负责确认弹窗） */
  onStop: (instance: InstanceSummary) => void
  /** 启停请求在途的实例 id（对应卡启停按钮禁用 + spinner） */
  busyId: string | null
  /** 部署新实例入口（空态按钮与页面头部共用） */
  onDeploy: () => void
}

export function InstanceCards({
  instances,
  currentId,
  detailStatuses,
  loadingIds,
  uninstallingId,
  onSwitch,
  onOpenSettings,
  onUninstall,
  onStart,
  onStop,
  busyId,
  onDeploy,
}: InstanceCardsProps) {
  if (instances.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-6 py-12">
        <Server className="size-8 text-mcs-text-subtle" aria-hidden />
        <p className="text-mcs-sm font-medium text-mcs-text-default">暂无已安装的实例</p>
        <p className="text-mcs-xs text-mcs-text-subtle">使用部署向导创建第一个实例</p>
        <Button size="sm" className="mt-1" onClick={onDeploy}>
          部署新实例
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {instances.map((instance) => (
        <InstanceCard
          key={instance.id}
          instance={instance}
          isCurrent={currentId === instance.id}
          detail={detailStatuses[instance.id]}
          detailLoading={loadingIds.has(instance.id)}
          isUninstalling={uninstallingId === instance.id}
          isBusy={busyId === instance.id}
          onSwitch={onSwitch}
          onOpenSettings={onOpenSettings}
          onUninstall={onUninstall}
          onStart={onStart}
          onStop={onStop}
        />
      ))}
    </div>
  )
}

/** 单张实例卡：状态点 + 名称 + 徽章 + 副行 + 操作按钮 */
function InstanceCard({
  instance,
  isCurrent,
  detail,
  detailLoading,
  isUninstalling,
  isBusy,
  onSwitch,
  onOpenSettings,
  onUninstall,
  onStart,
  onStop,
}: {
  instance: InstanceSummary
  isCurrent: boolean
  detail: InstanceStatus | undefined
  detailLoading: boolean
  isUninstalling: boolean
  isBusy: boolean
  onSwitch: (instance: InstanceSummary) => void
  onOpenSettings: (instance: InstanceSummary) => void
  onUninstall: (instance: InstanceSummary) => void
  onStart: (instance: InstanceSummary) => void
  onStop: (instance: InstanceSummary) => void
}) {
  const { id, name, isRunning, playerCount } = instance
  const mcVersion = detail?.mcVersion

  return (
    <div
      data-instance-id={id}
      className={cn(
        'flex flex-col gap-3 rounded-mcs-md border bg-mcs-bg-muted p-4',
        isCurrent ? 'border-mcs-accent-border' : 'border-mcs-border-muted',
        detail?.circuitBreakerTripped && 'border-mcs-error-border',
      )}
    >
      {/* 首行：状态点 + 名称 + 「当前」徽章 + 版本 mono 徽章（加载中骨架占位） */}
      <div className="flex items-center gap-2">
        <span
          data-instance-status={isRunning ? 'running' : 'stopped'}
          aria-hidden
          className={cn(
            'size-2 shrink-0 rounded-full',
            isRunning ? 'bg-mcs-success-fg' : 'bg-mcs-text-muted',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-mcs-sm font-semibold text-mcs-text-default" title={name}>
          {name}
        </span>
        {isCurrent && (
          <Chip tone="accent" className="h-5 px-1.5 text-mcs-2xs font-semibold">
            当前
          </Chip>
        )}
        {detailLoading ? (
          <Skeleton className="h-4 w-12 shrink-0" />
        ) : mcVersion ? (
          <Chip tone="muted" className="h-5 px-1.5 font-mono text-mcs-2xs" title={mcVersion}>
            {mcVersion}
          </Chip>
        ) : null}
      </div>

      {/* 副行：「运行中 · N 人在线」/「已停止」 */}
      <p className={cn('text-mcs-xs', isRunning ? 'text-mcs-success-fg' : 'text-mcs-text-muted')}>
        {isRunning ? `运行中 · ${playerCount} 人在线` : '已停止'}
      </p>

      {/* 指标行（在线/TPS/JVM 堆/世界大小；详情缺省 —） */}
      <div className="grid grid-cols-4 gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-3 py-2">
        <Metric label="在线" value={isRunning ? `${playerCount}` : '—'} />
        <Metric label="TPS" value={isRunning && detail?.tps != null ? detail.tps.toFixed(1) : '—'} />
        <Metric label="JVM 堆" value={isRunning && detail?.memoryUsage != null ? `${detail.memoryUsage}G` : '—'} />
        <Metric label="世界" value={detail?.worldSize ?? '—'} />
      </div>

      {/* 熔断告警行（feat-5） */}
      {detail?.circuitBreakerTripped && (
        <div className="flex items-center gap-1.5 rounded-mcs-sm border border-mcs-error-border bg-mcs-error-bg-subtle px-2.5 py-1.5 text-mcs-xs text-mcs-error-fg">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          <span>崩溃循环熔断已触发，自动重启已禁用</span>
        </div>
      )}
      {detail && !detail.circuitBreakerTripped && detail.consecutiveCrashes > 0 && (
        <div className="flex items-center gap-1.5 rounded-mcs-sm border border-mcs-warning-border bg-mcs-warning-bg-subtle px-2.5 py-1.5 text-mcs-xs text-mcs-warning-fg">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          <span>近期崩溃 {detail.consecutiveCrashes} 次</span>
        </div>
      )}

      {/* 操作行：启停 / 切换（非当前实例）/ 启动配置 / 卸载（卸载中禁用） */}
      <div className="mt-auto flex items-center justify-end gap-1.5">
        {isRunning ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={`停止 ${name}`}
            title="停止"
            disabled={isBusy}
            onClick={() => onStop(instance)}
            className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
          >
            {isBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Square aria-hidden />}
            停止
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label={`启动 ${name}`}
            title="启动"
            disabled={isBusy}
            onClick={() => onStart(instance)}
          >
            {isBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
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
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${name} 启动配置`}
          title="启动配置"
          onClick={() => onOpenSettings(instance)}
        >
          <Settings aria-hidden />
          配置
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={`卸载 ${name}`}
          title="卸载实例"
          disabled={isUninstalling}
          onClick={() => onUninstall(instance)}
          className="border-mcs-error-border text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
        >
          {isUninstalling ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
          {isUninstalling ? '卸载中' : '卸载'}
        </Button>
      </div>
    </div>
  )
}

/** 指标小格（label 上、数值下；tnum 对齐） */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-mcs-2xs text-mcs-text-subtle">{label}</div>
      <div className="tnum truncate text-mcs-sm font-semibold text-mcs-text-default" title={value}>
        {value}
      </div>
    </div>
  )
}
