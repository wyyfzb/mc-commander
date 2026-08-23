/**
 * HeartsArmor 测试：
 * - 心/护甲数值渲染语义（满心/半心/离线占位）
 * - 防裁剪回归：完整渲染宽 ≤ 状态列可用宽
 * mock 均为结构占位数值，无真实玩家数据
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeartsArmor, heartsArmorContentWidth } from '../hearts-armor'

describe('HeartsArmor 渲染语义', () => {
  it('满血满甲：aria-label 含精确值 + 护甲数字角标', () => {
    render(<HeartsArmor health={20} maxHealth={20} armor={15} />)
    const img = screen.getByRole('img', { name: /生命 20\/20，护甲 15/ })
    expect(img).toBeInTheDocument()
    // 护甲精确数值角标
    expect(img).toHaveTextContent('15')
    // title 保留精确值（hover 提示）
    expect(img).toHaveAttribute('title', '生命 20/20，护甲 15')
  })

  it('半心：奇数生命渲染半心结构', () => {
    render(<HeartsArmor health={13} maxHealth={20} armor={4} />)
    expect(screen.getByRole('img', { name: /生命 13\/20，护甲 4/ })).toBeInTheDocument()
  })

  it('离线（health 为 null）：显示占位 --', () => {
    const { container } = render(<HeartsArmor health={null} maxHealth={null} armor={null} />)
    expect(container.textContent).toBe('--')
  })

  it('护甲为 null（在线但未采集）：数值角标显示 0', () => {
    render(<HeartsArmor health={20} maxHealth={20} armor={null} />)
    expect(screen.getByRole('img', { name: /护甲 0/ })).toHaveTextContent('0')
  })
})

describe('状态列防裁剪回归', () => {
  it('最大数值（护甲两位数 20）完整渲染宽 ≤ 状态列可用宽', () => {
    // 状态列 size:192，td px-2 左右各 16px → 内容可用 160px
    const STATUS_CELL_AVAILABLE_PX = 192 - 32
    expect(heartsArmorContentWidth(11, 2)).toBeLessThanOrEqual(STATUS_CELL_AVAILABLE_PX)
  })

  it('1-2 位护甲数值均不溢出（原版护甲上限 20）', () => {
    const STATUS_CELL_AVAILABLE_PX = 192 - 32
    for (const digits of [1, 2]) {
      expect(heartsArmorContentWidth(11, digits)).toBeLessThanOrEqual(STATUS_CELL_AVAILABLE_PX)
    }
  })
})
