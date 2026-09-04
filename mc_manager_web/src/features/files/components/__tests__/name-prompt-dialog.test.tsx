/**
 * NamePromptDialog 组件测试（#430 拆分交付：新建文件/新建目录共用表单对话框）
 * 覆盖：受控渲染（标题/描述/值）/ 输入受控回写 / Enter 直提交 / 取消走 onOpenChange(false)
 * 组件为纯受控展示件：校验与 mutation 均由父组件负责，此处以 spy 断言回调接线
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NamePromptDialog } from '../name-prompt-dialog'

function setup(overrides: Partial<Parameters<typeof NamePromptDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    title: '新建文件',
    description: '将在「/」目录下创建空文件。',
    inputLabel: '文件名',
    placeholder: '文件名，如 example.txt',
    value: '',
    onValueChange: vi.fn(),
    submitting: false,
    onSubmit: vi.fn(),
    ...overrides,
  }
  render(<NamePromptDialog {...props} />)
  return props
}

describe('NamePromptDialog（新建文件/新建目录共用）', () => {
  it('受控渲染：标题/描述/输入值/aria-label 按 props 呈现', () => {
    setup({ value: 'server.properties' })
    expect(screen.getByText('新建文件')).toBeInTheDocument()
    expect(screen.getByText('将在「/」目录下创建空文件。')).toBeInTheDocument()
    const input = screen.getByLabelText('文件名')
    expect(input).toHaveValue('server.properties')
    expect(screen.getByPlaceholderText('文件名，如 example.txt')).toBeInTheDocument()
  })

  it('输入回写：onChange 透传新值给 onValueChange（受控边界在父组件）', () => {
    const props = setup()
    fireEvent.change(screen.getByLabelText('文件名'), { target: { value: 'banned-players.txt' } })
    expect(props.onValueChange).toHaveBeenCalledWith('banned-players.txt')
  })

  it('Enter 直提交：输入框回车触发 onSubmit', () => {
    const props = setup({ value: 'ops.json' })
    fireEvent.keyDown(screen.getByLabelText('文件名'), { key: 'Enter' })
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('取消按钮：走 onOpenChange(false) 关闭（清空与否由父组件决定，与原实现一致）', () => {
    const props = setup()
    fireEvent.click(screen.getByText('取消'))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(props.onSubmit).not.toHaveBeenCalled()
  })
})
