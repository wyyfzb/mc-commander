/**
 * NBT 三格式自适应 + 附魔目录单测
 */
import { describe, expect, it } from 'vitest'
import { MINECRAFT_ITEMS } from '../mc-items'
import { MINECRAFT_POTIONS, POTION_BOTTLE_TYPES } from '../mc-potions'
import type { PotionConfig } from '../mc-potions'
import {
  ENCHANTMENTS,
  ItemSlotType,
  appliesToSlot,
  areEnchantmentsConflicting,
  buildGiveCommand,
  buildPotionComponents,
  getEnchantmentById,
  getEnchantmentsForItem,
  getItemSlotType,
  isEnchantmentDisabledBy,
  isMc26,
  supportsDataComponents,
  toRoman,
  usesDirectEnchantmentMap,
} from '../mc-enchantments'

const item = (id: string) => MINECRAFT_ITEMS.find((i) => i.id === id)!

const potionConfig = (overrides: Partial<PotionConfig>): PotionConfig => ({
  effect: MINECRAFT_POTIONS.find((p) => p.effectId === 'strength')!,
  bottle: POTION_BOTTLE_TYPES[0]!,
  level: 2,
  duration: 1800,
  ...overrides,
})

describe('附魔目录完整性', () => {
  it('共 42 种附魔', () => {
    expect(ENCHANTMENTS).toHaveLength(42)
  })

  it('附魔 ID 无重复，maxLevel 合法（1-5）', () => {
    const ids = ENCHANTMENTS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of ENCHANTMENTS) {
      expect(e.maxLevel).toBeGreaterThanOrEqual(1)
      expect(e.maxLevel).toBeLessThanOrEqual(5)
      expect(e.name.length).toBeGreaterThan(0)
    }
  })

  it('1.21 重锤专属附魔带 isNew121 标记', () => {
    for (const id of ['density', 'breach', 'wind_burst']) {
      expect(getEnchantmentById(id)?.isNew121).toBe(true)
    }
  })
})

describe('罗马数字（maxLevelRoman）', () => {
  it('1-10 转罗马数字，超出返回原数字', () => {
    expect(toRoman(1)).toBe('I')
    expect(toRoman(2)).toBe('II')
    expect(toRoman(3)).toBe('III')
    expect(toRoman(4)).toBe('IV')
    expect(toRoman(5)).toBe('V')
    expect(toRoman(10)).toBe('X')
    expect(toRoman(11)).toBe('11')
  })
})

describe('槽位推断 getItemSlotType（顺序敏感）', () => {
  it('剑类', () => {
    expect(getItemSlotType(item('diamond_sword'))).toBe(ItemSlotType.sword)
  })
  it('锄必须在斧之前判断（diamond_hoe 含 _hoe 不含 _axe）', () => {
    expect(getItemSlotType(item('diamond_hoe'))).toBe(ItemSlotType.hoe)
  })
  it('斧 _axe 单独判断', () => {
    expect(getItemSlotType(item('diamond_axe'))).toBe(ItemSlotType.axe)
  })
  it('精确匹配物品', () => {
    expect(getItemSlotType(item('mace'))).toBe(ItemSlotType.mace)
    expect(getItemSlotType(item('bow'))).toBe(ItemSlotType.bow)
    expect(getItemSlotType(item('crossbow'))).toBe(ItemSlotType.crossbow)
    expect(getItemSlotType(item('trident'))).toBe(ItemSlotType.trident)
    expect(getItemSlotType(item('shears'))).toBe(ItemSlotType.shears)
    expect(getItemSlotType(item('elytra'))).toBe(ItemSlotType.elytra)
    expect(getItemSlotType(item('shield'))).toBe(ItemSlotType.shield)
  })
  it('钓鱼竿与萝卜钓竿', () => {
    expect(getItemSlotType(item('fishing_rod'))).toBe(ItemSlotType.fishingRod)
    // carrot_on_a_stick 不在物品目录中，构造验证
    expect(getItemSlotType({ id: 'carrot_on_a_stick', name: 'x', category: '工具', stackSize: 1 })).toBe(
      ItemSlotType.fishingRod,
    )
  })
  it('护甲类', () => {
    expect(getItemSlotType(item('diamond_helmet'))).toBe(ItemSlotType.helmet)
    expect(getItemSlotType(item('diamond_chestplate'))).toBe(ItemSlotType.chestplate)
    expect(getItemSlotType(item('diamond_leggings'))).toBe(ItemSlotType.leggings)
    expect(getItemSlotType(item('diamond_boots'))).toBe(ItemSlotType.boots)
  })
  it('不可附魔物品返回 null', () => {
    expect(getItemSlotType(item('diamond'))).toBeNull()
    expect(getItemSlotType(item('stone'))).toBeNull()
    expect(getItemSlotType(item('bread'))).toBeNull()
  })
})

describe('附魔适用与互斥', () => {
  it('鞘翅仅适用通用附魔（原版限制）', () => {
    const forElytra = getEnchantmentsForItem(item('elytra'))
    const ids = forElytra.map((e) => e.id)
    expect(ids).toContain('unbreaking')
    expect(ids).toContain('mending')
    expect(ids).not.toContain('protection')
  })

  it('不可附魔物品返回空列表', () => {
    expect(getEnchantmentsForItem(item('diamond'))).toEqual([])
  })

  it('钻石剑适用锋利与通用附魔', () => {
    const ids = getEnchantmentsForItem(item('diamond_sword')).map((e) => e.id)
    expect(ids).toContain('sharpness')
    expect(ids).toContain('unbreaking')
    expect(ids).not.toContain('density')
  })

  it('appliesToSlot：null 槽位仅通用', () => {
    const unbreaking = getEnchantmentById('unbreaking')!
    const sharpness = getEnchantmentById('sharpness')!
    expect(appliesToSlot(unbreaking, null)).toBe(true)
    expect(appliesToSlot(sharpness, null)).toBe(false)
  })

  it('互斥双向检查', () => {
    expect(areEnchantmentsConflicting('sharpness', 'smite')).toBe(true)
    expect(areEnchantmentsConflicting('smite', 'sharpness')).toBe(true)
    expect(areEnchantmentsConflicting('infinity', 'mending')).toBe(true)
    expect(areEnchantmentsConflicting('mending', 'infinity')).toBe(true)
    expect(areEnchantmentsConflicting('sharpness', 'sharpness')).toBe(false)
    expect(areEnchantmentsConflicting('sharpness', 'unbreaking')).toBe(false)
    expect(areEnchantmentsConflicting('sharpness', 'not_exist')).toBe(false)
  })

  it('isEnchantmentDisabledBy：已选冲突附魔时禁用', () => {
    expect(isEnchantmentDisabledBy('smite', ['sharpness'])).toBe(true)
    expect(isEnchantmentDisabledBy('unbreaking', ['sharpness'])).toBe(false)
    expect(isEnchantmentDisabledBy('sharpness', [])).toBe(false)
    expect(isEnchantmentDisabledBy('riptide', ['loyalty', 'channeling'])).toBe(true)
  })
})

describe('MC 版本判定（NBT 三格式）', () => {
  it('supportsDataComponents：1.20.5+ 支持', () => {
    expect(supportsDataComponents('1.20.4')).toBe(false)
    expect(supportsDataComponents('1.20')).toBe(false)
    expect(supportsDataComponents('1.19.2')).toBe(false)
    expect(supportsDataComponents('1.20.5')).toBe(true)
    expect(supportsDataComponents('1.21')).toBe(true)
    expect(supportsDataComponents('1.21.4')).toBe(true)
    expect(supportsDataComponents('26.1')).toBe(true)
    expect(supportsDataComponents('')).toBe(true) // 无法解析按新版
    expect(supportsDataComponents('abc')).toBe(true)
  })

  it('usesDirectEnchantmentMap：1.21.2+ 直接映射', () => {
    expect(usesDirectEnchantmentMap('1.20.5')).toBe(false)
    expect(usesDirectEnchantmentMap('1.21')).toBe(false)
    expect(usesDirectEnchantmentMap('1.21.1')).toBe(false)
    expect(usesDirectEnchantmentMap('1.21.2')).toBe(true)
    expect(usesDirectEnchantmentMap('1.21.4')).toBe(true)
    expect(usesDirectEnchantmentMap('1.22')).toBe(true)
    expect(usesDirectEnchantmentMap('26.2')).toBe(true)
    expect(usesDirectEnchantmentMap('2.0')).toBe(true)
    expect(usesDirectEnchantmentMap('')).toBe(true) // 无法解析按新版
  })

  it('isMc26：26.x 裸 SNBT', () => {
    expect(isMc26('26.1')).toBe(true)
    expect(isMc26('26.2')).toBe(true)
    expect(isMc26('26')).toBe(true)
    expect(isMc26('1.21.4')).toBe(false)
    expect(isMc26('2.0')).toBe(false)
    expect(isMc26('')).toBe(true) // 无法解析按新版
    expect(isMc26('abc')).toBe(true)
  })
})

describe('buildGiveCommand', () => {
  it('普通物品无前导 /', () => {
    expect(buildGiveCommand({ playerName: 'Steve', item: item('diamond'), count: 64 })).toBe(
      'give Steve minecraft:diamond 64',
    )
  })

  it('1.21.2+（含 26.x）直接映射格式', () => {
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: item('diamond_sword'),
      count: 1,
      enchants: { sharpness: 5, unbreaking: 3 },
      mcVersion: '1.21.4',
    })
    expect(cmd).toBe(
      'give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5,"minecraft:unbreaking":3}] 1',
    )
    const cmd26 = buildGiveCommand({
      playerName: 'Steve',
      item: item('diamond_sword'),
      count: 1,
      enchants: { sharpness: 5 },
      mcVersion: '26.2',
    })
    expect(cmd26).toBe('give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5}] 1')
  })

  it('1.20.5 - 1.21.1 levels 包装格式', () => {
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: item('diamond_sword'),
      count: 1,
      enchants: { sharpness: 5, unbreaking: 3 },
      mcVersion: '1.21.1',
    })
    expect(cmd).toBe(
      'give Steve minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5,"minecraft:unbreaking":3}}] 1',
    )
  })

  it('1.20.4 及以下旧 NBT 格式', () => {
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: item('diamond_sword'),
      count: 1,
      enchants: { sharpness: 5, unbreaking: 3 },
      mcVersion: '1.20.4',
    })
    expect(cmd).toBe(
      'give Steve minecraft:diamond_sword{ench:[{id:"minecraft:sharpness",lvl:5},{id:"minecraft:unbreaking",lvl:3}]} 1',
    )
  })

  it('空版本按新版（Data Components 直接映射）处理', () => {
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: item('diamond_sword'),
      count: 2,
      enchants: { sharpness: 1 },
    })
    expect(cmd).toBe('give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":1}] 2')
  })

  it('附魔映射空时不追加组件', () => {
    expect(
      buildGiveCommand({ playerName: 'Steve', item: item('diamond_sword'), count: 1, enchants: {}, mcVersion: '1.21.4' }),
    ).toBe('give Steve minecraft:diamond_sword 1')
  })
})

describe('药水组件（buildPotionComponents）', () => {
  it('26.x custom_name 裸 SNBT 文本组件', () => {
    const components = buildPotionComponents(potionConfig({}), '26.2')
    expect(components).toBe(
      '[custom_name={text:"力量药水 II"},potion_contents={custom_effects:[{id:"minecraft:strength",amplifier:1,duration:1800}],custom_color:9643043}]',
    )
  })

  it('1.20.5 - 1.21.x custom_name JSON 字符串形式', () => {
    const components = buildPotionComponents(potionConfig({}), '1.21.1')
    expect(components).toContain(`custom_name='{"text":"力量药水 II"}'`)
  })

  it('瞬时效果 duration 固定 1 tick', () => {
    const instant = MINECRAFT_POTIONS.find((p) => p.effectId === 'instant_health')!
    const components = buildPotionComponents(
      potionConfig({ effect: instant, duration: 9999, level: 1 }),
      '1.21.4',
    )
    expect(components).toContain('duration:1')
  })

  it('amplifier = level - 1', () => {
    const components = buildPotionComponents(potionConfig({ level: 3 }), '1.21.4')
    expect(components).toContain('amplifier:2')
  })
})

describe('药水 give 命令', () => {
  it('瓶型决定物品 ID（喷溅药水替换效果 id）', () => {
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: item('potion'),
      count: 1,
      potion: potionConfig({ bottle: POTION_BOTTLE_TYPES[1] }),
      mcVersion: '1.21.4',
    })
    expect(cmd.startsWith('give Steve minecraft:splash_potion[')).toBe(true)
  })

  it('药水要求 1.20.5+，旧版抛错', () => {
    expect(() =>
      buildGiveCommand({
        playerName: 'Steve',
        item: item('potion'),
        count: 1,
        potion: potionConfig({}),
        mcVersion: '1.20.4',
      }),
    ).toThrow('药水物品需要 MC 1.20.5+（Data Components）')
  })

  it('自定义等级 III 显示「（自定义）」标注', () => {
    const cmd = buildGiveCommand({
      playerName: 'Steve',
      item: item('potion'),
      count: 1,
      potion: potionConfig({ level: 3, bottle: POTION_BOTTLE_TYPES[0] }),
      mcVersion: '26.2',
    })
    expect(cmd).toContain('力量药水 III（自定义）')
  })
})
