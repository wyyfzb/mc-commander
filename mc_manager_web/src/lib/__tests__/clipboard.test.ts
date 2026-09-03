/**
 * lib/clipboard 统一工具单测（issue #349）
 * 覆盖：
 * - 安全上下文：异步 Clipboard API 成功（不触碰 execCommand 降级）
 * - 非安全上下文：clipboard 缺失 → execCommand('copy') 兜底成功
 * - API 被拒（权限/焦点）：writeText reject → execCommand 兜底
 * - 双路径均失败：clipboard 缺失 + execCommand 抛异常/返回 false → 返回 false 且不抛
 * - 降级细节：隐藏 textarea 创建并清理、既有选区保存恢复
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../clipboard'

/** jsdom 的 navigator 上动态定义/覆盖 clipboard 属性（各分支模拟） */
function setClipboard(value: unknown) {
  Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true })
}

describe('lib/clipboard copyText（issue #349）', () => {
  let execCommandMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    execCommandMock = vi.fn()
    // jsdom 未实现 execCommand：挂上可替身的实现，destroy 时卸载
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).execCommand
    // 恢复为 undefined（jsdom 默认无 clipboard），避免泄漏到其他测试文件
    setClipboard(undefined)
    vi.restoreAllMocks()
  })

  it('路径 1：安全上下文 clipboard.writeText 成功 → true，且不走 execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    execCommandMock.mockReturnValue(true)

    await expect(copyText('give @p diamond 64')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('give @p diamond 64')
    expect(execCommandMock).not.toHaveBeenCalled()
  })

  it('路径 2：非安全上下文 clipboard 缺失 → execCommand 兜底成功', async () => {
    setClipboard(undefined)
    execCommandMock.mockReturnValue(true)

    await expect(copyText('/time set day')).resolves.toBe(true)
    expect(execCommandMock).toHaveBeenCalledWith('copy')
    // 隐藏 textarea 已清理（无残留）
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('路径 2b：clipboard.writeText 被拒（权限）→ 降级 execCommand 兜底成功', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('NotAllowedError'))
    setClipboard({ writeText })
    execCommandMock.mockReturnValue(true)

    await expect(copyText('stop')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledOnce()
    expect(execCommandMock).toHaveBeenCalledWith('copy')
  })

  it('路径 3：双路径均失败（clipboard 缺失 + execCommand 返回 false）→ false 且不抛', async () => {
    setClipboard(undefined)
    execCommandMock.mockReturnValue(false)

    await expect(copyText('anything')).resolves.toBe(false)
  })

  it('路径 3b：双路径均失败（execCommand 同步抛异常）→ false 且不抛（消灭同步异常冒泡）', async () => {
    setClipboard(undefined)
    execCommandMock.mockImplementation(() => {
      throw new TypeError('execCommand is not a function')
    })

    await expect(copyText('anything')).resolves.toBe(false)
    // 异常路径下 textarea 同样被清理
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('降级细节：textarea 只读 + 视口外定位 + 既有选区复制后恢复', async () => {
    setClipboard(undefined)
    execCommandMock.mockReturnValue(true)

    // 造一个既有选区（模拟终端选中态）
    const pre = document.createElement('div')
    pre.textContent = '用户已选中的文本'
    document.body.appendChild(pre)
    const range = document.createRange()
    range.selectNodeContents(pre)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    await expect(copyText('echo hello')).resolves.toBe(true)

    // 既有选区恢复（rangeCount 回到 1，不再指向 textarea）
    expect(document.getSelection()?.rangeCount).toBe(1)
    expect(document.getSelection()?.toString()).toBe('用户已选中的文本')
    pre.remove()
  })
})
