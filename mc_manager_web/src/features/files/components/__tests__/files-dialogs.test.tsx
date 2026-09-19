/**
 * RenameDialog / DeleteConfirmDialog / UploadConflictDialog / UnsavedConfirmDialog 组件测试
 * （#430 拆分交付：files 对话框群迁移后的渲染与回调接线验证）
 * 覆盖：目录/文件分支文案、路径插槽、覆盖回调携带文件、isBlocked 文案分支
 * 组件为纯受控展示件：mutation 与页面级副作用由父组件负责，此处以 spy 断言回调
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RenameDialog } from '../rename-dialog'
import { DeleteConfirmDialog } from '../delete-confirm-dialog'
import { UploadConflictDialog } from '../upload-conflict-dialog'
import { UnsavedConfirmDialog } from '../unsaved-confirm-dialog'
import type { FileEntry } from '@/api/types'

function fakeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'server.properties',
    path: '/server.properties',
    type: 'file',
    size: 1024,
    modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
    isDirectory: false,
    ...overrides,
  }
}

describe('RenameDialog（重命名对话框）', () => {
  it('渲染原名标题与目录/文件路径描述，输入受控回写', () => {
    const onValueChange = vi.fn()
    render(
      <RenameDialog
        target={fakeEntry({ name: 'banned-players.json', path: '/banned-players.json' })}
        value="whitelist.json"
        onValueChange={onValueChange}
        submitting={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('重命名 banned-players.json')).toBeInTheDocument()
    expect(screen.getByText(/文件路径：\/banned-players\.json/)).toBeInTheDocument()
    const input = screen.getByLabelText('新名称')
    expect(input).toHaveValue('whitelist.json')
    fireEvent.change(input, { target: { value: 'ops.json' } })
    expect(onValueChange).toHaveBeenCalledWith('ops.json')
  })

  it('目录目标：描述带「目录」前缀；Enter 触发 onSubmit', () => {
    const onSubmit = vi.fn()
    render(
      <RenameDialog
        target={fakeEntry({ name: 'plugins', path: '/plugins', isDirectory: true })}
        value="plugins-new"
        onValueChange={vi.fn()}
        submitting={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/目录路径：\/plugins/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('新名称'), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('DeleteConfirmDialog（删除确认对话框）', () => {
  it('文件目标：单文件删除文案 + 路径插槽展示', () => {
    const onConfirm = vi.fn()
    render(
      <DeleteConfirmDialog
        target={fakeEntry({ name: 'server.properties', path: '/server.properties' })}
        loading={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('删除 server.properties？')).toBeInTheDocument()
    expect(screen.getByText('将删除文件「server.properties」。')).toBeInTheDocument()
    expect(screen.getByTitle('/server.properties')).toBeInTheDocument()
    fireEvent.click(screen.getByText('删除'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('目录目标：递归删除红色警告文案', () => {
    render(
      <DeleteConfirmDialog
        target={fakeEntry({ name: 'world', path: '/world', isDirectory: true })}
        loading={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('删除 world？')).toBeInTheDocument()
    expect(screen.getByText('将递归删除目录「world」及其全部内容。')).toBeInTheDocument()
  })

  it('不可逆提示与确认接线', () => {
    const onConfirm = vi.fn()
    render(
      <DeleteConfirmDialog
        target={fakeEntry({ name: 'logs', path: '/logs' })}
        loading={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('此操作不可撤销')).toBeInTheDocument()
    fireEvent.click(screen.getByText('删除'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('UploadConflictDialog（上传同名冲突确认）', () => {
  it('确认覆盖：回调携带触发冲突的文件并先关闭', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const file = new File(['data'], 'server.properties')
    render(<UploadConflictDialog target={file} onConfirm={onConfirm} onClose={onClose} />)
    expect(screen.getByText('同名文件已存在')).toBeInTheDocument()
    expect(
      screen.getByText('当前目录已存在「server.properties」，上传将覆盖原文件内容。'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('覆盖'))
    expect(onConfirm).toHaveBeenCalledWith(file)
    expect(onClose).toHaveBeenCalled()
  })

  it('点击跳过：仅关闭，不触发覆盖上传', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <UploadConflictDialog
        target={new File(['data'], 'world.zip')}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('跳过'))
    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('UnsavedConfirmDialog（未保存修改放弃确认）', () => {
  it('关闭分支文案（isBlocked=false）：描述为「关闭」', () => {
    const onConfirm = vi.fn()
    render(<UnsavedConfirmDialog open isBlocked={false} onCancel={vi.fn()} onConfirm={onConfirm} />)
    expect(screen.getByText('放弃未保存的修改？')).toBeInTheDocument()
    expect(screen.getByText('当前文件有未保存的更改，关闭后将丢失这些修改。')).toBeInTheDocument()
    fireEvent.click(screen.getByText('放弃修改并离开'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('路由拦截分支文案（isBlocked=true）：描述为「离开页面」；取消走 onCancel', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<UnsavedConfirmDialog open isBlocked onCancel={onCancel} onConfirm={onConfirm} />)
    expect(
      screen.getByText('当前文件有未保存的更改，离开页面后将丢失这些修改。'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('留下'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
