/**
 * player-export 行为级补测
 * - 拦截 write-excel-file：断言真实传给库的工作表数据（13 列表头/行值映射/列宽/表头加粗）
 *   与下载文件名；导出编排逻辑（标签映射、四舍五入、或语义）全真
 * - 文件名「玩家数据_yyyyMMdd_HHmm.xlsx」经固定系统时间断言
 * mock 数据为虚构玩家（Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exportPlayersToExcel } from '@/features/players/player-export'
import type { Player } from '@/api/types'

const { toFile, writeXlsxFileMock } = vi.hoisted(() => {
  const toFile = vi.fn()
  const writeXlsxFileMock = vi.fn((..._args: unknown[]) => ({ toBlob: vi.fn(), toFile }))
  return { toFile, writeXlsxFileMock }
})
vi.mock('write-excel-file/browser', () => ({ default: writeXlsxFileMock }))

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000002',
    isOnline: true,
    ip: '1.2.3.4',
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
    lastSeen: '',
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    spawnPoint: null,
    respawnPoint: null,
    position: null,
    gameMode: 'survival',
    dimension: 'overworld',
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

const EXPECTED_HEADERS = [
  '玩家名',
  'UUID',
  '游戏模式',
  '维度',
  '坐标X',
  '坐标Y',
  '坐标Z',
  '连接状态',
  '总时长(h)',
  'OP',
  '白名单',
  '封禁',
  '假人',
]

type Cell = { value?: unknown; fontWeight?: string }
type SheetOptions = { sheet?: string; columns?: { width?: number }[] }

/** 取最近一次导出传给库的工作表数据与该次工作表选项 */
function lastCall(): { data: Cell[][]; options: SheetOptions } {
  const call = writeXlsxFileMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return { data: call![0] as Cell[][], options: call![1] as SheetOptions }
}

/** 行内第 n 列（1-based，与表格列号一致）的值 */
function column(data: Cell[][], rowIndex: number, columnNumber: number): unknown {
  return data[rowIndex]![columnNumber - 1]!.value
}

describe('exportPlayersToExcel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-05T08:00:00') })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('单玩家全字段：13 列 header 顺序、表头加粗、列宽、行值映射与下载文件名', async () => {
    const steve = makePlayer({
      position: { x: 10.4, y: 63.0, z: -3.6 } as Player['position'],
      totalPlayTime: 3600,
      isOp: true,
      isWhitelisted: true,
    })
    await exportPlayersToExcel([steve])

    const { data, options } = lastCall()
    expect(options.sheet).toBe('玩家数据')
    expect(data[0]!.map((cell) => cell.value)).toEqual(EXPECTED_HEADERS)
    expect(data[0]!.every((cell) => cell.fontWeight === 'bold')).toBe(true)
    expect(options.columns).toEqual([
      { width: 16 },
      { width: 36 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 6 },
      { width: 8 },
      { width: 6 },
      { width: 6 },
    ])

    expect(data[1]!.map((cell) => cell.value)).toEqual([
      'Steve',
      '00000000-0000-4000-8000-000000000002',
      '生存',
      '主世界',
      10, // Math.round(10.4)
      63,
      -4, // Math.round(-3.6)
      '在线',
      '1.0', // 3600/3600
      '是',
      '是',
      '否',
      '否',
    ])

    // 文件名含固定时刻（本地时区 2026-09-05 08:00）
    expect(toFile).toHaveBeenCalledTimes(1)
    expect(toFile).toHaveBeenCalledWith('玩家数据_20260905_0800.xlsx')
  })

  it('未知游戏模式/维度原值透传（标签表 miss fallback）', async () => {
    // 类型层为受控联合，运行时数据可能为超集；标签表 miss 时兜底透传原值，受控断言构造 miss 场景
    await exportPlayersToExcel([
      makePlayer({
        name: 'Alex',
        gameMode: 'unknown-mode' as unknown as Player['gameMode'],
        dimension: 'the_end_alt' as unknown as Player['dimension'],
      }),
    ])
    const { data } = lastCall()
    expect(column(data, 1, 3)).toBe('unknown-mode')
    expect(column(data, 1, 4)).toBe('the_end_alt')
  })

  it('gameMode/dimension 缺省为空串；离线玩家连接状态=离线', async () => {
    await exportPlayersToExcel([
      makePlayer({ name: 'Alex', gameMode: null, dimension: null, isOnline: false }),
    ])
    const { data } = lastCall()
    expect(column(data, 1, 3)).toBe('')
    expect(column(data, 1, 4)).toBe('')
    expect(column(data, 1, 8)).toBe('离线')
  })

  it('position 缺省：三坐标列为空串', async () => {
    await exportPlayersToExcel([makePlayer({ position: null })])
    const { data } = lastCall()
    expect(column(data, 1, 5)).toBe('')
    expect(column(data, 1, 6)).toBe('')
    expect(column(data, 1, 7)).toBe('')
  })

  it('封禁取或语义：isIpBanned 单独为真即封禁=是；总时长小数一位；假人=是', async () => {
    await exportPlayersToExcel([
      makePlayer({
        name: 'Alex',
        isBanned: false,
        isIpBanned: true,
        totalPlayTime: 5400,
        isFakePlayer: true,
      }),
    ])
    const { data } = lastCall()
    expect(column(data, 1, 12)).toBe('是') // 封禁（isBanned || isIpBanned 右臂）
    expect(column(data, 1, 9)).toBe('1.5') // 5400/3600
    expect(column(data, 1, 13)).toBe('是') // 假人
    expect(column(data, 1, 10)).toBe('否') // OP
    expect(column(data, 1, 11)).toBe('否') // 白名单
  })

  it('多玩家按传入顺序逐行写入；空列表仅 header 行', async () => {
    const players = [
      makePlayer({ name: 'Steve' }),
      makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004' }),
    ]
    await exportPlayersToExcel(players)
    const { data } = lastCall()
    expect(data).toHaveLength(4)
    expect(column(data, 1, 1)).toBe('Steve')
    expect(column(data, 2, 1)).toBe('Alex')
    expect(column(data, 3, 1)).toBe('Bob')

    await exportPlayersToExcel([])
    expect(lastCall().data).toHaveLength(1)
  })
})
