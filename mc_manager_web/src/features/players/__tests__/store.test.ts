/**
 * 玩家筛选/排序纯函数单测
 */
import { describe, expect, it } from 'vitest'
import type { Player } from '@/api/types'
import { applyPlayersFilter, matchesModeFilter, matchesSearch, sortPlayers } from '../store'

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
