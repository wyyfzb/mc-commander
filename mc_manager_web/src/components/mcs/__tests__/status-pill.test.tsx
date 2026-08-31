/**
 * StatusPill 测试：
 * - status 变体：tone 三元组 token 类（border/bg-subtle/fg）
 * - outline 变体：仅 border + fg，无 bg-subtle
 * - data-status-pill / data-status-tone / data-status-variant 属性
 * - 默认 tone=default，默认 variant=status
 * mock 数据全部为测试占位，无真实服务器信息
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { StatusPill } from '../status-pill'

describe('StatusPill', () => {
  it('status 变体：warning tone 输出 --mcs-*-border/bg-subtle/fg 三元组 token 类', () => {
    const { container } = render(<StatusPill tone="warning">普通</StatusPill>)
    const el = container.querySelector('[data-status-pill]') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.dataset.statusTone).toBe('warning')
    expect(el.dataset.statusVariant).toBe('status')
    expect(el.classList.contains('text-mcs-warning-fg')).toBe(true)
    expect(el.classList.contains('bg-mcs-warning-bg-subtle')).toBe(true)
    expect(el.classList.contains('border-mcs-warning-border')).toBe(true)
  })

  it('outline 变体：仅 border + fg，无 bg-subtle', () => {
    const { container } = render(<StatusPill variant="outline" tone="success">成功</StatusPill>)
    const el = container.querySelector('[data-status-pill]') as HTMLElement
    expect(el.dataset.statusVariant).toBe('outline')
    expect(el.classList.contains('text-mcs-success-fg')).toBe(true)
    expect(el.classList.contains('border-mcs-success-border')).toBe(true)
    expect(el.classList.contains('bg-mcs-success-bg-subtle')).toBe(false)
  })

  it('默认 tone=default，variant=status', () => {
    const { container } = render(<StatusPill>默认</StatusPill>)
    const el = container.querySelector('[data-status-pill]') as HTMLElement
    expect(el.dataset.statusTone).toBe('default')
    expect(el.dataset.statusVariant).toBe('status')
  })

  it('8 tone 全覆盖：default/muted/accent/success/warning/error/info/purple', () => {
    const tones = ['default', 'muted', 'accent', 'success', 'warning', 'error', 'info', 'purple'] as const
    const { container } = render(
      <>
        {tones.map((t) => (
          <StatusPill key={t} tone={t}>{t}</StatusPill>
        ))}
      </>,
    )
    const pills = container.querySelectorAll('[data-status-pill]')
    expect(pills).toHaveLength(8)
    for (let i = 0; i < tones.length; i++) {
      expect((pills[i] as HTMLElement).dataset.statusTone).toBe(tones[i])
    }
  })
})
