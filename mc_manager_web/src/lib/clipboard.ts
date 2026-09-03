/**
 * Clipboard 统一工具（issue 349）
 *
 * 背景：`navigator.clipboard` 仅在安全上下文（HTTPS / localhost）暴露；
 * 自托管管理面板经 HTTP + 局域网 IP 访问（服主高频场景）时该对象为 undefined，
 * 直接调用会抛同步 TypeError（server-terminal 曾因未捕获异常冒泡至 ErrorBoundary）。
 *
 * 契约：
 * - 安全上下文优先走 `navigator.clipboard.writeText`（异步 Clipboard API）
 * - clipboard 缺失或调用被拒时，降级 `document.execCommand('copy')`（隐藏 textarea）
 * - 全程不抛同步异常：任何失败都以 `false` 返回，调用方据结果给出成功反馈
 *   或可操作的手动复制引导（不再笼统「复制失败」且无兜底）
 */

/** copyText 的结果：true = 已写入剪贴板（任一路径）；false = 两条路径均失败 */
export type CopyTextResult = boolean

/** 是否存在可用的异步 Clipboard API（非安全上下文下 navigator.clipboard 为 undefined） */
function hasAsyncClipboard(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText
}

/** execCommand('copy') 降级：隐藏 textarea + 选区保存恢复；finally 保证 DOM/选区清理（异常路径不泄漏） */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  let textarea: HTMLTextAreaElement | null = null
  let previousRange: Range | null = null
  try {
    textarea = document.createElement('textarea')
    textarea.value = text
    // 防止移动端唤起键盘 / 页面滚动
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    // 保存用户既有选区（例如终端内选中的文本），复制后恢复
    const selection = document.getSelection()
    previousRange =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // 无论成功/失败（含 execCommand 同步抛异常）都清理 textarea 与选区
    textarea?.parentNode?.removeChild(textarea)
    if (previousRange) {
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(previousRange)
    }
  }
}

/**
 * 复制文本到剪贴板（统一入口，绝不抛异常）
 * @returns true = 成功写入；false = 异步 API 与 execCommand 降级均不可用，
 *          调用方应给出手动复制引导
 */
export async function copyText(text: string): Promise<CopyTextResult> {
  // 路径 1：异步 Clipboard API（安全上下文）。权限/焦点等原因被拒时继续降级
  if (hasAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fallthrough to execCommand
    }
  }
  // 路径 2：execCommand 降级（HTTP 非安全上下文 / API 被拒）
  return execCommandCopy(text)
}
