/**
 * accent 描边角色契约（UXT-22）
 * 交互控件「激活/选中态」边界一律用强档 --mcs-accent-border-strong（≥3:1，check:contrast 第 9 组覆盖）；
 * 弱档 --mcs-accent-border 仅作装饰描边，不得承担可辨识的控件状态。
 * 显式豁免（状态由文字/图标承载，不在此断言）：StatusPill 只读状态、瞬时 hover 边界。
 * 新增交互控件时请在此补一条断言——契约失败即回归。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Chip } from '../chip'
import { StatusPill } from '../status-pill'
import { FilterSelect } from '../filter-select'
import { DateTextInput } from '../date-text-input'
import { Stepper } from '@/features/instances/components/deploy/stepper'
import { BanDialog } from '@/features/players/components/ban-dialog'
import type { Player } from '@/api/types'

const STRONG = 'border-mcs-accent-border-strong'
// 强档类名以弱档为前缀，故弱档判定必须显式排除强档（类名拆分后逐 token 比较）
const WEAK = 'border-mcs-accent-border'

function tokens(el: Element): string[] {
  return el.className.split(/\s+/)
}

/** 断言元素用强档描边 */
function expectStrong(el: Element) {
  expect(tokens(el)).toContain(STRONG)
}

/** 断言元素只用弱档描边（装饰豁免） */
function expectWeakOnly(el: Element) {
  expect(tokens(el)).toContain(WEAK)
  expect(tokens(el)).not.toContain(STRONG)
}

/** 仅测试用结构占位玩家（虚构数据，严禁真实玩家信息） */
function makePlayer(): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000002',
    isOnline: true,
    ip: '1.2.3.4',
    joinTime: null,
    onlineTime: 0,
    totalPlayTime: 0,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: '',
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: 'survival',
    dimension: 'overworld',
    armor: null,
    xpProgress: null,
    ping: null,
    isSleeping: false,
    isAfk: false,
    isFlying: false,
    isSneaking: false,
    isSprinting: false,
    isBurning: false,
    isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: {
      totalOnline: 0,
      loginCount: 0,
      offlineSince: 0,
      deathCount: 0,
      achievementCount: 0,
      sleepCount: 0,
    },
  }
}

describe('accent 描边角色契约', () => {
  it('Chip 选中态（aria-pressed）用强档描边', () => {
    render(
      <Chip onClick={() => {}} selected>
        周一
      </Chip>,
    )
    expectStrong(screen.getByRole('button', { name: '周一' }))
  })

  it('Chip 静态 accent tone 用弱档（装饰描边，语义由文字承载）', () => {
    render(<Chip tone="accent">OP 1/3</Chip>)
    expectWeakOnly(screen.getByText('OP 1/3'))
  })

  it('StatusPill 只读状态用弱档（显式豁免）', () => {
    const { container } = render(
      <>
        <StatusPill tone="accent">运行中</StatusPill>
        <StatusPill tone="accent" variant="outline">
          运行中
        </StatusPill>
      </>,
    )
    const pills = [...container.querySelectorAll('[data-status-pill]')]
    expect(pills).toHaveLength(2)
    for (const pill of pills) expectWeakOnly(pill)
  })

  it('FilterSelect 激活态用强档，未筛选态无 accent 描边', () => {
    const options = [{ value: 'survival', label: '生存' }]
    const { rerender } = render(
      <FilterSelect label="游戏模式" value="survival" options={options} onChange={() => {}} />,
    )
    expectStrong(screen.getByRole('combobox', { name: '游戏模式' }))

    rerender(<FilterSelect label="游戏模式" value="" options={options} onChange={() => {}} />)
    expect(tokens(screen.getByRole('combobox', { name: '游戏模式' }))).not.toContain(STRONG)
  })

  it('DateTextInput 有值时激活态用强档', () => {
    render(<DateTextInput value="2026-09-15" onChange={vi.fn()} ariaLabel="开始日期" />)
    expectStrong(screen.getByLabelText('开始日期'))
  })

  it('Stepper 完成/当前圆点用强档描边，连接线用填充 token（非边框 token 当填充）', () => {
    const { container } = render(<Stepper step={1} />)
    // 完成圆点 + 当前步圆点
    expect(container.querySelectorAll(`.${STRONG}`)).toHaveLength(2)
    expect(container.querySelector('.bg-mcs-accent-border')).toBeNull()
    // 已完成连接线 + 完成圆点实底
    expect(container.querySelectorAll('.bg-mcs-accent')).toHaveLength(2)
  })

  it('BanDialog 选中项（类型 / 时长 / 理由）用强档描边', () => {
    render(
      <BanDialog
        open
        onOpenChange={vi.fn()}
        player={makePlayer()}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    // 封禁类型：选中项由 label 承载描边
    const radio = screen.getByRole('radio', { name: '玩家封禁' })
    expectStrong(radio.closest('label') as HTMLElement)

    // 时长 / 理由：所有 aria-pressed 选中项
    const pressed = screen.getAllByRole('button', { pressed: true })
    expect(pressed.length).toBeGreaterThanOrEqual(2)
    for (const btn of pressed) expectStrong(btn)
  })
})
