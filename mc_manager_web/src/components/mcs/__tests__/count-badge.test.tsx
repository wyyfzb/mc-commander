/**
 * CountBadge 测试：
 * - 渲染计数文本 + data-count-badge 锚点
 * - 形状与 StatusPill 中性档逐类一致（计数点从 StatusPill tone="muted" 迁来时零视觉变化）
 * - className 透传不被吞（字号档可覆盖）
 * mock 数据全部为测试占位，无真实服务器信息
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CountBadge } from '../count-badge'
import { StatusPill } from '../status-pill'

describe('CountBadge', () => {
  it('渲染计数文本并暴露 data-count-badge 锚点', () => {
    const { container } = render(<CountBadge>已选 3</CountBadge>)
    const el = container.querySelector('[data-count-badge]') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.textContent).toBe('已选 3')
  })

  it('形状与 StatusPill 中性档逐类一致（迁移零视觉变化的契约）', () => {
    const { container } = render(
      <>
        <CountBadge>已选 3</CountBadge>
        <StatusPill tone="muted">已选 3</StatusPill>
      </>,
    )
    const badge = container.querySelector('[data-count-badge]') as HTMLElement
    const pill = container.querySelector('[data-status-pill]') as HTMLElement
    expect([...badge.classList].sort()).toEqual([...pill.classList].sort())
  })

  it('className 透传：字号档覆盖基线而计数文本与形状类保留', () => {
    const { container } = render(<CountBadge className="text-mcs-2xs">已选 3</CountBadge>)
    const el = container.querySelector('[data-count-badge]') as HTMLElement
    expect(el.classList.contains('text-mcs-2xs')).toBe(true)
    expect(el.classList.contains('text-xs')).toBe(false)
    for (const c of ['inline-flex', 'h-5', 'rounded-full', 'border-mcs-border-muted', 'bg-mcs-bg-subtle', 'text-mcs-text-muted']) {
      expect(el.classList.contains(c)).toBe(true)
    }
  })
})
