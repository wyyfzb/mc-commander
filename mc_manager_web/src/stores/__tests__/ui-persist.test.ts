import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useUiStore } from '../ui'
import { migrateFromLegacyKeys } from '@/lib/migrate-ui-keys'

/**
 * useUiStore zustand persist 测试
 * - 偏好字段写入 localStorage
 * - 旧版分散 key 自动迁移
 * - 会话态字段不持久化
 */

const STORAGE_KEY = 'mcs-ui-preferences'

beforeEach(() => {
  localStorage.clear()
  // persist rehydration 在 store 创建时已完成；清 localStorage 后手动重置
  useUiStore.setState({
    theme: 'dark',
    sidebarCollapsed: false,
    commandPaletteOpen: false,
    notificationsOpen: false,
    mobileNavOpen: false,
    density: 'default',
    terminalAutoScroll: true,
    confirmCommands: false,
  })
})

afterEach(() => {
  localStorage.clear()
})

describe('useUiStore persist', () => {
  it('terminalAutoScroll 写入 localStorage', async () => {
    useUiStore.getState().setTerminalAutoScroll(false)
    await new Promise((r) => setTimeout(r, 20))
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as { state: { terminalAutoScroll: boolean } }
    expect(stored.state.terminalAutoScroll).toBe(false)
  })

  it('会话态字段不写入 localStorage', async () => {
    useUiStore.getState().toggleSidebar()
    useUiStore.getState().setCommandPaletteOpen(true)
    useUiStore.getState().setMobileNavOpen(true)
    await new Promise((r) => setTimeout(r, 20))
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>
    expect(stored.state).not.toHaveProperty('sidebarCollapsed')
    expect(stored.state).not.toHaveProperty('commandPaletteOpen')
    expect(stored.state).not.toHaveProperty('mobileNavOpen')
  })

  it('偏好字段变更触发 localStorage 更新', async () => {
    useUiStore.getState().setTheme('light')
    useUiStore.getState().setDensity('compact')
    useUiStore.getState().setConfirmCommands(true)
    await new Promise((r) => setTimeout(r, 20))
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      state: { theme: string; density: string; terminalAutoScroll: boolean; confirmCommands: boolean }
    }
    expect(stored.state.theme).toBe('light')
    expect(stored.state.density).toBe('compact')
    expect(stored.state.terminalAutoScroll).toBe(true)
    expect(stored.state.confirmCommands).toBe(true)
  })
})

describe('migrateFromLegacyKeys', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('旧版分散 key 合并为统一格式', () => {
    localStorage.setItem('mcs-theme', 'light')
    localStorage.setItem('mcs-terminal-autoscroll', 'false')
    localStorage.setItem('mcs-density', 'compact')
    const result = migrateFromLegacyKeys()
    expect(result).toEqual({ theme: 'light', terminalAutoScroll: false, density: 'compact' })
  })

  it('新 key 已存在时跳过迁移', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { theme: 'dark' }, version: 0 }))
    localStorage.setItem('mcs-theme', 'light')
    const result = migrateFromLegacyKeys()
    expect(result).toBeNull()
  })

  it('无旧 key 时返回 null', () => {
    const result = migrateFromLegacyKeys()
    expect(result).toBeNull()
  })

  it('损坏的旧 key 值被安全跳过', () => {
    localStorage.setItem('mcs-theme', 'invalid-value')
    localStorage.setItem('mcs-terminal-autoscroll', 'not-a-boolean')
    const result = migrateFromLegacyKeys()
    // 两个值都不合法 → 无有效迁移数据
    expect(result).toBeNull()
  })
})
