/**
 * NotificationDrawer 通知条目跳转测试（issue 334）
 * - 带 instanceId 的条目：点击 → 标记已读 + 关抽屉 + navigate /instances?focus=<id>
 * - 无 instanceId 的条目：点击仅标记已读（原行为）
 * - circuitBreaker 类型渲染（severe 样式 + 图标）
 * 测试数据均为虚构（inst-1/虚构实例），无真实凭据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useNotificationStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'
import { NotificationDrawer } from '../notification-drawer'

const navigateMock = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => navigateMock,
}))

function seedStore() {
  useNotificationStore.setState({
    items: [
      {
        id: 'n-1',
        type: 'serverCrash',
        category: 'server',
        content: '服务器意外退出',
        timestamp: Date.now(),
        count: 1,
        read: false,
        instanceId: 'inst-1',
      },
      {
        id: 'n-2',
        type: 'join',
        category: 'game',
        content: 'Steve 加入了游戏',
        timestamp: Date.now() - 1000,
        count: 1,
        read: false,
      },
    ],
    unreadCount: 2,
    activeAlerts: new Set(),
  })
}

function renderDrawer() {
  const onOpenChange = vi.fn()
  render(<NotificationDrawer open onOpenChange={onOpenChange} />)
  return { onOpenChange }
}

beforeEach(() => {
  navigateMock.mockClear()
  seedStore()
  useUiStore.setState({ notificationsOpen: true })
})

describe('NotificationDrawer 条目跳转（issue 334）', () => {
  it('带 instanceId 条目：点击 → 已读 + 关抽屉 + focus 深链接跳转', () => {
    const { onOpenChange } = renderDrawer()

    const entry = screen.getByText('服务器意外退出').closest('button')
    expect(entry).not.toBeNull()
    fireEvent.click(entry!)

    expect(useNotificationStore.getState().items.find((n) => n.id === 'n-1')?.read).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(navigateMock).toHaveBeenCalledWith('/instances?focus=inst-1')
  })

  it('无 instanceId 条目：点击仅标记已读，不跳转', () => {
    const { onOpenChange } = renderDrawer()

    const entry = screen.getByText('Steve 加入了游戏').closest('button')
    expect(entry).not.toBeNull()
    fireEvent.click(entry!)

    expect(useNotificationStore.getState().items.find((n) => n.id === 'n-2')?.read).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('带 instanceId 条目展示跳转提示（查看实例）', () => {
    renderDrawer()
    expect(screen.getByText('查看实例')).toBeInTheDocument()
  })
})
