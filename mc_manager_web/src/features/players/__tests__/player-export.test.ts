/**
 * player-export 行为级补测（issue 506）
 * - 真实 exceljs 生成工作簿 → 从下载 Blob 读回字节 → xlsx.load 解析断言 13 列与行值映射
 * - 浏览器边界（URL.createObjectURL/revokeObjectURL/anchor click）为观察点，导出编排逻辑全真
 * - 文件名「玩家数据_yyyyMMdd_HHmm.xlsx」经固定系统时间断言
 * mock 数据为虚构玩家（Steve/Alex），严禁真实玩家/服务器信息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ExcelJS from 'exceljs'
import { exportPlayersToExcel } from '../player-export'
import type { Player } from '@/api/types'

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
  '玩家名', 'UUID', '游戏模式', '维度', '坐标X', '坐标Y', '坐标Z',
  '连接状态', '总时长(h)', 'OP', '白名单', '封禁', '假人',
]

/** 从下载 Blob 读回 ArrayBuffer（jsdom FileReader 路径） */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

describe('exportPlayersToExcel', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>()
  const revokeObjectURL = vi.fn()
  let clickSpy: ReturnType<typeof vi.spyOn>
  let captured: Blob | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-05T08:00:00') })
    captured = null
    createObjectURL.mockImplementation((blob: Blob) => {
      captured = blob
      return 'blob:mock-test'
    })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clickSpy.mockRestore()
    vi.clearAllMocks()
  })

  async function readBack(): Promise<ExcelJS.Workbook> {
    expect(captured).toBeInstanceOf(Blob)
    const buffer = await blobToArrayBuffer(captured!)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer)
    return wb
  }

  it('单玩家全字段：13 列 header 顺序与行值映射、下载触发与对象 URL 释放', async () => {
    const steve = makePlayer({
      name: 'Steve',
      uuid: '00000000-0000-4000-8000-000000000002',
      gameMode: 'survival',
      dimension: 'overworld',
      position: { x: 10.4, y: 63.0, z: -3.6 } as Player['position'],
      isOnline: true,
      totalPlayTime: 3600,
      isOp: true,
      isWhitelisted: true,
      isBanned: false,
      isIpBanned: false,
      isFakePlayer: false,
    })
    await exportPlayersToExcel([steve])

    const wb = await readBack()
    const ws = wb.getWorksheet('玩家数据')
    expect(ws).toBeDefined()

    // header：第 1 行 13 列（values 1-based，首元素 undefined）
    const header = ws!.getRow(1).values as unknown[]
    expect(header.slice(1)).toEqual(EXPECTED_HEADERS)
    expect(ws!.getRow(1).font?.bold).toBe(true)

    // 行值映射
    const row = ws!.getRow(2).values as unknown[]
    expect(row.slice(1)).toEqual([
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

    // 下载触发：文件名含固定时刻（本地时区 2026-09-05 08:00）+ 对象 URL 释放
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('玩家数据_20260905_0800.xlsx')
    expect(anchor.href).toContain('blob:mock-test')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-test')
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
    const wb = await readBack()
    const row = wb.getWorksheet('玩家数据')!.getRow(2).values as unknown[]
    expect(row[3]).toBe('unknown-mode')
    expect(row[4]).toBe('the_end_alt')
  })

  it('gameMode/dimension 缺省为空串；离线玩家连接状态=离线', async () => {
    await exportPlayersToExcel([
      makePlayer({ name: 'Alex', gameMode: null, dimension: null, isOnline: false }),
    ])
    const wb = await readBack()
    const row = wb.getWorksheet('玩家数据')!.getRow(2).values as unknown[]
    expect(row[3]).toBe('')
    expect(row[4]).toBe('')
    expect(row[8]).toBe('离线')
  })

  it('position 缺省：三坐标列为空串', async () => {
    await exportPlayersToExcel([makePlayer({ position: null })])
    const wb = await readBack()
    const row = wb.getWorksheet('玩家数据')!.getRow(2).values as unknown[]
    expect(row[5]).toBe('')
    expect(row[6]).toBe('')
    expect(row[7]).toBe('')
  })

  it('封禁取或语义：isIpBanned 单独为真即封禁=是；总时长小数一位；假人=是', async () => {
    await exportPlayersToExcel([
      makePlayer({ name: 'Alex', isBanned: false, isIpBanned: true, totalPlayTime: 5400, isFakePlayer: true }),
    ])
    const wb = await readBack()
    const row = wb.getWorksheet('玩家数据')!.getRow(2).values as unknown[]
    expect(row[12]).toBe('是') // 封禁（isBanned || isIpBanned 右臂）
    expect(row[9]).toBe('1.5') // 5400/3600
    expect(row[13]).toBe('是') // 假人
    expect(row[10]).toBe('否') // OP
    expect(row[11]).toBe('否') // 白名单
  })

  it('多玩家按传入顺序逐行写入；空列表仅 header 行', async () => {
    const players = [
      makePlayer({ name: 'Steve' }),
      makePlayer({ name: 'Alex', uuid: '00000000-0000-4000-8000-000000000003' }),
      makePlayer({ name: 'Bob', uuid: '00000000-0000-4000-8000-000000000004' }),
    ]
    await exportPlayersToExcel(players)
    const wb = await readBack()
    const ws = wb.getWorksheet('玩家数据')!
    expect(ws.rowCount).toBe(4)
    expect((ws.getRow(2).values as unknown[])[1]).toBe('Steve')
    expect((ws.getRow(3).values as unknown[])[1]).toBe('Alex')
    expect((ws.getRow(4).values as unknown[])[1]).toBe('Bob')

    const wb2 = new ExcelJS.Workbook()
    await exportPlayersToExcel([])
    const buffer2 = await blobToArrayBuffer(captured!)
    await wb2.xlsx.load(buffer2)
    expect(wb2.getWorksheet('玩家数据')!.rowCount).toBe(1)
  })
})
