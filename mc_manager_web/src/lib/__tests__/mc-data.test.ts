/**
 * 静态数据完整性单测：211 物品 / 20 药水 / 6 礼包 + 礼包 schema 往返
 */
import { describe, expect, it } from 'vitest'
import { ITEM_CATEGORIES, MINECRAFT_ITEMS, fullItemId, itemImageUrl } from '../mc-items'
import {
  CUSTOM_LEVEL_DURATIONS,
  MINECRAFT_POTIONS,
  POTION_BOTTLE_TYPES,
  POTION_LEVEL_ROMAN,
  POTION_MAX_LEVEL,
  durationsForLevel,
  isCustomPotionLevel,
  potionDisplayName,
  potionLevelLabel,
} from '../mc-potions'
import {
  DEFAULT_KITS,
  kitFromJson,
  kitToJson,
  loadKitsFromStorage,
  saveKitsToStorage,
} from '../mc-kits'

describe('物品目录完整性（211 种）', () => {
  it('共 211 种物品', () => {
    expect(MINECRAFT_ITEMS).toHaveLength(211)
  })

  it('物品 ID 无重复', () => {
    const ids = MINECRAFT_ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('分类分布与源一致：建筑材料 49/武器装备 32/工具 26/食物 25/自然资源 22/装饰 22/杂项 18/红石 18', () => {
    const byCategory = new Map<string, number>()
    for (const item of MINECRAFT_ITEMS) {
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1)
    }
    expect(byCategory.get('建筑材料')).toBe(49)
    expect(byCategory.get('武器装备')).toBe(32)
    expect(byCategory.get('工具')).toBe(26)
    expect(byCategory.get('食物')).toBe(25)
    expect(byCategory.get('自然资源')).toBe(22)
    expect(byCategory.get('装饰方块')).toBe(21)
    expect(byCategory.get('杂项')).toBe(18)
    expect(byCategory.get('红石元件')).toBe(18)
    expect([...byCategory.values()].reduce((a, b) => a + b, 0)).toBe(211)
  })

  it('stackSize 取值合法（1/16/64），分类均在 ITEM_CATEGORIES 中', () => {
    for (const item of MINECRAFT_ITEMS) {
      expect([1, 16, 64]).toContain(item.stackSize)
      expect(ITEM_CATEGORIES).toContain(item.category)
    }
  })

  it('派生函数：fullId / imageUrl', () => {
    expect(fullItemId('diamond')).toBe('minecraft:diamond')
    expect(itemImageUrl('diamond')).toBe('https://mc-heads.net/item/diamond/36')
  })

  it('覆盖 26.x 新物品（金蒲公英/硫磺系列/朱砂系列/新唱片/重锤）', () => {
    const ids = MINECRAFT_ITEMS.map((i) => i.id)
    for (const id of ['golden_dandelion', 'sulfur', 'cinnabar', 'music_disc_bounce', 'mace']) {
      expect(ids).toContain(id)
    }
    // `geyser` 已被移除：官方 item/block 注册表（1.20.5 … 26.4-snapshot-1）都查不到该 id，
    // 而 26.2 实际新增的全是硫磺/朱砂族方块（已由上面的 sulfur / cinnabar 覆盖）
    expect(ids).not.toContain('geyser')
  })
})

describe('药水目录完整性（20 种）', () => {
  it('共 20 种效果', () => {
    expect(MINECRAFT_POTIONS).toHaveLength(20)
  })

  it('效果 ID 无重复；vanillaMaxLevel 为 1 或 2', () => {
    const ids = MINECRAFT_POTIONS.map((p) => p.effectId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of MINECRAFT_POTIONS) {
      expect([1, 2]).toContain(p.vanillaMaxLevel)
      expect(p.color).toBeGreaterThanOrEqual(0)
      expect(p.color).toBeLessThanOrEqual(0xffffff)
    }
  })

  it('瞬时效果仅治疗/伤害，无时长档位', () => {
    for (const p of MINECRAFT_POTIONS) {
      if (p.isInstant) {
        expect(['instant_health', 'instant_damage']).toContain(p.effectId)
        expect(durationsForLevel(p, 1)).toEqual([])
      }
    }
  })

  it('瓶型 3 种与等级罗马数字 I-V', () => {
    expect(POTION_BOTTLE_TYPES).toHaveLength(3)
    expect(POTION_LEVEL_ROMAN).toEqual(['I', 'II', 'III', 'IV', 'V'])
    expect(POTION_MAX_LEVEL).toBe(5)
  })

  it('自定义等级（III+）使用通用时长档位', () => {
    const strength = MINECRAFT_POTIONS.find((p) => p.effectId === 'strength')!
    expect(durationsForLevel(strength, 3)).toBe(CUSTOM_LEVEL_DURATIONS)
    expect(CUSTOM_LEVEL_DURATIONS.map((d) => d.ticks)).toEqual([600, 1200, 3600, 9600])
  })

  it('等级 II 有强效版时用 level2Durations；无强效版（夜视）走通用档', () => {
    const strength = MINECRAFT_POTIONS.find((p) => p.effectId === 'strength')!
    expect(durationsForLevel(strength, 2)).toHaveLength(1)
    const nightVision = MINECRAFT_POTIONS.find((p) => p.effectId === 'night_vision')!
    expect(durationsForLevel(nightVision, 2)).toBe(CUSTOM_LEVEL_DURATIONS)
  })

  it('displayName / levelLabel 文案', () => {
    const strength = MINECRAFT_POTIONS.find((p) => p.effectId === 'strength')!
    const base = { effect: strength, bottle: POTION_BOTTLE_TYPES[0]!, level: 2, duration: 1800 }
    expect(potionDisplayName(base)).toBe('力量药水 II')
    expect(potionLevelLabel(base)).toBe('II')
    expect(isCustomPotionLevel(base)).toBe(false)

    const custom = { ...base, level: 3 }
    expect(potionDisplayName(custom)).toBe('力量药水 III（自定义）')
    expect(potionLevelLabel(custom)).toBe('III（自定义）')
    expect(isCustomPotionLevel(custom)).toBe(true)

    const splash = { ...base, bottle: POTION_BOTTLE_TYPES[1]!, level: 1 }
    expect(potionDisplayName(splash)).toBe('喷溅力量药水')
  })
})

describe('默认礼包（6 个）与持久化 schema', () => {
  it('共 6 个默认礼包', () => {
    expect(DEFAULT_KITS).toHaveLength(6)
    const names = DEFAULT_KITS.map((k) => k.name)
    expect(names).toEqual(['新手起步包', '钻石套装', '下界合金套装', '建材包', '食物包', '药水包'])
  })

  it('药水包同一物品可重复出现（5 条 potion 记录）', () => {
    const potionKit = DEFAULT_KITS.find((k) => k.name === '药水包')!
    expect(potionKit.items).toHaveLength(5)
    expect(potionKit.items.every((i) => i.id === 'potion' && i.count === 3)).toBe(true)
  })

  it('礼包可含目录外物品 id（quartz_block），调用方容错跳过', () => {
    // 本意是「套件允许引用目录里没有的物品 id，渲染方要容错」。原用例拿 `brick_block`
    // 当样本，但它其实是**写错的官方 id**（应为 `bricks`，官方注册表无 `brick_block`），
    // 已订正；保留的目录外样本是 `quartz_block`。
    const buildKit = DEFAULT_KITS.find((k) => k.name === '建材包')!
    const ids = buildKit.items.map((i) => i.id)
    const catalog = new Set(MINECRAFT_ITEMS.map((i) => i.id))
    expect(ids).toContain('bricks')
    expect(ids).toContain('quartz_block')
    expect(catalog.has('bricks')).toBe(true) // 已收进目录
    expect(catalog.has('quartz_block')).toBe(false) // 仍是目录外
  })

  it('schema 往返一致', () => {
    for (const kit of DEFAULT_KITS) {
      const round = kitFromJson(kitToJson(kit))
      expect(round).not.toBeNull()
      expect(round!.name).toBe(kit.name)
      expect(round!.icon).toBe(kit.icon)
      expect(round!.desc).toBe(kit.desc)
      expect(round!.items).toEqual(kit.items)
    }
  })

  it('损坏数据容错：非法 JSON / 空 id 条目丢弃 / 非对象', () => {
    expect(kitFromJson(null)).toBeNull()
    expect(kitFromJson('abc')).toBeNull()
    expect(kitFromJson({ name: '', items: [{ id: '', count: 2 }] })).toBeNull()
    const partial = kitFromJson({
      name: 'x',
      items: [
        { id: '', count: 2 },
        { id: 'diamond', count: '8' as unknown as number },
      ],
    })
    // 空 id 条目丢弃；非 number count 回退 1
    expect(partial?.items).toEqual([{ id: 'diamond', count: 1 }])
  })

  it('localStorage 读写与损坏回退默认礼包', () => {
    const mem = new Map<string, string>()
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    } as Storage

    // 空存储 → 默认礼包
    expect(loadKitsFromStorage(storage)).toHaveLength(6)
    // 保存 → 读取
    saveKitsToStorage(storage, [DEFAULT_KITS[0]!])
    const loaded = loadKitsFromStorage(storage)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.name).toBe('新手起步包')
    // 损坏 JSON → 回退默认
    storage.setItem('mc_commander_kits', '{bad json')
    expect(loadKitsFromStorage(storage)).toHaveLength(6)
  })
})
