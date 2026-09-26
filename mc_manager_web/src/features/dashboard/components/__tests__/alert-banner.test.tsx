/**
 * AlertBanner 单测（常驻超标告警条）
 *
 * 该横幅的存在意义是「把告警状态机算出的 activeAlerts 显示出来」——此前状态机在跑、
 * 结果却全仓无消费点（算完即丢）。断言重点是**该显的显、不该显的不显**：
 * 空集不渲染（否则页头常年挂一条废话），多档并存逐档列出，恢复后自动消失。
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AlertBanner } from '../alert-banner'
import type { AlertType } from '@/lib/notifications'

const none = new Set<AlertType>()

describe('AlertBanner', () => {
  it('无激活告警：不渲染任何内容', () => {
    const { container } = render(<AlertBanner alerts={none} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('单档激活：列出该档名，且说明「恢复后自动消失」', () => {
    render(<AlertBanner alerts={new Set<AlertType>(['lowTps'])} />)
    expect(screen.getByText(/TPS 过低/)).toBeInTheDocument()
    expect(screen.getByText(/指标恢复正常后本条自动消失/)).toBeInTheDocument()
    // 未激活的档不得出现在文案里（把没发生的告警说出来比不说更糟）
    expect(screen.queryByText(/CPU 使用率过高/)).not.toBeInTheDocument()
  })

  it('多档并存：一并列出且顺序稳定（TPS 在前——它直接决定玩家手感）', () => {
    render(<AlertBanner alerts={new Set<AlertType>(['highCpu', 'lowTps'])} />)
    const text = screen.getByText(/服务器状态异常/).textContent ?? ''
    expect(text).toContain('TPS 过低')
    expect(text).toContain('CPU 使用率过高')
    expect(text.indexOf('TPS 过低')).toBeLessThan(text.indexOf('CPU 使用率过高'))
  })

  it('告警恢复（集合清空）后横幅消失——常驻载体必须会自己撤下', () => {
    const { rerender, container } = render(<AlertBanner alerts={new Set<AlertType>(['lowTps'])} />)
    expect(container).not.toBeEmptyDOMElement()
    rerender(<AlertBanner alerts={none} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('是常驻提示而非打断式播报：role=status（非 alert）', () => {
    // 超标是持续状态，用 alert 会在每次状态机重算时打断读屏
    render(<AlertBanner alerts={new Set<AlertType>(['lowTps'])} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
