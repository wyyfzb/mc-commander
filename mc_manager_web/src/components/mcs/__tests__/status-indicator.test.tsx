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
})
