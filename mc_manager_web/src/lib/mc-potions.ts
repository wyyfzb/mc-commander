/**
 * Minecraft 效果药水数据模型与目录（20 种）
 * 基于 MC Data Components（1.20.5+）的 potion_contents.custom_effects 组件：
 * 可给任意效果、任意等级（I-V）、任意时长，并通过 custom_name 显示友好名称。
 *
 * 设计遵循原版实际：
 * - vanillaMaxLevel（1=夜视/隐身等无强效版，2=力量/剧毒等）为原版等级上限
 * - 等级可超过原版上限（技术允许），超出的标注「自定义效果」
 * - 时长档位优先使用原版各等级标准时长（普通/强效/长时），自定义等级（III+）用通用档
 * - 瞬时效果（治疗/伤害）无时长概念，饮用即刻生效（命令中 duration 固定 1 tick）
 */

/** 药水时长档位 */
export interface PotionDurationOption {
  /** 显示标签，如「普通 3:00」「长时 8:00」「强效 1:30」「30秒」 */
  label: string
  /** 时长（tick，20 tick = 1 秒） */
  ticks: number
}

/** 单个效果药水的元数据 */
export interface PotionEffect {
  /** 效果 ID（无命名空间），如 "swiftness" */
  effectId: string
  /** 中文效果名，如 "迅捷" */
  name: string
  /** 药水颜色（RGB 整数，对应 custom_color 组件），取自原版效果粒子色 */
  color: number
  /** 原版等级上限（1 或 2）。等级 > 该值视为「自定义效果」 */
  vanillaMaxLevel: number
  /** 是否瞬时效果（治疗/伤害），饮用即刻生效，无时长 */
  isInstant: boolean
  /** 等级 I（原版普通）的时长档位 */
  level1Durations: PotionDurationOption[]
  /** 等级 II（原版强效）的时长档位。无强效版的效果为空数组 */
  level2Durations: PotionDurationOption[]
}

/** 自定义等级（超过原版上限，III+）的通用时长档位 */
export const CUSTOM_LEVEL_DURATIONS: PotionDurationOption[] = [
  { label: '30秒', ticks: 600 },
  { label: '1分钟', ticks: 1200 },
  { label: '3分钟', ticks: 3600 },
  { label: '8分钟', ticks: 9600 },
]

/**
 * 获取指定等级的时长选项。
 * - 等级 I：原版普通档位
 * - 等级 II（原版有强效版）：原版强效档位
 * - 自定义等级（> vanillaMaxLevel）：通用档位
 * - 瞬时效果：无时长选项
 */
export function durationsForLevel(effect: PotionEffect, level: number): PotionDurationOption[] {
  if (effect.isInstant) return []
  if (level === 1) return effect.level1Durations
  if (level === 2 && effect.vanillaMaxLevel >= 2) return effect.level2Durations
  return CUSTOM_LEVEL_DURATIONS
}

/** 药水瓶型定义 */
export interface PotionBottleType {
  /** 物品 ID（无命名空间），如 "splash_potion" */
  itemId: string
  /** 中文瓶型名，如 "喷溅" */
  name: string
  /** 药水显示名前缀（喷溅/滞留），饮用无前缀 */
  namePrefix: string
}

/** 瓶型全名（含 minecraft: 前缀） */
export function fullBottleId(bottle: PotionBottleType): string {
  return `minecraft:${bottle.itemId}`
}

/** 可选瓶型：饮用 / 喷溅 / 滞留 */
export const POTION_BOTTLE_TYPES: PotionBottleType[] = [
  { itemId: 'potion', name: '饮用药水', namePrefix: '' },
  { itemId: 'splash_potion', name: '喷溅药水', namePrefix: '喷溅' },
  { itemId: 'lingering_potion', name: '滞留药水', namePrefix: '滞留' },
]

/** 等级罗马数字（I-V） */
export const POTION_LEVEL_ROMAN = ['I', 'II', 'III', 'IV', 'V'] as const

/** 等级上限（UI 可选范围，可超过原版上限，超出的标注「自定义效果」） */
export const POTION_MAX_LEVEL = 5

/** 选中药水后的完整配置 */
export interface PotionConfig {
  effect: PotionEffect
  bottle: PotionBottleType
  /** 等级 1-5 */
  level: number
  /** 时长（tick；瞬时效果固定 1） */
  duration: number
}

/** 是否自定义等级（超过原版上限） */
export function isCustomPotionLevel(config: PotionConfig): boolean {
  return config.level > config.effect.vanillaMaxLevel
}

/** 等级显示文案：原版等级直接显示罗马数字，自定义等级加「自定义」标注 */
export function potionLevelLabel(config: PotionConfig): string {
  const roman = POTION_LEVEL_ROMAN[config.level - 1] ?? String(config.level)
  return isCustomPotionLevel(config) ? `${roman}（自定义）` : roman
}

/**
 * 药水成品显示名称，写明效果名 + 等级。
 * 如：力量药水 / 力量药水 II / 剧毒药水 III（自定义）
 */
export function potionDisplayName(config: PotionConfig): string {
  const prefix = config.bottle.namePrefix
  const levelText =
    config.level > 1 ? ` ${POTION_LEVEL_ROMAN[config.level - 1] ?? config.level}` : ''
  const customText = isCustomPotionLevel(config) ? '（自定义）' : ''
  return `${prefix}${config.effect.name}药水${levelText}${customText}`
}

/** 常用效果药水目录（覆盖 MC 主流效果 + 1.21 新效果） */
export const MINECRAFT_POTIONS: PotionEffect[] = [
  // ── 正向增益效果（原版可酿造）──
  {
    effectId: 'swiftness',
    name: '迅捷',
    color: 0x7cafc6,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [{ label: '强效 1:30', ticks: 1800 }],
  },
  {
    effectId: 'strength',
    name: '力量',
    color: 0x932423,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [{ label: '强效 1:30', ticks: 1800 }],
  },
  {
    effectId: 'instant_health',
    name: '治疗',
    color: 0xf82423,
    vanillaMaxLevel: 2,
    isInstant: true,
    level1Durations: [],
    level2Durations: [],
  },
  {
    effectId: 'jump_boost',
    name: '跳跃提升',
    color: 0x22ff4c,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [{ label: '强效 1:30', ticks: 1800 }],
  },
  {
    effectId: 'regeneration',
    name: '再生',
    color: 0xcd5cab,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 0:45', ticks: 900 },
      { label: '长时 2:00', ticks: 2400 },
    ],
    level2Durations: [{ label: '强效 0:22', ticks: 440 }],
  },
  {
    effectId: 'night_vision',
    name: '夜视',
    color: 0x1f1fa1,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [],
  },
  {
    effectId: 'invisibility',
    name: '隐身',
    color: 0x7f8392,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [],
  },
  {
    effectId: 'fire_resistance',
    name: '抗火',
    color: 0xe49a3a,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [],
  },
  {
    effectId: 'water_breathing',
    name: '水下呼吸',
    color: 0x2e5299,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [
      { label: '普通 3:00', ticks: 3600 },
      { label: '长时 8:00', ticks: 9600 },
    ],
    level2Durations: [],
  },
  {
    effectId: 'luck',
    name: '幸运',
    color: 0x339900,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [{ label: '普通 5:00', ticks: 6000 }],
    level2Durations: [],
  },
  {
    effectId: 'slow_falling',
    name: '缓降',
    color: 0xf7f7d0,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [
      { label: '普通 1:30', ticks: 1800 },
      { label: '长时 4:00', ticks: 4800 },
    ],
    level2Durations: [],
  },
  // ── 负面效果（原版可酿造）──
  {
    effectId: 'slowness',
    name: '缓慢',
    color: 0x5a6c81,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 1:30', ticks: 1800 },
      { label: '长时 4:00', ticks: 4800 },
    ],
    level2Durations: [{ label: '强效 0:15', ticks: 300 }],
  },
  {
    effectId: 'instant_damage',
    name: '伤害',
    color: 0x430a09,
    vanillaMaxLevel: 2,
    isInstant: true,
    level1Durations: [],
    level2Durations: [],
  },
  {
    effectId: 'weakness',
    name: '虚弱',
    color: 0x484d48,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [
      { label: '普通 1:30', ticks: 1800 },
      { label: '长时 4:00', ticks: 4800 },
    ],
    level2Durations: [],
  },
  {
    effectId: 'poison',
    name: '剧毒',
    color: 0x4e9331,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 0:45', ticks: 900 },
      { label: '长时 2:00', ticks: 2400 },
    ],
    level2Durations: [{ label: '强效 0:21', ticks: 420 }],
  },
  {
    effectId: 'turtle_master',
    name: '龟甲',
    color: 0x3a5f4e,
    vanillaMaxLevel: 2,
    isInstant: false,
    level1Durations: [
      { label: '普通 0:20', ticks: 400 },
      { label: '长时 0:40', ticks: 800 },
    ],
    level2Durations: [{ label: '强效 0:20', ticks: 400 }],
  },
  // ── 1.21 新效果（原版仅 I 级）──
  {
    effectId: 'infested',
    name: '寄生',
    color: 0x8e9a1f,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [{ label: '普通 3:00', ticks: 3600 }],
    level2Durations: [],
  },
  {
    effectId: 'oozing',
    name: '渗浆',
    color: 0xb3d9a1,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [{ label: '普通 3:00', ticks: 3600 }],
    level2Durations: [],
  },
  {
    effectId: 'weaving',
    name: '编织',
    color: 0xe0d8f4,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [{ label: '普通 3:00', ticks: 3600 }],
    level2Durations: [],
  },
  {
    effectId: 'wind_charged',
    name: '风袭',
    color: 0x7c8b9e,
    vanillaMaxLevel: 1,
    isInstant: false,
    level1Durations: [{ label: '普通 3:00', ticks: 3600 }],
    level2Durations: [],
  },
]
