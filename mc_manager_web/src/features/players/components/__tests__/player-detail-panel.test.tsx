/**
 * PlayerDetailPanel 回退详情端点的失败态（条目 34 回归锁）。
 *
 * 缺口由来：面板头部此前只有「批量 / 有 effectivePlayer / 加载中…」三分支，
 * 而「回退详情请求失败」与「还在加载」共用同一条路径 ⇒ 端点持续故障时用户看到的是
 * 永久「加载中…」，且所有 Tab 因 effectivePlayer 为 null 而静默不渲染。
 * 断言重点是**三态可分**：失败给错误态 + 重试，加载给骨架文案，成功给玩家信息。
 *
 * 用 MSW 造真实错误响应（而非 mock 掉 usePlayerDetails）：被测的正是
 * 「查询失败如何映射到相位」这条链路，把查询本身替换掉就等于把被测对象换成桩。
 * 数据全部虚构。
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PlayerDetailPanel } from '../player-detail-panel'
import { usePlayersUiStore } from '../../store'
import { useConnectionStore } from '@/stores/connection'
import type { Player } from '@/api/types'

const server = setupServer()

const DETAIL_URL = '*/api/v1/instances/*/players/:name/details'

/** 虚构玩家（无真实服务器信息） */
function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    isOnline: false,
    ip: '',
    joinTime: null,
    onlineTime: 0,
    totalPlayTime: 0,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: '2024-06-01T13:00:00.000Z',
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: null,
    dimension: null,
    armor: null,
    xpProgress: null,
    ping: null,
    isSleeping: false,
    isAfk: false,
    isFlying: false,
    isSneaking: false,
    isSprinting: false,
    isBurning: false,
    isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: {
      totalOnline: 0,
      loginCount: 0,
      offlineSince: 0,
      deathCount: 0,
      achievementCount: 0,
      sleepCount: 0,
    },
    ...overrides,
  }
}

function renderPanel(player: Player | null = null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* 概览 Tab 内有 Tooltip（浮层解释），须给 provider——app 侧由 AppShell 提供 */}
      <TooltipProvider>
        <PlayerDetailPanel
          instanceId="e2e-demo"
          player={player}
          isBatchMode={false}
          batchTargets={[]}
          isRconConnected={false}
          mcVersion="1.21.4"
          onAction={async () => {}}
          onOpenBanDialog={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  // 详情面板打开态（detail.playerName 非空才触发回退查询）
  usePlayersUiStore.setState({
    detail: { playerName: 'Steve', tab: 'overview', batchMode: false },
  })
  // 回退查询的 enabled 还要求连接就绪（queries.ts 的 config.status === 'ready'），
  // 否则请求根本不发出，三态都停在「加载中」而测不出任何东西
  useConnectionStore.setState({ status: 'ready', baseUrl: '', apiKey: 'test-key-not-real' })
})

describe('PlayerDetailPanel 回退详情端点失败', () => {
  it('请求失败：头部与内容区都给错误态 + 重试，不停留在「加载中…」', async () => {
    server.use(
      http.get(DETAIL_URL, () =>
        HttpResponse.json(
          { status: 'error', code: 50000, message: '内部错误', timestamp: 0 },
          { status: 500 },
        ),
      ),
    )
    renderPanel()

    // 内容区错误态（ErrorStateVisual 的固定文案）
    expect(await screen.findByText(/加载失败：/)).toBeInTheDocument()
    // 头部不再呈现加载中
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
    expect(screen.getByText('详情加载失败')).toBeInTheDocument()
    // 重试入口可达（头部一个 + 内容区一个，至少存在且可点）
    expect(screen.getAllByRole('button', { name: /重试/ }).length).toBeGreaterThanOrEqual(1)
  })

  it('请求成功：渲染玩家信息，不出现错误态', async () => {
    server.use(
      http.get(DETAIL_URL, () =>
        HttpResponse.json({ status: 'ok', code: 0, data: makePlayer(), timestamp: 0 }),
      ),
    )
    renderPanel()

    expect(await screen.findByText('Steve')).toBeInTheDocument()
    expect(screen.queryByText(/加载失败：/)).not.toBeInTheDocument()
    expect(screen.queryByText('详情加载失败')).not.toBeInTheDocument()
  })

  it('请求挂起（未响应）：呈现「加载中…」而**不是**错误态——两态必须可分', async () => {
    // 永不 resolve：停留在 pending
    server.use(http.get(DETAIL_URL, () => new Promise<never>(() => {})))
    renderPanel()

    expect(await screen.findByText('加载中…')).toBeInTheDocument()
    expect(screen.queryByText(/加载失败：/)).not.toBeInTheDocument()
  })

  it('列表已给出玩家时，详情端点故障不得遮住内容（回退查询此时根本不启用）', async () => {
    // 列表命中时 player prop 非 null ⇒ 回退查询 enabled=false（playerName 为 null）。
    // 未取过的 disabled query 相位是 loading 而非 failed，所以错误态不该出现——
    // 若把它判成 failed，列表已提供玩家的正常场景会被整块错误态盖住
    server.use(
      http.get(DETAIL_URL, () =>
        HttpResponse.json(
          { status: 'error', code: 50000, message: '内部错误', timestamp: 0 },
          { status: 500 },
        ),
      ),
    )
    renderPanel(makePlayer({ name: 'Steve' }))

    expect(await screen.findByText('Steve')).toBeInTheDocument()
    expect(screen.queryByText(/加载失败：/)).not.toBeInTheDocument()
    expect(screen.queryByText('详情加载失败')).not.toBeInTheDocument()
  })
})
