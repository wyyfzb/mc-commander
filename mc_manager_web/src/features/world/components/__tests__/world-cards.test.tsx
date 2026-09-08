/**
 * WorldInfoCard / DimensionCards 测试：
 * 9 行信息渲染 / 类型·难度·模式中文映射 / PillBadge 状态色 / 存档大小进度 /
 * 加载骨架 / 空态 / 刷新按钮 / 3 张维度卡 + 色条 token / 空维度不渲染
 * mock 数据为虚构占位（虚构世界名/种子/玩家数），严禁真实数据
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  WorldInfoCard,
  formatWorldType,
  formatDifficulty,
  formatGameMode,
  difficultyTone,
  gameModeTone,
  sizeProgress,
} from '../world-info-card'
import { StatusPill } from '@/components/mcs/status-pill'
import { DimensionCards, dimensionKind } from '../dimension-cards'
import type { WorldInfo } from '@/api/types'

// ── 虚构占位数据（禁止真实玩家/服务器信息）──────────────────

function makeWorld(overrides: Partial<WorldInfo> = {}): WorldInfo {
  return {
    name: '虚构测试世界',
    type: 'minecraft:normal',
    seed: '9876543210123456789',
    sizeGB: 3.2,
    difficulty: 'normal',
    gameMode: 'survival',
    viewDistance: 10,
    simulationDistance: 10,
    onlinePlayers: 3,
    maxPlayers: 20,
    spawnProtection: 16,
    maxWorldSize: 29_999_984,
    allowFlight: false,
    hardcore: false,
    pvp: true,
    commandBlock: false,
    generateStructures: true,
    whiteList: false,
    onlineMode: true,
    lastSave: new Date(Date.now() - 60_000).toISOString(),
    gameDays: 42,
    dimensions: [
      { name: '主世界', icon: '🌍', playerCount: 2 },
      { name: '下界', icon: '🔥', playerCount: 1 },
      { name: '末地', icon: '🟣', playerCount: 0 },
    ],
    ...overrides,
  }
}

// ── 映射单元测试 ──────────────────────────────────────────────────

describe('世界类型/难度/模式映射', () => {
  it('世界类型中文映射（含旧版无下划线写法；未知原样返回）', () => {
    expect(formatWorldType('flat')).toBe('平坦')
    expect(formatWorldType('large_biomes')).toBe('放大化')
    expect(formatWorldType('largebiomes')).toBe('放大化')
    expect(formatWorldType('single_biome_surface')).toBe('单生物群系')
    expect(formatWorldType('singlebiome')).toBe('单生物群系')
    expect(formatWorldType('minecraft:normal')).toBe('默认')
    expect(formatWorldType('normal')).toBe('默认')
    // 未知类型原样返回（兼容 26.x 新版扩展类型）
    expect(formatWorldType('minecraft:amplified')).toBe('minecraft:amplified')
    expect(formatWorldType('FLAT')).toBe('平坦')
  })

  it('难度中文映射', () => {
    expect(formatDifficulty('peaceful')).toBe('和平')
    expect(formatDifficulty('easy')).toBe('简单')
    expect(formatDifficulty('hard')).toBe('困难')
    expect(formatDifficulty('normal')).toBe('普通')
  })

  it('游戏模式中文映射', () => {
    expect(formatGameMode('survival')).toBe('生存')
    expect(formatGameMode('creative')).toBe('创造')
    expect(formatGameMode('adventure')).toBe('冒险')
    expect(formatGameMode('spectator')).toBe('旁观')
  })

  it('难度 → StatusPill 状态色（peaceful→info/easy→success/hard→error/其余→warning）', () => {
    expect(difficultyTone('peaceful')).toBe('info')
    expect(difficultyTone('easy')).toBe('success')
    expect(difficultyTone('hard')).toBe('error')
    expect(difficultyTone('normal')).toBe('warning')
    expect(difficultyTone('unknown')).toBe('warning')
  })

  it('游戏模式 → StatusPill 状态色（survival→success/creative→info/adventure→warning/spectator→purple）', () => {
    expect(gameModeTone('survival')).toBe('success')
    expect(gameModeTone('creative')).toBe('info')
    expect(gameModeTone('adventure')).toBe('warning')
    expect(gameModeTone('spectator')).toBe('purple')
  })

  it('存档大小进度按 sizeGB/10 clamp（0-100%）', () => {
    expect(sizeProgress(3.2)).toBeCloseTo(0.32)
    expect(sizeProgress(10)).toBe(1)
    expect(sizeProgress(25)).toBe(1)
    expect(sizeProgress(0)).toBe(0)
    expect(sizeProgress(-1)).toBe(0)
  })
})

// ── StatusPill 状态色 token 断言 ───────────────────────────────────

describe('StatusPill', () => {
  it('按 tone 输出 --mcs-*-border/bg-subtle/fg 三元组 token 类', () => {
    const { container } = render(
      <>
        <StatusPill tone="warning">普通</StatusPill>
        <StatusPill tone="info">和平</StatusPill>
        <StatusPill tone="success">生存</StatusPill>
        <StatusPill tone="error">困难</StatusPill>
        <StatusPill tone="purple">旁观</StatusPill>
      </>,
    )
    const pills = container.querySelectorAll('[data-status-pill]')
    expect(pills).toHaveLength(5)
    const warning = pills[0] as HTMLElement
    expect(warning.dataset.statusTone).toBe('warning')
    expect(warning.classList.contains('text-mcs-warning-fg')).toBe(true)
    expect(warning.classList.contains('bg-mcs-warning-bg-subtle')).toBe(true)
    expect(warning.classList.contains('border-mcs-warning-border')).toBe(true)
    const info = pills[1] as HTMLElement
    expect(info.classList.contains('text-mcs-info-fg')).toBe(true)
    expect(info.classList.contains('bg-mcs-info-bg-subtle')).toBe(true)
    const success = pills[2] as HTMLElement
    expect(success.classList.contains('text-mcs-success-fg')).toBe(true)
    const error = pills[3] as HTMLElement
    expect(error.classList.contains('text-mcs-error-fg')).toBe(true)
    const purple = pills[4] as HTMLElement
    expect(purple.classList.contains('text-mcs-purple-fg')).toBe(true)
  })
})

// ── 世界信息卡渲染 ────────────────────────────────────────────────

describe('WorldInfoCard', () => {
  it('渲染 9 行信息（标签 + 值），不硬编码样式细节', () => {
    render(<WorldInfoCard world={makeWorld()} isLoading={false} onRefresh={() => {}} />)

    // 9 个标签齐全
    const labels = ['世界名称', '世界类型', '种子', '存档大小', '游戏天数', '难度', '游戏模式', '视野距离', '在线玩家']
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // 值渲染（mcs-num 数字与 CJK/Latin 单位拆分为独立 span，分别断言）
    expect(screen.getByText('虚构测试世界')).toBeInTheDocument()
    expect(screen.getByText('默认')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('天')).toBeInTheDocument()
    expect(screen.getByText('3/20')).toBeInTheDocument()
    expect(screen.getByText('3.2')).toBeInTheDocument()
    expect(screen.getByText('GB')).toBeInTheDocument()
    // 难度/模式 PillBadge 文本
    expect(screen.getByText('普通')).toBeInTheDocument()
    expect(screen.getByText('生存')).toBeInTheDocument()
  })

  it('种子以 font-mono 显示 + title 完整值', () => {
    const { container } = render(<WorldInfoCard world={makeWorld()} isLoading={false} onRefresh={() => {}} />)
    const seed = container.querySelector('.font-mono')
    expect(seed).not.toBeNull()
    expect(seed?.textContent).toBe('9876543210123456789')
    expect(seed?.getAttribute('title')).toBe('9876543210123456789')
    expect(seed?.classList.contains('truncate')).toBe(true)
  })

  it('存档大小进度条宽度 = sizeGB/10，颜色走 --mcs-accent', () => {
    const { container } = render(<WorldInfoCard world={makeWorld({ sizeGB: 3.2 })} isLoading={false} onRefresh={() => {}} />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-valuenow')).toBe('3.2')
    const fill = bar?.querySelector('span') as HTMLElement
    expect(fill.style.width).toBe('32%')
    expect(fill.classList.contains('bg-mcs-accent')).toBe(true)
  })

  it('存档大小超过 10GB 时进度条 clamp 到 100%', () => {
    const { container } = render(<WorldInfoCard world={makeWorld({ sizeGB: 25 })} isLoading={false} onRefresh={() => {}} />)
    const fill = container.querySelector('[role="progressbar"] span') as HTMLElement
    expect(fill.style.width).toBe('100%')
  })

  it('难度/游戏模式 PillBadge 按值选择状态色', () => {
    const { container } = render(
      <WorldInfoCard
        world={makeWorld({ difficulty: 'hard', gameMode: 'creative' })}
        isLoading={false}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText('困难')).toBeInTheDocument()
    expect(screen.getByText('创造')).toBeInTheDocument()
    const pills = container.querySelectorAll('[data-status-pill]')
    expect(pills[0]!.getAttribute('data-status-tone')).toBe('error')
    expect(pills[1]!.getAttribute('data-status-tone')).toBe('info')
  })

  it('加载中显示骨架行，刷新按钮禁用 + 图标旋转', () => {
    const { container } = render(<WorldInfoCard world={null} isLoading onRefresh={() => {}} />)
    expect(screen.getByTestId('world-info-skeleton')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    const refresh = screen.getByRole('button', { name: '刷新' })
    expect(refresh).toBeDisabled()
    const icon = refresh.querySelector('svg')
    expect(icon?.classList.contains('animate-spin')).toBe(true)
  })

  it('world 为 null 显示空态占位「暂无世界信息」', () => {
    render(<WorldInfoCard world={null} isLoading={false} onRefresh={() => {}} />)
    expect(screen.getByText('暂无世界信息')).toBeInTheDocument()
    expect(screen.queryByText('虚构测试世界')).not.toBeInTheDocument()
  })

  it('gameDays null 时显示「不可用」而非数字', () => {
    render(<WorldInfoCard world={makeWorld({ gameDays: null })} isLoading={false} onRefresh={() => {}} />)
    expect(screen.getByText('不可用')).toBeInTheDocument()
    expect(screen.queryByText('42')).not.toBeInTheDocument()
  })

  it('点击刷新按钮触发 onRefresh；加载中禁用时点击不触发', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<WorldInfoCard world={makeWorld()} isLoading={false} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // 加载中：disabled，点击不触发
    rerender(<WorldInfoCard world={makeWorld()} isLoading onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})

// ── 维度卡 ────────────────────────────────────────────────────────

describe('DimensionCards', () => {
  it('维度判定：下界/地狱→nether、末地→end、其余→overworld', () => {
    expect(dimensionKind('主世界')).toBe('overworld')
    expect(dimensionKind('下界')).toBe('nether')
    expect(dimensionKind('地狱')).toBe('nether')
    expect(dimensionKind('minecraft:the_nether')).toBe('nether')
    expect(dimensionKind('末地')).toBe('end')
    expect(dimensionKind('minecraft:the_end')).toBe('end')
    expect(dimensionKind('minecraft:overworld')).toBe('overworld')
  })

  it('渲染 3 张维度卡：中文名 + 在线玩家 + emoji 图标', () => {
    render(<DimensionCards dimensions={makeWorld().dimensions} />)
    expect(screen.getByText('主世界')).toBeInTheDocument()
    expect(screen.getByText('下界')).toBeInTheDocument()
    expect(screen.getByText('末地')).toBeInTheDocument()
    expect(screen.getByText('在线玩家 2')).toBeInTheDocument()
    expect(screen.getByText('在线玩家 1')).toBeInTheDocument()
    expect(screen.getByText('在线玩家 0')).toBeInTheDocument()
    expect(screen.getByText('🌍')).toBeInTheDocument()
    expect(screen.getByText('🔥')).toBeInTheDocument()
    expect(screen.getByText('🟣')).toBeInTheDocument()
  })

  it('维度色条：按名称匹配维度 token（--mcs-dimension-*）', () => {
    const { container } = render(<DimensionCards dimensions={makeWorld().dimensions} />)
    const cards = container.querySelectorAll('[data-dimension-kind]')
    expect(cards).toHaveLength(3)

    const barOf = (kind: string) => {
      const card = Array.from(cards).find((c) => c.getAttribute('data-dimension-kind') === kind) as HTMLElement
      return card.querySelector('[data-dimension-bar]') as HTMLElement
    }
    // 主世界青绿 / 下界红橙 / 末地紫（断言引用的是语义 token 变量，非硬编码色值）
    expect(barOf('overworld').style.backgroundColor).toBe('var(--mcs-dimension-overworld)')
    expect(barOf('nether').style.backgroundColor).toBe('var(--mcs-dimension-nether)')
    expect(barOf('end').style.backgroundColor).toBe('var(--mcs-dimension-end)')
    // 色条宽度 4px（w-1）
    expect(barOf('nether').classList.contains('w-1')).toBe(true)
  })

  it('维度色条高度撑满卡片（flex 拉伸）与卡片同高', () => {
    const { container } = render(<DimensionCards dimensions={makeWorld().dimensions} />)
    const nether = Array.from(container.querySelectorAll('[data-dimension-kind]')).find(
      (c) => c.getAttribute('data-dimension-kind') === 'nether',
    ) as HTMLElement
    const bar = nether.querySelector('[data-dimension-bar]') as HTMLElement
    // 色条默认 stretch（align-items: stretch）下与卡片等高，shrink-0 保持 4px 宽度
    expect(bar.classList.contains('shrink-0')).toBe(true)
  })

  it('空/未定义 dimensions 不渲染任何内容', () => {
    const { container } = render(<DimensionCards dimensions={[]} />)
    expect(container.innerHTML).toBe('')
    const { container: c2 } = render(<DimensionCards dimensions={undefined} />)
    expect(c2.innerHTML).toBe('')
  })
})
