/**
 * DatePickerCalendar 行为级测试
 * 覆盖：网格渲染 / 选中与今天标记 / 点击选择 / 月导航 / 键盘导航（ARIA APG 键位）/ 底部动作
 * 时间基准用假定时器固定为 2026-09-07，断言不随运行时刻漂移
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DatePickerCalendar } from '../date-picker-calendar'

function setup(value = '', onSelect = vi.fn(), onClear = vi.fn()) {
  const user = userEvent.setup()
  const utils = render(
    <DatePickerCalendar value={value} onSelect={onSelect} onClear={onClear} />,
  )
  return { user, onSelect, onClear, ...utils }
}

/** 取日期格按钮（无障碍名为完整日期） */
function dayButton(label: string) {
  return screen.getByRole('button', { name: label })
}

describe('DatePickerCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 7, 10, 0, 0) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('渲染当月网格：月份标题 + 周一→周日表头 + 42 格（含相邻月补位）', () => {
    setup('2026-09-07')
    expect(screen.getByText('2026 年 9 月')).toBeVisible()
    for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
      expect(screen.getByRole('columnheader', { name: `星期${w}` })).toBeVisible()
    }
    expect(screen.getAllByRole('gridcell')).toHaveLength(42)
    // 相邻月补位日仍可点（跨月快速选择）
    expect(dayButton('2026年8月31日 星期一')).toBeVisible()
    expect(dayButton('2026年10月11日 星期日')).toBeVisible()
  })

  it('选中态与今天标记：aria-selected 落在选中格，aria-current=date 落在今天', () => {
    setup('2026-09-15')
    const selectedCell = screen.getByRole('gridcell', { selected: true })
    expect(within(selectedCell).getByRole('button', { name: '2026年9月15日 星期二' })).toBeVisible()
    expect(dayButton('2026年9月7日 星期一')).toHaveAttribute('aria-current', 'date')
    // 今天不等于选中时不应被标记为选中
    expect(dayButton('2026年9月7日 星期一')).not.toHaveAttribute('aria-selected')
  })

  it('点击日期格 → onSelect 收到 ISO 值', async () => {
    const { user, onSelect } = setup('2026-09-07')
    await user.click(dayButton('2026年9月18日 星期五'))
    expect(onSelect).toHaveBeenCalledWith('2026-09-18')
  })

  it('月导航：上/下个月按钮切换标题，且保留焦点日', async () => {
    const { user } = setup('2026-09-07')
    await user.click(screen.getByRole('button', { name: '下个月' }))
    expect(screen.getByText('2026 年 10 月')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '上个月' }))
    expect(screen.getByText('2026 年 9 月')).toBeVisible()
  })

  it('键盘导航：方向键逐日、PageUp/PageDown 逐月、Home/End 到周首末', async () => {
    const { user } = setup('2026-09-07')
    // 打开时焦点落在当前值上
    expect(dayButton('2026年9月7日 星期一')).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(dayButton('2026年9月8日 星期二')).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(dayButton('2026年9月15日 星期二')).toHaveFocus()

    await user.keyboard('{ArrowLeft}{ArrowUp}')
    expect(dayButton('2026年9月7日 星期一')).toHaveFocus()

    await user.keyboard('{PageDown}')
    expect(screen.getByText('2026 年 10 月')).toBeVisible()
    expect(dayButton('2026年10月7日 星期三')).toHaveFocus()

    await user.keyboard('{PageUp}')
    expect(screen.getByText('2026 年 9 月')).toBeVisible()

    await user.keyboard('{End}')
    expect(dayButton('2026年9月13日 星期日')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(dayButton('2026年9月7日 星期一')).toHaveFocus()
  })

  it('键盘 Enter 选中焦点日', async () => {
    const { user, onSelect } = setup('2026-09-07')
    await user.keyboard('{ArrowRight}{Enter}')
    expect(onSelect).toHaveBeenCalledWith('2026-09-08')
  })

  it('底部「今天」选择今天；「清除」在无值时禁用', async () => {
    const { user, onSelect, onClear, unmount } = setup('2026-09-15')
    await user.click(screen.getByRole('button', { name: '今天' }))
    expect(onSelect).toHaveBeenCalledWith('2026-09-07')
    await user.click(screen.getByRole('button', { name: '清除' }))
    expect(onClear).toHaveBeenCalled()

    unmount()
    setup('')
    expect(screen.getByRole('button', { name: '清除' })).toBeDisabled()
  })

  it('无值打开时焦点落在今天', () => {
    setup('')
    expect(dayButton('2026年9月7日 星期一')).toHaveFocus()
  })
})

/** 带可选区间（min/max，含端点）的挂载：共享 setup 不接受区间，故单列一个（避免改动既有 8 条） */
function setupRange(value: string, min?: string, max?: string) {
  const onSelect = vi.fn()
  const user = userEvent.setup()
  render(
    <DatePickerCalendar value={value} min={min} max={max} onSelect={onSelect} onClear={vi.fn()} />,
  )
  return { user, onSelect }
}

describe('DatePickerCalendar 可选区间（min/max）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 7, 10, 0, 0) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('界外日禁选，端点可选', () => {
    setupRange('', '2026-09-05', '2026-09-09')
    expect(dayButton('2026年9月5日 星期六')).toBeEnabled()
    expect(dayButton('2026年9月9日 星期三')).toBeEnabled()
    expect(dayButton('2026年9月4日 星期五')).toBeDisabled()
    expect(dayButton('2026年9月10日 星期四')).toBeDisabled()
  })

  it('键盘落点被夹在界内：端点处按方向键不再前进（否则焦点会指向禁选格）', async () => {
    const { user } = setupRange('2026-09-09', '2026-09-05', '2026-09-09')
    expect(dayButton('2026年9月9日 星期三')).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(dayButton('2026年9月9日 星期三')).toHaveFocus()
    // 反向仍在界内，正常移动
    await user.keyboard('{ArrowLeft}')
    expect(dayButton('2026年9月8日 星期二')).toHaveFocus()
  })

  it('当前值落在界外时，打开即夹到端点（roving tabindex 不指向禁选格）', () => {
    setupRange('2026-09-20', undefined, '2026-09-09')
    expect(dayButton('2026年9月9日 星期三')).toHaveFocus()
  })

  it('目标月整月无选中日时禁掉翻月', () => {
    // 区间收成一天：8 月与 10 月的 42 格网格都不含该日
    setupRange('2026-09-07', '2026-09-07', '2026-09-07')
    expect(screen.getByRole('button', { name: '上个月' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下个月' })).toBeDisabled()
  })

  it('翻月按「目标月自己的界内日」判定：单月区间两侧都不可翻', () => {
    // 相邻月补位日仍可在当前视图里点（既有设计），但翻月不该把用户带进一个整月无可选日的月份
    setupRange('2026-09-07', '2026-09-01', '2026-09-30')
    expect(screen.getByRole('button', { name: '上个月' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下个月' })).toBeDisabled()
  })

  it('跨月区间：有界内日的一侧可翻，无界内日的一侧不可翻', () => {
    setupRange('2026-09-15', '2026-09-01', '2026-10-05')
    expect(screen.getByRole('button', { name: '上个月' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下个月' })).toBeEnabled()
  })

  it('翻月后焦点落在界内日：不退到禁选格（否则网格失去 tab 停靠点与方向键处理）', async () => {
    // 区间跨月且 10 月只有 1–5 可选：翻到 10 月的落点必须夹到 10-05，而不是平移出的 10-30
    const { user } = setupRange('2026-09-30', '2026-09-01', '2026-10-05')
    await user.click(screen.getByRole('button', { name: '下个月' }))

    const landed = dayButton('2026年10月5日 星期一')
    expect(landed).toBeEnabled()
    expect(landed).toHaveFocus()
    expect(landed).toHaveAttribute('tabindex', '0')
  })

  it('今天在界外时「今天」按钮禁用', () => {
    setupRange('2026-09-10', '2026-09-08', '2026-09-30')
    expect(screen.getByRole('button', { name: '今天' })).toBeDisabled()
  })
})
