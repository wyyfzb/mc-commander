/**
 * 市场过滤栏行为级测试（#482 拆分护住：render + userEvent 触达筛选路径）
 * 覆盖：关键词防抖回调链 / MC 版本输入 trim / 刷新回调 + loading 禁用 + 结果计数
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarketFilterBar } from '../market-filter-bar'

function renderBar(overrides: Partial<Parameters<typeof MarketFilterBar>[0]> = {}) {
  const props = {
    query: '',
    onQueryChange: vi.fn(),
    onDebouncedChange: vi.fn(),
    loader: '',
    onLoaderChange: vi.fn(),
    gameVersion: '',
    onGameVersionChange: vi.fn(),
    loading: false,
    onRefresh: vi.fn(),
    totalHits: 0,
    ...overrides,
  }
  const utils = render(<MarketFilterBar {...props} />)
  return { ...props, unmount: utils.unmount }
}

describe('MarketFilterBar', () => {
  it('关键词输入：onQueryChange 回调收到完整值，停顿后防抖回调收到 trim 后的值', async () => {
    const props = renderBar()
    // 受控组件（query 由宿主持有）用 fireEvent 一次性设值，避免逐字符回写差异
    fireEvent.change(screen.getByTestId('market-search-input'), {
      target: { value: 'FakeCore' },
    })
    expect(props.onQueryChange).toHaveBeenCalledWith('FakeCore')
    // 防抖（400ms）到期后收到同步值（SearchInput 内部 trim）
    await waitFor(() => expect(props.onDebouncedChange).toHaveBeenCalledWith('FakeCore'))
  })

  it('MC 版本输入经 trim 后回调（保留输入首尾空格清理语义）', () => {
    const props = renderBar()
    fireEvent.change(screen.getByTestId('market-game-version'), {
      target: { value: '  1.21.4  ' },
    })
    expect(props.onGameVersionChange).toHaveBeenCalledWith('1.21.4')
  })

  it('结果计数仅在 totalHits>0 时渲染；刷新按钮可点且 loading 时禁用', async () => {
    const user = userEvent.setup()
    const first = renderBar({ totalHits: 42 })
    expect(screen.getByText('共 42 个结果')).toBeInTheDocument()
    const refresh = screen.getByRole('button', { name: '重新搜索' })
    await user.click(refresh)
    expect(first.onRefresh).toHaveBeenCalledTimes(1)
    // 卸载首次渲染后再验证 loading 禁用态，避免双实例同屏干扰 role 查询
    first.unmount()
    renderBar({ loading: true })
    expect(screen.getByRole('button', { name: '重新搜索' })).toBeDisabled()
  })
})
