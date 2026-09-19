import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SearchInput } from '../search-input'

describe('SearchInput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染搜索图标和输入框', () => {
    render(<SearchInput value="" onValueChange={() => {}} placeholder="搜索…" aria-label="搜索" />)
    const input = screen.getByPlaceholderText('搜索…')
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-label', '搜索')
  })

  it('输入时调用 onValueChange', () => {
    const onChange = vi.fn()
    render(<SearchInput value="" onValueChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  it('有值时显示清除按钮，点击清空', () => {
    const onChange = vi.fn()
    render(<SearchInput value="test" onValueChange={onChange} />)
    const clearBtn = screen.getByRole('button', { name: '清空搜索' })
    expect(clearBtn).toBeInTheDocument()
    fireEvent.click(clearBtn)
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('无值时隐藏清除按钮', () => {
    render(<SearchInput value="" onValueChange={() => {}} />)
    expect(screen.queryByRole('button', { name: '清空搜索' })).not.toBeInTheDocument()
  })

  it('clearable=false 不显示清除按钮', () => {
    render(<SearchInput value="test" onValueChange={() => {}} clearable={false} />)
    expect(screen.queryByRole('button', { name: '清空搜索' })).not.toBeInTheDocument()
  })

  it('debounce: 输入后按延迟调用 onDebouncedChange', () => {
    const onDebounced = vi.fn()
    render(
      <SearchInput
        value=""
        onValueChange={() => {}}
        debounceMs={300}
        onDebouncedChange={onDebounced}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    expect(onDebounced).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onDebounced).toHaveBeenCalledWith('hello')
  })

  it('debounce: 连续输入只触发最后一次', () => {
    const onDebounced = vi.fn()
    render(
      <SearchInput
        value=""
        onValueChange={() => {}}
        debounceMs={300}
        onDebouncedChange={onDebounced}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ab' } })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onDebounced).toHaveBeenCalledTimes(1)
    expect(onDebounced).toHaveBeenCalledWith('abc')
  })

  it('debounce: 清除时立即触发 onDebouncedChange(空串)', () => {
    const onDebounced = vi.fn()
    render(
      <SearchInput
        value="x"
        onValueChange={() => {}}
        debounceMs={300}
        onDebouncedChange={onDebounced}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(onDebounced).toHaveBeenCalledWith('')
  })

  it('size=sm 应用紧凑样式', () => {
    const { container } = render(<SearchInput value="" onValueChange={() => {}} size="sm" />)
    const input = container.querySelector('input')!
    expect(input.className).toContain('h-7')
    expect(input.className).toContain('text-mcs-xs')
  })

  it('支持 testId', () => {
    render(<SearchInput value="" onValueChange={() => {}} testId="my-search" />)
    expect(screen.getByTestId('my-search')).toBeInTheDocument()
  })
})
