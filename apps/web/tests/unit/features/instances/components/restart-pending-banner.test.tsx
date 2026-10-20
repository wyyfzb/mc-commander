/**
 * RestartPendingBanner 测试：
 * 汇总横幅只说「哪几台有待生效的改动 + 怎么让它生效」，逐台的注明由实例卡片徽章承担。
 * 覆盖：空集不渲染 / 措辞覆盖推送（不再说「启动配置」）/ 多实例并列 /
 * 列表里已不存在的条目被丢弃 / 列表还没加载完时不清（否则会误删有效待办）/ 名字取不到回退 id。
 * 虚构实例名，严禁真实服务器信息。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RestartPendingBanner } from '@/features/instances/components/restart-pending-banner'
import { useRestartPendingStore } from '@/stores/restart-pending'
import type { InstanceSummary } from '@/api/types'

const alpha: InstanceSummary = { id: 'alpha', name: '虚构甲服', isRunning: true, playerCount: 3 }
const beta: InstanceSummary = { id: 'beta', name: '虚构乙服', isRunning: false, playerCount: 0 }

describe('RestartPendingBanner', () => {
  beforeEach(() => {
    useRestartPendingStore.setState({ pending: {} })
  })

  afterEach(() => {
    useRestartPendingStore.setState({ pending: {} })
  })

  it('没有待生效的改动时不渲染（空态不占位、不宣称任何事实）', () => {
    const { container } = render(<RestartPendingBanner instances={[alpha, beta]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('措辞是「设置已修改」：实时推送与启动配置同属本集合，说「启动配置」对前者是假陈述', async () => {
    useRestartPendingStore.setState({ pending: { alpha: Date.now() } })
    render(<RestartPendingBanner instances={[alpha, beta]} />)

    expect(await screen.findByText('虚构甲服 的设置已修改，重启后生效')).toBeInTheDocument()
    expect(screen.queryByText(/启动配置已修改/)).toBeNull()
  })

  it('多台并列列出，顺序与置位顺序一致', async () => {
    useRestartPendingStore.setState({ pending: { alpha: Date.now(), beta: Date.now() } })
    render(<RestartPendingBanner instances={[alpha, beta]} />)

    /* 甲服运行中 ⇒ 重启；乙服已停止 ⇒ 下次启动即生效。统一说「重启」会让乙服用户
       去一个不存在的按钮上找（已停止的卡片只有「启动」） */
    expect(
      await screen.findByText(
        '虚构甲服 的设置已修改，重启后生效；虚构乙服 的设置已修改，下次启动即生效',
      ),
    ).toBeInTheDocument()
  })

  it('列表里已不存在的实例被丢弃：卸载后其 started 事件永不再来，不清就是一条撤不掉的横幅', async () => {
    useRestartPendingStore.setState({ pending: { alpha: Date.now(), ghost: Date.now() } })
    render(<RestartPendingBanner instances={[alpha, beta]} />)

    await waitFor(() => expect(useRestartPendingStore.getState().pending['ghost']).toBeUndefined())
    expect(useRestartPendingStore.getState().pending['alpha']).toBeTypeOf('number')
    expect(await screen.findByText('虚构甲服 的设置已修改，重启后生效')).toBeInTheDocument()
  })

  it('列表还没加载完（空数组）时不清：据此清会把有效待办误删', async () => {
    useRestartPendingStore.setState({ pending: { alpha: Date.now() } })
    const { container } = render(<RestartPendingBanner instances={[]} />)

    // 名字取不到是另一回事：条目必须还在（横幅照常出现，名字回退 id）
    expect(useRestartPendingStore.getState().pending['alpha']).toBeTypeOf('number')
    expect(await screen.findByText('alpha 的设置已修改，下次启动即生效')).toBeInTheDocument()
    expect(container).not.toBeEmptyDOMElement()
  })
})
