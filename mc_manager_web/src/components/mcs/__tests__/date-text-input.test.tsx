/**
 * DateTextInput —— ISO 日期文本输入（替代原生 date 控件的中文混排）
 * normalizeDateDigits 分段/补零；isCompleteIsoDate 日历有效性；
 * 组件交互：完整值上抛、输入中不上抛、清空上抛 ''、失焦回退不完整草稿
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTextInput, normalizeDateDigits, isCompleteIsoDate } from '../date-text-input'

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
      const { unmount } = render(<DateTextInput value="" onChange={onChange} ariaLabel="逐位日期" />)
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
})
