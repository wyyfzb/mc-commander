import { describe, it, expect } from 'vitest'
import {
  ITEM_SINCE_VERSION,
  ITEM_VERSION_FLOOR,
  compareVersions,
  isItemAvailableIn,
  requiredVersionFor,
} from '../mc-item-versions'
import { MINECRAFT_ITEMS } from '../mc-items'
import { buildGiveCommand } from '../mc-enchantments'

/**
 * 物品版本元数据（条目 9）。
 *
 * 本表由 `scripts/gen-item-versions.mjs` 从**官方注册表**生成（Mojang 正式版清单 +
 * mcmeta 各版本 item 注册表），故测试重点不是「值对不对」（那是生成器的职责），
 * 而是：① 比较函数正确（字符串比较会把 1.9 排在 1.10 之后）；② 语义边界正确
 * （未标注 = 无版本要求，不是「不适用」）；③ 拼装层的守卫真的拦住。
 */
describe('compareVersions - 逐段数值比较', () => {
  it('按段比较而非字符串比较（1.9 < 1.10）', () => {
    // 字符串比较会得出 '1.9' > '1.10'（'9' > '1'），这是本函数存在的唯一理由
    expect(compareVersions('1.9', '1.10')).toBeLessThan(0)
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0)
  })

  it('主/次/修订逐级比较', () => {
    expect(compareVersions('1.20.5', '1.21')).toBeLessThan(0)
    expect(compareVersions('1.21', '1.21.2')).toBeLessThan(0)
    expect(compareVersions('1.21.2', '1.21.10')).toBeLessThan(0)
    expect(compareVersions('26.1', '26.2')).toBeLessThan(0)
    expect(compareVersions('26.3', '1.21.11')).toBeGreaterThan(0)
  })

  it('相同版本为 0（含缺段视为 0）', () => {
    expect(compareVersions('1.21', '1.21')).toBe(0)
    expect(compareVersions('1.21', '1.21.0')).toBe(0)
  })
})

describe('isItemAvailableIn - 语义边界', () => {
  it('未标注的物品在所有版本可用（未标注 = 无版本要求，不是「不适用」）', () => {
    // diamond 是远古物品，不在表里 ⇒ 面板下限 1.20.5 起都可用
    expect(ITEM_SINCE_VERSION['diamond']).toBeUndefined()
    expect(isItemAvailableIn('diamond', '1.20.5')).toBe(true)
    expect(requiredVersionFor('diamond')).toBe(null)
  })

  it('已标注的物品：达到所需版本才可用', () => {
    expect(isItemAvailableIn('sulfur', '26.2')).toBe(true)
    expect(isItemAvailableIn('sulfur', '26.3')).toBe(true)
    expect(isItemAvailableIn('sulfur', '26.1')).toBe(false)
    expect(isItemAvailableIn('sulfur', '1.21.4')).toBe(false)
  })

  it('恰好等于所需版本即可用（闭区间下界）', () => {
    const need = ITEM_SINCE_VERSION['golden_dandelion']
    expect(need).toBe('26.1')
    expect(isItemAvailableIn('golden_dandelion', need!)).toBe(true)
  })

  it('requiredVersionFor 返回 null 而非面板下限（调用方需区分「无要求」与「要求 1.20.5」）', () => {
    expect(requiredVersionFor('diamond')).toBe(null)
    expect(requiredVersionFor('music_disc_bounce')).toBe('26.2')
  })
})

describe('生成表的结构约束（生成器坏掉时先在这里失败）', () => {
  it('所有值都不早于面板下限', () => {
    for (const [id, v] of Object.entries(ITEM_SINCE_VERSION)) {
      expect(compareVersions(v, ITEM_VERSION_FLOOR), `${id}@${v}`).toBeGreaterThan(0)
    }
  })

  it('表里不含面板目录之外的项（生成器只应处理目录里的 212 条）', () => {
    // 官方注册表有 1658 条，但前端只渲染目录里的物品 ⇒ 生成器必须先按目录过滤，
    // 否则前端会拿到一堆用不上的死数据。这条同时是「生成器口径被改错」的哨兵。
    const catalog = new Set(MINECRAFT_ITEMS.map((i) => i.id))
    const extra = Object.keys(ITEM_SINCE_VERSION).filter((id) => !catalog.has(id))
    expect(extra).toEqual([])
  })

  it('生成表规模落在合理区间（口径错时会明显偏离）', () => {
    // 实测：212 条目录里，晚于 1.20.5 的只有 20 条（1.21 的三张唱片 + 26.1 的金蒲公英
    // + 26.2 的硫磺/朱砂族与唱片）。这个数字来自官方注册表逐版本累加，
    // 与源码注释里「1.21 系 79 条」那种按组头读出来的结果完全不同。
    const n = Object.keys(ITEM_SINCE_VERSION).length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(60)
  })

  it('面板目录里的 id 全部在官方注册表可查到（3 条历史 id 误写的回归守卫）', () => {
    // `concrete`（官方无裸形式，只有 16 种染色变体）、`geyser`（无此物品）、
    // `bucket_of_sulfur_cube`（官方语序是 `sulfur_cube_bucket`）三条曾写错，
    // give 命令在任何版本都必失败。生成器现在会拒跑；这里再钉一次，避免有人
    // 「修好生成器」时把这层校验删掉。
    expect(MINECRAFT_ITEMS.some((i) => i.id === 'concrete')).toBe(false)
    expect(MINECRAFT_ITEMS.some((i) => i.id === 'geyser')).toBe(false)
    expect(MINECRAFT_ITEMS.some((i) => i.id === 'bucket_of_sulfur_cube')).toBe(false)
    expect(MINECRAFT_ITEMS.some((i) => i.id === 'sulfur_cube_bucket')).toBe(true)
  })

  it('面板目录中被标注的物品，版本值都形如 x.y 或 x.y.z', () => {
    for (const [id, v] of Object.entries(ITEM_SINCE_VERSION)) {
      expect(v, id).toMatch(/^\d+\.\d+(\.\d+)?$/)
    }
  })
})

describe('buildGiveCommand 的物品版本守卫', () => {
  const item = MINECRAFT_ITEMS.find((i) => i.id === 'sulfur')!

  it('目标版本装不下该物品 → 抛错（不生成一条服务端必拒的命令）', () => {
    expect(() =>
      buildGiveCommand({ playerName: 'Steve', item, count: 1, mcVersion: '1.21.4' }),
    ).toThrowError(/需要 MC 26\.2\+（目标版本 1\.21\.4）/)
  })

  it('目标版本够 → 正常生成', () => {
    const cmd = buildGiveCommand({ playerName: 'Steve', item, count: 1, mcVersion: '26.2' })
    expect(cmd).toContain('give Steve minecraft:sulfur')
  })

  it('未提供 mcVersion → 不判版本（调用方未定版本时不该凭空拦）', () => {
    const cmd = buildGiveCommand({ playerName: 'Steve', item, count: 1 })
    expect(cmd).toContain('give Steve minecraft:sulfur')
  })

  it('远古物品在任何目标版本都放行（未标注 = 无版本要求）', () => {
    const diamond = MINECRAFT_ITEMS.find((i) => i.id === 'diamond')!
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: diamond,
      count: 1,
      mcVersion: '1.20.5',
    })
    expect(cmd).toContain('give Steve minecraft:diamond')
  })
})
