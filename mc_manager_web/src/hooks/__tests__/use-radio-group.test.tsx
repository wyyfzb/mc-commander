/**
 * useRadioGroup 接线层测试：roving tabindex、方向键移动即选中 + 焦点跟随、无选中态的停靠点、
 * 无关按键放行（Tab 不被吞）。键盘模型本体（回绕/Home/End）在 lib/radio-group.test.ts 覆盖，
 * 这里验「模型接到了 DOM 上」。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { useRadioGroup } from '../use-radio-group'

const OPTIONS = ['day', 'week', 'month'] as const
const LABELS: Record<string, string> = { day: '今天', week: '本周', month: '本月' }

/** 受控宿主：模拟真实调用方（外部 state + onChange） */
function Host({ initial = null as (typeof OPTIONS)[number] | null, onChange = vi.fn() }) {
  const [value, setValue] = useState<(typeof OPTIONS)[number] | null>(initial)
  const { groupProps, itemProps } = useRadioGroup({
    label: '时间范围',
    value,
    values: OPTIONS,
    onChange: (v) => {
      setValue(v)
      onChange(v)
    },
  })
  return (
    <div {...groupProps}>
      {OPTIONS.map((o, i) => (
        <button key={o} type="button" {...itemProps(i)}>
          {LABELS[o]}
        </button>
      ))}
    </div>
  )
}

describe('useRadioGroup', () => {
  it('组语义：容器是 radiogroup 且带可访问名，项是 radio 且只有选中项 aria-checked', () => {
    render(<Host initial="week" />)
    expect(screen.getByRole('radiogroup', { name: '时间范围' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '本周' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '今天' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: '本月' })).toHaveAttribute('aria-checked', 'false')
  })

  it('roving tabindex：只有选中项可 Tab 进入', () => {
    render(<Host initial="week" />)
    expect(screen.getByRole('radio', { name: '今天' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('radio', { name: '本周' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: '本月' })).toHaveAttribute('tabindex', '-1')
  })

  it('无选中（value=null）：全项 aria-checked=false，但停靠点落首项（组不能被 Tab 跳过）', () => {
    render(<Host initial={null} />)
    for (const label of Object.values(LABELS)) {
      expect(screen.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'false')
    }
    expect(screen.getByRole('radio', { name: '今天' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: '本周' })).toHaveAttribute('tabindex', '-1')
  })

  it('方向键：移动即选中且焦点跟随（从选中项出发）', () => {
    const onChange = vi.fn()
    render(<Host initial="day" onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: '时间范围' })
    const week = screen.getByRole('radio', { name: '本周' })

    fireEvent.keyDown(group, { key: 'ArrowRight' })

    expect(onChange).toHaveBeenCalledWith('week')
    expect(week).toHaveAttribute('aria-checked', 'true')
    expect(week).toHaveAttribute('tabindex', '0')
    expect(document.activeElement).toBe(week)
  })

  it('方向键回绕：末项继续前进回到首项', () => {
    const onChange = vi.fn()
    render(<Host initial="month" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '时间范围' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('day')
    expect(screen.getByRole('radio', { name: '今天' })).toHaveAttribute('aria-checked', 'true')
  })

  it('无选中态下第一次方向键落在首项（APG：未选中则焦点落在第一个）', () => {
    const onChange = vi.fn()
    render(<Host initial={null} onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: '时间范围' })
    const today = screen.getByRole('radio', { name: '今天' })

    fireEvent.keyDown(group, { key: 'ArrowRight' })

    expect(onChange).toHaveBeenCalledWith('day')
    expect(today).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(today)
  })

  it('无选中态下反向方向键同样落在首项，Home/End 的绝对落点不受影响', () => {
    const onChange = vi.fn()
    const { unmount } = render(<Host initial={null} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '时间范围' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('day')
    unmount()

    // End 是绝对落点：无选中时仍直接到末项（归一不得扩大成「一切键都落首项」）
    const onEndChange = vi.fn()
    render(<Host initial={null} onChange={onEndChange} />)
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '时间范围' }), { key: 'End' })
    expect(onEndChange).toHaveBeenLastCalledWith('month')
  })

  it('无关按键放行：Tab 不选中、也不被 preventDefault（键盘用户不会被困在组里）', () => {
    const onChange = vi.fn()
    render(<Host initial="day" onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: '时间范围' })
    // fireEvent 返回 false 表示默认行为被阻止
    const notPrevented = fireEvent.keyDown(group, { key: 'Tab' })
    expect(notPrevented).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })
})
