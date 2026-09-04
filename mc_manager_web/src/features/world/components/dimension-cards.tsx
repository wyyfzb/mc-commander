/**
 * 维度卡
 * 每张卡：左 4px 维度语义色条 + 36px emoji 圆图标（同色 12% 浅底）+ 维度名 + 在线玩家
 * 颜色全部走 --mcs-dimension-* 语义 token（semantic.css 已定义，但未注册 Tailwind
 * 工具类，故以 inline var() 引用——与 stat-cards 的 colorVar 同模式，无硬编码色值；
 * 图标浅底以 color-mix 复现 --mcs-*-bg-subtle 的 12% alpha 模式）
 * 空 dimensions 返回 null（区块标题由父组件按需渲染）
 */
import type { WorldInfo } from '@/api/types'
import { cn } from '@/lib/utils'

export type DimensionKind = 'overworld' | 'nether' | 'end'

/** 维度判定（按名称含「下界/地狱」→nether、「末地」→end，其余→overworld；英文名兼容） */
export function dimensionKind(name: string): DimensionKind {
  const lower = name.toLowerCase()
  if (lower.includes('下界') || lower.includes('地狱') || lower.includes('nether')) return 'nether'
  if (lower.includes('末地') || lower.includes('end')) return 'end'
  return 'overworld'
}

/** 维度英文名（地狱/下界→Nether、末地→The End、主世界→Overworld） */
export function dimEnglishName(name: string): string {
  if (name.includes('地狱') || name.includes('下界')) return 'Nether'
  if (name.includes('末地')) return 'The End'
  if (name.includes('主世界') || name.includes('世界')) return 'Overworld'
  return name
}

/** 维度语义色 token（左色条） */
const DIMENSION_VAR: Record<DimensionKind, string> = {
  overworld: 'var(--mcs-dimension-overworld)',
  nether: 'var(--mcs-dimension-nether)',
  end: 'var(--mcs-dimension-end)',
}

/** 维度同色浅底（复现 --mcs-*-bg-subtle 的 12% alpha 模式） */
const DIMENSION_BG_SUBTLE: Record<DimensionKind, string> = {
  overworld: 'color-mix(in oklch, var(--mcs-dimension-overworld) 12%, transparent)',
  nether: 'color-mix(in oklch, var(--mcs-dimension-nether) 12%, transparent)',
  end: 'color-mix(in oklch, var(--mcs-dimension-end) 12%, transparent)',
}

export interface DimensionCardsProps {
  dimensions: WorldInfo['dimensions'] | undefined
  /** 入场 stagger（页面组合处注入） */
  className?: string
}

/** 维度卡（3 张；空/未定义不渲染。左栏 320px 窄列下纵向堆叠，避免三列截断） */
export function DimensionCards({ dimensions, className }: DimensionCardsProps) {
  if (!dimensions || dimensions.length === 0) return null

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {dimensions.map((dim) => {
        const kind = dimensionKind(dim.name)
        const english = dimEnglishName(dim.name)
        return (
          <section
            key={dim.name}
            data-dimension-kind={kind}
            className="flex overflow-hidden rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted shadow-mcs-card"
          >
            {/* 左 4px 垂直维度色条（维度语义色 token） */}
            <span
              aria-hidden
              data-dimension-bar
              className="w-1 shrink-0"
              style={{ backgroundColor: DIMENSION_VAR[kind] }}
            />
            <div className="flex min-w-0 flex-1 items-center gap-3 p-3">
              {/* 36px emoji 圆图标（同色浅底） */}
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-mcs-lg"
                style={{ backgroundColor: DIMENSION_BG_SUBTLE[kind] }}
              >
                {dim.icon}
              </span>
              <div className="min-w-0">
                <p className="truncate text-mcs-sm font-medium" title={dim.name}>
                  {dim.name}
                  {english !== dim.name && (
                    <span className="ml-1.5 text-mcs-xs font-normal text-mcs-text-muted">{english}</span>
                  )}
                </p>
                <p className="text-mcs-xs text-mcs-text-muted">在线玩家 {dim.playerCount}</p>
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
