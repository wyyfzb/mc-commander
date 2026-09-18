/**
 * 玩家筛选/排序纯函数单测 + UI store 持久化
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { Player } from '@/api/types'
import {
  applyPlayersFilter,
  matchesModeFilter,
  matchesSearch,
  sortPlayers,
  DEFAULT_PLAYERS_FILTER,
  usePlayersUiStore,
  type PlayersFilter,
} from '../store'

const basePlayer = (overrides: Partial<Player>): Player => ({
  name: 'Steve',
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  isOnline: true,
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
  lastSeen: '2026-08-14T00:00:00.000Z',
  health: 20,
  maxHealth: 20,
  hunger: 20,
  xpLevel: 0,
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
})

describe('matchesModeFilter（筛选状态维度）', () => {
  it('在线/离线', () => {
    expect(matchesModeFilter(basePlayer({ isOnline: true }), 'online')).toBe(true)
    expect(matchesModeFilter(basePlayer({ isOnline: true }), 'offline')).toBe(false)
    expect(matchesModeFilter(basePlayer({ isOnline: false }), 'offline')).toBe(true)
  })
  it('OP/白名单/封禁', () => {
    expect(matchesModeFilter(basePlayer({ isOp: true }), 'op')).toBe(true)
    expect(matchesModeFilter(basePlayer({ isWhitelisted: true }), 'whitelist')).toBe(true)
    expect(matchesModeFilter(basePlayer({ isBanned: true }), 'banned')).toBe(true)
    expect(matchesModeFilter(basePlayer({ isIpBanned: true }), 'banned')).toBe(true)
    expect(matchesModeFilter(basePlayer({}), 'banned')).toBe(false)
  })
  it('全部', () => {
    expect(matchesModeFilter(basePlayer({}), 'all')).toBe(true)
  })
})

describe('matchesSearch', () => {
  const player = basePlayer({ name: 'Steve', uuid: 'aaaa-bbbb-cccc' })
  it('名字与 UUID 小写包含匹配', () => {
    expect(matchesSearch(player, 'steve')).toBe(true)
    expect(matchesSearch(player, 'STEVE')).toBe(true)
    expect(matchesSearch(player, 'bbbb')).toBe(true)
    expect(matchesSearch(player, 'alex')).toBe(false)
    expect(matchesSearch(player, '')).toBe(true)
    expect(matchesSearch(player, '  ')).toBe(true)
  })
})

describe('sortPlayers（收敛排序规则）', () => {
  it('在线优先', () => {
    expect(sortPlayers(basePlayer({ isOnline: true }), basePlayer({ isOnline: false }))).toBeLessThan(0)
    expect(sortPlayers(basePlayer({ isOnline: false }), basePlayer({ isOnline: true }))).toBeGreaterThan(0)
  })
  it('同为在线：OP 优先', () => {
    expect(sortPlayers(basePlayer({ isOp: true }), basePlayer({ isOp: false }))).toBeLessThan(0)
  })
  it('lastSeen 升序（先下线者在前）', () => {
    expect(
      sortPlayers(
        basePlayer({ isOnline: false, lastSeen: '2026-08-10T00:00:00.000Z' }),
        basePlayer({ isOnline: false, lastSeen: '2026-08-14T00:00:00.000Z' }),
      ),
    ).toBeLessThan(0)
  })
  it('总时长多者优先', () => {
    expect(
      sortPlayers(
        basePlayer({ isOnline: false, totalPlayTime: 5000 }),
        basePlayer({ isOnline: false, totalPlayTime: 1000 }),
      ),
    ).toBeLessThan(0)
  })
})

describe('applyPlayersFilter（完整流水线）', () => {
  const players = [
    basePlayer({ name: 'Steve', isOnline: true, isOp: true, totalPlayTime: 100 }),
    basePlayer({ name: 'Alex', isOnline: false, totalPlayTime: 9000, lastSeen: '2026-08-13T00:00:00.000Z' }),
    basePlayer({ name: 'Zed', isOnline: false, isBanned: true, lastSeen: '2026-08-10T00:00:00.000Z' }),
    basePlayer({ name: 'Bot_x', isOnline: true, isFakePlayer: true }),
  ]

  it('默认筛选：在线优先排序（离线按 lastSeen 升序）', () => {
    const result = applyPlayersFilter(players, { q: '', mode: 'all', gameMode: '', dimension: '' })
    expect(result.map((p) => p.name)).toEqual(['Steve', 'Bot_x', 'Zed', 'Alex'])
  })

  it('搜索 + 状态筛选组合', () => {
    const result = applyPlayersFilter(players, { q: '', mode: 'banned', gameMode: '', dimension: '' })
    expect(result.map((p) => p.name)).toEqual(['Zed'])
    const bySearch = applyPlayersFilter(players, { q: 'bot', mode: 'all', gameMode: '', dimension: '' })
    expect(bySearch.map((p) => p.name)).toEqual(['Bot_x'])
  })

  it('游戏模式与维度筛选', () => {
    const gmPlayers = [
      basePlayer({ name: 'A', gameMode: 'creative' }),
      basePlayer({ name: 'B', gameMode: 'survival' }),
    ]
    expect(
      applyPlayersFilter(gmPlayers, { q: '', mode: 'all', gameMode: 'creative', dimension: '' }).map((p) => p.name),
    ).toEqual(['A'])
    const dimPlayers = [
      basePlayer({ name: 'A', dimension: 'nether' }),
      basePlayer({ name: 'B', dimension: 'end' }),
    ]
    expect(
      applyPlayersFilter(dimPlayers, { q: '', mode: 'all', gameMode: '', dimension: 'nether' }).map((p) => p.name),
    ).toEqual(['A'])
  })
})

describe('usePlayersUiStore persist（筛选状态记忆）', () => {
  const STORAGE_KEY = 'mcs-players-ui'

  beforeEach(() => {
    localStorage.clear()
    usePlayersUiStore.setState({ filter: { ...DEFAULT_PLAYERS_FILTER } })
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('筛选变更写入 localStorage（刷新/重开浏览器不丢筛选条件）', () => {
    usePlayersUiStore.getState().setFilter({ q: 'Steve', mode: 'online' })

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as { state: { filter: PlayersFilter } }
    expect(stored.state.filter).toMatchObject({ q: 'Steve', mode: 'online' })
  })

  it('会话态（选中集/详情面板）不持久化', () => {
    usePlayersUiStore.setState({
      selectedUuids: ['uuid-1'],
      detail: { playerName: 'Steve', tab: 'overview', batchMode: false },
    })

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as { state: Record<string, unknown> }
    expect(stored.state).not.toHaveProperty('selectedUuids')
    expect(stored.state).not.toHaveProperty('detail')
  })

  it('切换实例重置筛选（resetForInstance 同步清除持久化值）', () => {
    usePlayersUiStore.getState().setFilter({ q: 'Steve' })
    usePlayersUiStore.getState().resetForInstance()

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as { state: { filter: PlayersFilter } }
    expect(stored.state.filter).toEqual(DEFAULT_PLAYERS_FILTER)
  })

  it('旧存储缺新字段时以默认值兜底（防止列表被静默过滤成空）', async () => {
    // 模拟「未来版本新增筛选字段、旧 localStorage 只有 q」的存储形态
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { filter: { q: 'Steve' } }, version: 0 }))

    // 动态 import 触发 store 重建 + 重合并
    vi.resetModules()
    const { usePlayersUiStore: reloaded } = await import('../store')
    const filter = reloaded.getState().filter

    expect(filter.q).toBe('Steve')
    expect(filter.mode).toBe('all')
    expect(filter.gameMode).toBe('')
    expect(filter.dimension).toBe('')
  })
})
