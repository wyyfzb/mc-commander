/**
 * 名单类查询的保底轮询间隔。
 *
 * 承重点：推送面在线时名单由事件驱动（加入/离开/名单变化都失效重取），轮询要退成兜底；
 * 掉线则回到 30s。写死一个值会让「推送在线」这条优化在界面上看不出来，
 * 也会让掉线后的自愈变慢（300s 才发现）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { FALLBACK_POLL_INTERVAL_MS, PUSHED_POLL_INTERVAL_MS, queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { usePlayerBans, usePlayers } from '../queries'

vi.mock('@/api/client', () => ({ apiGet: vi.fn(async () => []) }))

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, wrapper }
}

/** `refetchInterval` 是 observer 选项，缓存上留着的是一份松散副本，读它需要显式收窄 */
function intervalOf(qc: QueryClient, key: readonly unknown[]) {
  const options = qc.getQueryCache().find({ queryKey: key })?.options as
    | { refetchInterval?: unknown }
    | undefined
  return options?.refetchInterval
}

beforeEach(() => {
  useConnectionStore.setState({ status: 'ready', baseUrl: '', apiKey: 'k' })
  useServerStore.setState({ status: null })
})

describe('名单类查询的轮询间隔随推送面状态切换', () => {
  it.each([
    ['推送未连通', false, FALLBACK_POLL_INTERVAL_MS],
    ['推送已连通', true, PUSHED_POLL_INTERVAL_MS],
  ])('玩家列表：%s', (_label, msmpPush, expected) => {
    useServerStore.setState({
      status: { isRunning: true, capabilities: { rcon: true, msmp: true, msmpPush } } as never,
    })
    const { qc, wrapper } = setup()
    renderHook(() => usePlayers('i-1'), { wrapper })
    expect(intervalOf(qc, queryKeys.players('i-1'))).toBe(expected)
  })

  it.each([
    ['推送未连通', false, FALLBACK_POLL_INTERVAL_MS],
    ['推送已连通', true, PUSHED_POLL_INTERVAL_MS],
  ])('封禁记录：%s', (_label, msmpPush, expected) => {
    useServerStore.setState({
      status: { isRunning: true, capabilities: { rcon: true, msmp: true, msmpPush } } as never,
    })
    const { qc, wrapper } = setup()
    renderHook(() => usePlayerBans('i-1'), { wrapper })
    expect(intervalOf(qc, [...queryKeys.players('i-1'), 'bans'])).toBe(expected)
  })

  it('推送掉线后立刻回到兜底间隔（不是只在首挂载时判一次）', () => {
    useServerStore.setState({
      status: {
        isRunning: true,
        capabilities: { rcon: true, msmp: true, msmpPush: true },
      } as never,
    })
    const { qc, wrapper } = setup()
    const { rerender } = renderHook(() => usePlayers('i-1'), { wrapper })
    expect(intervalOf(qc, queryKeys.players('i-1'))).toBe(PUSHED_POLL_INTERVAL_MS)

    useServerStore.setState({
      status: {
        isRunning: true,
        capabilities: { rcon: true, msmp: true, msmpPush: false },
      } as never,
    })
    rerender()
    expect(intervalOf(qc, queryKeys.players('i-1'))).toBe(FALLBACK_POLL_INTERVAL_MS)
  })
})
