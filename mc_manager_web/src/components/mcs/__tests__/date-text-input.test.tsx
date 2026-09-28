/**
 * DateTextInput —— ISO 日期文本输入（替代原生 date 控件的中文混排）
 * normalizeDateDigits 分段/补零；isCompleteIsoDate 日历有效性；
 * 组件交互：完整值上抛、输入中不上抛、清空上抛 ''、失焦回退不完整草稿
 */
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTextInput, normalizeDateDigits, isCompleteIsoDate } from '../date-text-input'
import { dayLabel, todayIso } from '@/lib/mc-calendar'

describe('normalizeDateDigits', () => {
  it('空 → 空串', () => {
    expect(normalizeDateDigits('')).toBe('')
  })
  it('按位分段：年 → 年-月 → 年-月-日（月/日补零）', () => {
    expect(normalizeDateDigits('2026')).toBe('2026')
    expect(normalizeDateDigits('20269')).toBe('2026-09')
    expect(normalizeDateDigits('202609')).toBe('2026-09')
    expect(normalizeDateDigits('202697')).toBe('2026-09-07')
    expect(normalizeDateDigits('2026-09-07')).toBe('2026-09-07')
  })
  it('超 8 位截断', () => {
    expect(normalizeDateDigits('20260907123')).toBe('2026-09-07')
  })
})

describe('isCompleteIsoDate', () => {
  it('完整且日历有效', () => {
    expect(isCompleteIsoDate('2026-09-07')).toBe(true)
    expect(isCompleteIsoDate('2026-12-31')).toBe(true)
  })
  it('格式不全或日历非法（闰年/越界月）', () => {
    expect(isCompleteIsoDate('2026-09')).toBe(false)
    expect(isCompleteIsoDate('2026-09-0')).toBe(false)
    expect(isCompleteIsoDate('2026-13-01')).toBe(false)
    expect(isCompleteIsoDate('2026-02-31')).toBe(false)
    expect(isCompleteIsoDate('2024-02-29')).toBe(true)
  })
})

describe('DateTextInput 交互', () => {
  it('完整输入 ISO 日期 → onChange 上抛', () => {
    const onChange = vi.fn()
    render(<DateTextInput value="" onChange={onChange} ariaLabel="开始日期" />)
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-02-10' } })
    expect(onChange).toHaveBeenCalledWith('2026-02-10')
  })

  it('输入不完整（分段中）→ 不上抛，仅草稿显示', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<DateTextInput value="" onChange={onChange} ariaLabel="开始日期" />)
    const input = screen.getByLabelText('开始日期')
    await user.type(input, '2026-0')
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('2026-00')
  })

  it('清空 → 上抛空串', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<DateTextInput value="2026-01-01" onChange={onChange} ariaLabel="结束日期" />)
    const input = screen.getByLabelText('结束日期')
    await user.clear(input)
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('失焦时草稿不完整 → 不上抛新值，显示回退到已提交值', () => {
    const onChange = vi.fn()
    render(<DateTextInput value="2026-01-01" onChange={onChange} ariaLabel="开始日期" />)
    const input = screen.getByLabelText('开始日期')
    // 删除末位得到不完整草稿（数字重排为 2026-01-00，日历非法）
    fireEvent.change(input, { target: { value: '2026-01-0' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(input).toHaveValue('2026-01-01')
  })

  it('逐位键入两位月份与两位日期 → 分段正确且只上抛一次（回归：补零显示曾被当成用户输入）', async () => {
    const cases = [
      ['20261007', '2026-10-07'],
      ['20260917', '2026-09-17'],
      ['20261231', '2026-12-31'],
      ['20260101', '2026-01-01'],
    ] as const
    for (const [typed, expected] of cases) {
      const onChange = vi.fn()
      const user = userEvent.setup()
      const { unmount } = render(
        <DateTextInput value="" onChange={onChange} ariaLabel="逐位日期" />,
      )
      await user.type(screen.getByLabelText('逐位日期'), typed)
      expect(onChange).toHaveBeenLastCalledWith(expected)
      expect(onChange).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('末位日期只键入一位时先不上抛，失焦补零后上抛', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<DateTextInput value="" onChange={onChange} ariaLabel="起始日期" />)
    const input = screen.getByLabelText('起始日期')
    await user.type(input, '2026091')
    expect(input).toHaveValue('2026-09-01')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('2026-09-01')
  })

  it('日历弹层：打开后选日上抛 ISO 并收起，触发器 aria-expanded 跟随开合', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<DateTextInput value="" onChange={onChange} ariaLabel="开始日期" />)
    const trigger = screen.getByRole('button', { name: '打开日历' })
    expect(screen.queryByRole('grid')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('grid')).toBeVisible()

    await user.click(screen.getByRole('button', { name: dayLabel(todayIso()) }))
    expect(onChange).toHaveBeenCalledWith(todayIso())
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('日历弹层：已提交值高亮为选中格，清除上抛空串', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<DateTextInput value="2026-09-15" onChange={onChange} ariaLabel="结束日期" />)
    await user.click(screen.getByRole('button', { name: '打开日历' }))
    const cell = screen.getByRole('gridcell', { selected: true })
    expect(within(cell).getByRole('button', { name: '2026年9月15日 星期二' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '清除' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('日历选中后草稿让位：受控父级更新值后输入框显示所选日期', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [v, setV] = useState('')
      return <DateTextInput value={v} onChange={setV} ariaLabel="开始日期" />
    }
    render(<Harness />)
    const input = screen.getByLabelText('开始日期')
    // 先键入一段不完整草稿，再从日历选日 → 草稿必须让位于所选值
    await user.type(input, '2026')
    expect(input).toHaveValue('2026')
    await user.click(screen.getByRole('button', { name: '打开日历' }))
    await user.click(screen.getByRole('button', { name: dayLabel(todayIso()) }))
    expect(input).toHaveValue(todayIso())
  })

  it('全选替换：粘贴更短/更长串都以新内容为准，不残留旧值片段（回归）', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [v, setV] = useState('2026-09-15')
      return <DateTextInput value={v} onChange={setV} ariaLabel="开始日期" />
    }
    render(<Harness />)
    const input = screen.getByLabelText('开始日期')

    // 更短：旧实现按长度判「末端删除」，会留下旧值前缀 2026
    await user.click(input)
    await user.keyboard('{Control>}a{/Control}')
    await user.paste('2025')
    expect(input).toHaveValue('2025')

    // 更长：旧实现按长度判「末端追加」，会把新串尾巴接在旧值后面（2024-01）
    await user.keyboard('{Control>}a{/Control}')
    await user.paste('2025-01')
    expect(input).toHaveValue('2025-01')

    // 整串替换为另一完整日期
    await user.keyboard('{Control>}a{/Control}')
    await user.paste('2024-12-31')
    expect(input).toHaveValue('2024-12-31')
  })

  it('错误态只落在「输满 8 位但日历非法」：键入中途不标红', async () => {
    const user = userEvent.setup()
    render(<DateTextInput value="" onChange={vi.fn()} ariaLabel="开始日期" />)
    const input = screen.getByLabelText('开始日期')

    await user.type(input, '2026')
    expect(input).not.toHaveAttribute('aria-invalid')

    // 补到 8 位但日历非法（2 月 31 日）→ 标红
    await user.type(input, '0231')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('有值时输入框呈激活态（与 FilterSelect 一致），触发器带 aria-haspopup', () => {
    render(<DateTextInput value="2026-09-15" onChange={vi.fn()} ariaLabel="开始日期" />)
    const input = screen.getByLabelText('开始日期')
    const classes = input.className.split(/\s+/)
    // 边界用强档 accent：弱档 accent-border 亮色仅 1.10:1、暗色 1.69:1，低于交互边界 ≥3:1
    expect(classes).toContain('bg-mcs-accent-bg-subtle')
    expect(classes).toContain('border-mcs-accent-border-strong')
    expect(classes).not.toContain('border-mcs-accent-border')
    expect(screen.getByRole('button', { name: '打开日历' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    )
  })
})

describe('DateTextInput 可选区间（min/max）', () => {
  it('区间透传给日历弹层（不拦键入：无效组合由页面级告警解释）', async () => {
    // 日历以「今天」开月，故固定时间基准，避免断言随运行时刻漂移
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 7, 10, 0, 0) })
    try {
      const user = userEvent.setup()
      render(
        <DateTextInput
          value=""
          onChange={vi.fn()}
          min="2026-09-05"
          max="2026-09-09"
          ariaLabel="结束日期"
        />,
      )
      await user.click(screen.getByRole('button', { name: '打开日历' }))
      expect(screen.getByRole('button', { name: dayLabel('2026-09-05') })).toBeEnabled()
      expect(screen.getByRole('button', { name: dayLabel('2026-09-04') })).toBeDisabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('键入越界值照常上抛：区间不是键入层的闸门（倒置防护在页面级）', () => {
    const onChange = vi.fn()
    render(<DateTextInput value="" onChange={onChange} max="2026-09-12" ariaLabel="开始日期" />)
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-20' } })
    expect(onChange).toHaveBeenCalledWith('2026-09-20')
  })
})
