/**
 * InfoHint 基座契约
 * 覆盖：
 * - icon 档：入口是可聚焦按钮，可访问名＝label，点按出浮层
 * - inline 档：可见文本＝label（或被 term 覆盖），带虚线下划线记号，可访问名仍取 label
 * - **键盘路径**：Tab 落点 → Enter 打开 → Escape 关闭后焦点回到入口
 *   （这条是本组件存在的理由：此前这些解释挂在不可聚焦的 <span> + Tooltip 上，
 *   键盘与触屏完全拿不到；只测点按证明不了它被修好）
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InfoHint } from '../info-hint'

describe('InfoHint', () => {
  it('icon 档：入口是可聚焦按钮，可访问名取 label，点按出浮层正文', async () => {
    const user = userEvent.setup()
    render(<InfoHint label="连接方式">同源托管，无需填写端口</InfoHint>)

    const trigger = screen.getByRole('button', { name: '连接方式' })
    expect(trigger).toBeInTheDocument()
    await user.click(trigger)
    expect(await screen.findByText('同源托管，无需填写端口')).toBeInTheDocument()
  })

  it('inline 档：可见文本就是被解释的词，并带虚线下划线记号', async () => {
    const user = userEvent.setup()
    render(
      <InfoHint variant="inline" label="需插件">
        原版 RCON 不暴露玩家 ping
      </InfoHint>,
    )

    const trigger = screen.getByRole('button', { name: '需插件' })
    expect(trigger).toHaveTextContent('需插件')
    expect(trigger.className).toContain('decoration-dashed')
    await user.click(trigger)
    expect(await screen.findByText('原版 RCON 不暴露玩家 ping')).toBeInTheDocument()
  })

  it('inline 档 term：可见内容换成徽标，可访问名仍是 label', () => {
    render(
      <InfoHint variant="inline" label="失败原因" term={<span>失败</span>}>
        超时
      </InfoHint>,
    )
    const trigger = screen.getByRole('button', { name: '失败原因' })
    expect(trigger).toHaveTextContent('失败')
  })

  it('键盘全程可完成：Tab 落点 → Enter 打开 → Escape 关闭且焦点回到入口', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <button type="button">前一个控件</button>
        <InfoHint variant="inline" label="需插件">
          原版 RCON 不暴露玩家 ping
        </InfoHint>
      </div>,
    )

    await user.tab()
    expect(screen.getByRole('button', { name: '前一个控件' })).toHaveFocus()

    // 关键一步：解释的入口必须能靠 Tab 走到（挂在 <span> 上时这里永远聚焦不到）
    await user.tab()
    const trigger = screen.getByRole('button', { name: '需插件' })
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByText('原版 RCON 不暴露玩家 ping')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText('原版 RCON 不暴露玩家 ping')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('空格键同样能打开（button 的键盘契约不止 Enter）', async () => {
    const user = userEvent.setup()
    render(
      <InfoHint variant="inline" label="需插件">
        原版 RCON 不暴露玩家 ping
      </InfoHint>,
    )
    // 先键盘聚焦（不能用 click——那已经把浮层打开了，再按空格测的是浮层内行为）
    screen.getByRole('button', { name: '需插件' }).focus()
    await user.keyboard(' ')
    expect(await screen.findByText('原版 RCON 不暴露玩家 ping')).toBeInTheDocument()
  })
})
