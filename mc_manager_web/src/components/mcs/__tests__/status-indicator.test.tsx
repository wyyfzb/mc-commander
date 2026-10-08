import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusIndicator, type IndicatorStatus } from '../status-indicator'

/**
 * StatusIndicator 文案与脉冲（状态三重编码里的「文字」通道）
 * 重点钉住降级档的措辞：它只能说「推送断了」——说「延迟刷新」会在面板整体不可达时被现场推翻
 */
describe('StatusIndicator', () => {
  it('降级档只说可确知的事实：实时推送已断（不承诺轮询在刷新）', () => {
    const { container } = render(<StatusIndicator status="degraded" />)
    expect(screen.getByText('实时推送已断')).toBeInTheDocument()
    expect(container.textContent).not.toContain('延迟刷新')
    // 降级不呼吸：脉冲只给连接中与异常
    expect(container.querySelector('.animate-ping')).toBeNull()
  })

  it('脉冲状态（连接中 / 异常）带涟漪，且涟漪与圆点同色（状态色 token）', () => {
    for (const status of ['connecting', 'warning'] as IndicatorStatus[]) {
      const { container, unmount } = render(<StatusIndicator status={status} />)
      expect(container.querySelector('.animate-ping')).not.toBeNull()
      expect(container.querySelector('[data-status]')).toHaveAttribute('data-status', status)
      unmount()
    }
  })

  it('已连接 / 未连接不带涟漪', () => {
    for (const status of ['connected', 'disconnected'] as IndicatorStatus[]) {
      const { container, unmount } = render(<StatusIndicator status={status} />)
      expect(container.querySelector('.animate-ping')).toBeNull()
      unmount()
    }
  })

  it('suffix 追加在状态文字之后：可见的只有短语，完整解释走 title 与 sr-only', () => {
    render(
      <StatusIndicator
        status="connected"
        suffix="实时更新"
        suffixDescription="实时推送已连通，服务器的状态变化会立即到达面板"
      />,
    )

    const el = screen.getByText('已连接 · 实时更新')
    // 句子不进可见文本（整句会把顶栏撑成一段说明），但要真的可达：
    // title 供指针悬停；aria-label 在 span（role=generic）上按规范被忽略——实测 Chromium
    // 无障碍树只取到可见文本，故改挂 sr-only
    expect(el).toHaveAttribute('title', '实时推送已连通，服务器的状态变化会立即到达面板')
    expect(el.querySelector('.sr-only')?.textContent).toBe(
      '，实时推送已连通，服务器的状态变化会立即到达面板',
    )
    expect(el).toHaveClass('text-mcs-xs')
  })

  it('不给 suffix 时文本与属性都不多一个字（调用点不必都写一句说明）', () => {
    const { container } = render(<StatusIndicator status="connected" />)

    expect(container.textContent).toBe('已连接')
    expect(container.querySelector('[data-status]')).not.toHaveAttribute('title')
    expect(container.querySelector('[data-status]')).not.toHaveAttribute('aria-label')
    expect(container.querySelector('.sr-only')).toBeNull()
  })
})
