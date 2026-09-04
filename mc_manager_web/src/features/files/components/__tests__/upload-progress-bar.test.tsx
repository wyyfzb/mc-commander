/**
 * UploadProgressBar 组件测试（#430 拆分交付：上传进度条迁移后的渲染与 ARIA 验证）
 * 覆盖：名称/百分比渲染 / progressbar ARIA 三元组（label/min/max/valuenow）/ 取消回调接线
 * 与既有 page 级测试（files-page-upload-progress.test.tsx）的 ARIA 断言口径一致
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UploadProgressBar } from '../upload-progress-bar'

describe('UploadProgressBar（文件上传进度条）', () => {
  it('渲染上传中名称与百分比（title 悬浮全名 + truncat 展示）', () => {
    render(<UploadProgressBar uploading={{ name: '示例整合包.zip', pct: 42 }} onCancel={vi.fn()} />)
    expect(screen.getByTestId('upload-progress')).toBeInTheDocument()
    expect(screen.getByText('正在上传 示例整合包.zip')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByTitle('示例整合包.zip')).toBeInTheDocument()
  })

  it('progressbar ARIA 三元组齐全：label/min/max + valuenow 实时值', () => {
    render(<UploadProgressBar uploading={{ name: 'world.zip', pct: 7 }} onCancel={vi.fn()} />)
    const bar = screen.getByRole('progressbar', { name: '文件上传进度' })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuenow', '7')
  })

  it('取消按钮：data-testid=upload-cancel（与 page 级测试选择器一致）点击触发 onCancel', () => {
    const onCancel = vi.fn()
    render(<UploadProgressBar uploading={{ name: '大地图.tar.gz', pct: 90 }} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('upload-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
