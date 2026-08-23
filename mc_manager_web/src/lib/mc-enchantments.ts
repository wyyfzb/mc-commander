/**
 * Minecraft 附魔数据模型与目录（42 种）
 * 覆盖 MC 1.20.5 – 26.2+（Data Components 时代）。26.x 未新增附魔，列表与 1.21 一致。
 * 互斥规则严格遵循原版实现（conflicts 字段，单向声明即可，过滤时双向检查）。
 *
 * 命令格式随版本自适应（1.20.5+ Data Components）：
 *   1.21.2+（含 26.x）: give <player> minecraft:<id>[enchantments={"minecraft:sharpness":5}] <count>
 *   1.20.5 - 1.21.1  : give <player> minecraft:<id>[enchantments={levels:{"minecraft:sharpness":5}}] <count>
 *   1.20.4 及以下    : give <player> minecraft:<id>{ench:[{id:"minecraft:sharpness",lvl:5}]} <count>
 */
import type { MinecraftItem } from './mc-items'
import type { PotionConfig } from './mc-potions'
import { fullBottleId, potionDisplayName } from './mc-potions'

/** 物品槽位类型，用于附魔适用性过滤（erasableSyntaxOnly 禁 enum，用 const 对象 + 字面量类型） */
export const ItemSlotType = {
  /** 剑 */
  sword: 'sword',
  /** 重锤（1.21+） */
  mace: 'mace',
  /** 弓 */
  bow: 'bow',
  /** 弩 */
  crossbow: 'crossbow',
  /** 三叉戟 */
  trident: 'trident',
  /** 镐 */
  pickaxe: 'pickaxe',
  /** 斧 */
  axe: 'axe',
  /** 锹 */
  shovel: 'shovel',
  /** 锄 */
  hoe: 'hoe',
  /** 钓鱼竿 */
  fishingRod: 'fishingRod',
  /** 剪刀 */
  shears: 'shears',
  /** 盾牌 */
  shield: 'shield',
  /** 鞘翅 */
  elytra: 'elytra',
  /** 头盔 */
  helmet: 'helmet',
  /** 胸甲 */
  chestplate: 'chestplate',
  /** 护腿 */
  leggings: 'leggings',
  /** 靴子 */
  boots: 'boots',
  /** 通用（所有可附魔物品） */
  all: 'all',
} as const
export type ItemSlotType = (typeof ItemSlotType)[keyof typeof ItemSlotType]

/** 单条附魔定义 */
export interface Enchantment {
  /** 游戏 ID（不含 minecraft: 前缀），如 "sharpness" */
  id: string
  /** 中文显示名，如 "锋利" */
  name: string
  /** 最大等级，如 5 表示最高 V 级 */
  maxLevel: number
  /** 适用物品类型列表；含 all 表示通用附魔 */
  appliesTo: ItemSlotType[]
  /** 互斥附魔 ID 列表（单向声明即可，过滤时会双向检查） */
  conflicts?: string[]
  /** 是否为 1.21+ 新增附魔（重锤专属：致密/破甲/风爆）。UI 上需标注 "1.21+" 徽章 */
  isNew121?: boolean
}

/** 全名（含 minecraft: 前缀），用于命令生成 */
export function fullEnchantmentId(id: string): string {
  return `minecraft:${id}`
}

/** 将阿拉伯数字转为罗马数字（仅支持 1-10，超出返回原数字） */
export function toRoman(n: number): string {
  const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
  if (n < 1 || n > 10) return String(n)
  return romans[n - 1] ?? String(n)
}

/**
 * 判断该附魔是否适用于指定槽位类型。
 * 通用附魔（appliesTo 含 all）对所有类型适用。
 * 鞘翅仅适用通用附魔（原版限制）。
 */
export function appliesToSlot(enchantment: Enchantment, slot: ItemSlotType | null): boolean {
  if (slot === null) return enchantment.appliesTo.includes(ItemSlotType.all)
  if (slot === ItemSlotType.elytra) {
    return enchantment.appliesTo.includes(ItemSlotType.all)
  }
  return enchantment.appliesTo.includes(slot) || enchantment.appliesTo.includes(ItemSlotType.all)
}

/** 全部 42 种附魔（按类别组织：武器 → 工具 → 护甲 → 通用） */
export const ENCHANTMENTS: Enchantment[] = [
  // ── 武器附魔 ──────────────────────────────────────────────
  {
    id: 'sharpness',
    name: '锋利',
    maxLevel: 5,
    appliesTo: [ItemSlotType.sword, ItemSlotType.axe],
    conflicts: ['smite', 'bane_of_arthropods'],
  },
  {
    id: 'smite',
    name: '亡灵杀手',
    maxLevel: 5,
    appliesTo: [ItemSlotType.sword, ItemSlotType.axe],
    conflicts: ['sharpness', 'bane_of_arthropods'],
  },
  {
    id: 'bane_of_arthropods',
    name: '节肢杀手',
    maxLevel: 5,
    appliesTo: [ItemSlotType.sword, ItemSlotType.axe],
    conflicts: ['sharpness', 'smite'],
  },
  { id: 'knockback', name: '击退', maxLevel: 2, appliesTo: [ItemSlotType.sword] },
  { id: 'fire_aspect', name: '火焰附加', maxLevel: 2, appliesTo: [ItemSlotType.sword] },
  { id: 'looting', name: '抢夺', maxLevel: 3, appliesTo: [ItemSlotType.sword] },
  { id: 'sweeping_edge', name: '横扫之刃', maxLevel: 3, appliesTo: [ItemSlotType.sword] },
  // 1.21 重锤专属附魔
  { id: 'density', name: '致密', maxLevel: 5, appliesTo: [ItemSlotType.mace], isNew121: true },
  { id: 'breach', name: '破甲', maxLevel: 4, appliesTo: [ItemSlotType.mace], isNew121: true },
  { id: 'wind_burst', name: '风爆', maxLevel: 3, appliesTo: [ItemSlotType.mace], isNew121: true },
  // 三叉戟
  { id: 'impaling', name: '穿刺', maxLevel: 5, appliesTo: [ItemSlotType.trident] },
  {
    id: 'loyalty',
    name: '忠诚',
    maxLevel: 3,
    appliesTo: [ItemSlotType.trident],
    conflicts: ['riptide'],
  },
  {
    id: 'riptide',
    name: '激流',
    maxLevel: 3,
    appliesTo: [ItemSlotType.trident],
    conflicts: ['loyalty', 'channeling'],
  },
  {
    id: 'channeling',
    name: '引雷',
    maxLevel: 1,
    appliesTo: [ItemSlotType.trident],
    conflicts: ['riptide'],
  },
  // 弓
  { id: 'power', name: '力量', maxLevel: 5, appliesTo: [ItemSlotType.bow] },
  { id: 'punch', name: '冲击', maxLevel: 2, appliesTo: [ItemSlotType.bow] },
  { id: 'flame', name: '火矢', maxLevel: 1, appliesTo: [ItemSlotType.bow] },
  {
    id: 'infinity',
    name: '无限',
    maxLevel: 1,
    appliesTo: [ItemSlotType.bow],
    conflicts: ['mending'],
  },
  // 弩
  {
    id: 'multishot',
    name: '多重射击',
    maxLevel: 1,
    appliesTo: [ItemSlotType.crossbow],
    conflicts: ['piercing'],
  },
  {
    id: 'piercing',
    name: '穿透',
    maxLevel: 4,
    appliesTo: [ItemSlotType.crossbow],
    conflicts: ['multishot'],
  },
  { id: 'quick_charge', name: '快速装填', maxLevel: 3, appliesTo: [ItemSlotType.crossbow] },

  // ── 工具附魔 ──────────────────────────────────────────────
  {
    id: 'efficiency',
    name: '效率',
    maxLevel: 5,
    appliesTo: [
      ItemSlotType.pickaxe,
      ItemSlotType.axe,
      ItemSlotType.shovel,
      ItemSlotType.hoe,
      ItemSlotType.shears,
    ],
  },
  {
    id: 'silk_touch',
    name: '精准采集',
    maxLevel: 1,
    appliesTo: [ItemSlotType.pickaxe, ItemSlotType.axe, ItemSlotType.shovel, ItemSlotType.hoe],
    conflicts: ['fortune'],
  },
  {
    id: 'fortune',
    name: '时运',
    maxLevel: 3,
    appliesTo: [ItemSlotType.pickaxe, ItemSlotType.axe, ItemSlotType.shovel, ItemSlotType.hoe],
    conflicts: ['silk_touch'],
  },
  { id: 'lure', name: '饵钓', maxLevel: 3, appliesTo: [ItemSlotType.fishingRod] },
  { id: 'luck_of_the_sea', name: '海之眷顾', maxLevel: 3, appliesTo: [ItemSlotType.fishingRod] },

  // ── 护甲附魔 ──────────────────────────────────────────────
  {
    id: 'protection',
    name: '保护',
    maxLevel: 4,
    appliesTo: [
      ItemSlotType.helmet,
      ItemSlotType.chestplate,
      ItemSlotType.leggings,
      ItemSlotType.boots,
    ],
    conflicts: ['fire_protection', 'blast_protection', 'projectile_protection'],
  },
  {
    id: 'fire_protection',
    name: '火焰保护',
    maxLevel: 4,
    appliesTo: [
      ItemSlotType.helmet,
      ItemSlotType.chestplate,
      ItemSlotType.leggings,
      ItemSlotType.boots,
    ],
    conflicts: ['protection', 'blast_protection', 'projectile_protection'],
  },
  {
    id: 'blast_protection',
    name: '爆炸保护',
    maxLevel: 4,
    appliesTo: [
      ItemSlotType.helmet,
      ItemSlotType.chestplate,
      ItemSlotType.leggings,
      ItemSlotType.boots,
    ],
    conflicts: ['protection', 'fire_protection', 'projectile_protection'],
  },
  {
    id: 'projectile_protection',
    name: '弹射物保护',
    maxLevel: 4,
    appliesTo: [
      ItemSlotType.helmet,
      ItemSlotType.chestplate,
      ItemSlotType.leggings,
      ItemSlotType.boots,
    ],
    conflicts: ['protection', 'fire_protection', 'blast_protection'],
  },
  { id: 'feather_falling', name: '摔落保护', maxLevel: 4, appliesTo: [ItemSlotType.boots] },
  {
    id: 'thorns',
    name: '荆棘',
    maxLevel: 3,
    appliesTo: [
      ItemSlotType.chestplate,
      ItemSlotType.helmet,
      ItemSlotType.leggings,
      ItemSlotType.boots,
    ],
  },
  { id: 'respiration', name: '水下呼吸', maxLevel: 3, appliesTo: [ItemSlotType.helmet] },
  { id: 'aqua_affinity', name: '水下速掘', maxLevel: 1, appliesTo: [ItemSlotType.helmet] },
  {
    id: 'depth_strider',
    name: '深海探索者',
    maxLevel: 3,
    appliesTo: [ItemSlotType.boots],
    conflicts: ['frost_walker'],
  },
  {
    id: 'frost_walker',
    name: '冰霜行者',
    maxLevel: 2,
    appliesTo: [ItemSlotType.boots],
    conflicts: ['depth_strider'],
  },
  { id: 'soul_speed', name: '灵魂疾行', maxLevel: 3, appliesTo: [ItemSlotType.boots] },
  { id: 'swift_sneak', name: '迅捷潜行', maxLevel: 3, appliesTo: [ItemSlotType.leggings] },

  // ── 通用附魔 ──────────────────────────────────────────────
  { id: 'unbreaking', name: '耐久', maxLevel: 3, appliesTo: [ItemSlotType.all] },
  {
    id: 'mending',
    name: '经验修补',
    maxLevel: 1,
    appliesTo: [ItemSlotType.all],
    conflicts: ['infinity'],
  },
  {
    id: 'binding_curse',
    name: '绑定诅咒',
    maxLevel: 1,
    appliesTo: [
      ItemSlotType.helmet,
      ItemSlotType.chestplate,
      ItemSlotType.leggings,
      ItemSlotType.boots,
    ],
  },
  { id: 'vanishing_curse', name: '消失诅咒', maxLevel: 1, appliesTo: [ItemSlotType.all] },
]

/**
 * 根据物品 id 推断物品槽位类型。
 * 返回 null 表示该物品不可附魔（如方块、资源、食物等）。
 *
 * 注意顺序：先匹配更具体的类型，避免被通配规则误判。
 * 例如 "diamond_sword" 必须先匹配 sword，不能被后面的 _axe 规则误伤。
 */
export function getItemSlotType(item: MinecraftItem): ItemSlotType | null {
  const id = item.id

  if (id.includes('sword')) return ItemSlotType.sword
  if (id === 'mace') return ItemSlotType.mace
  if (id === 'bow') return ItemSlotType.bow
  if (id === 'crossbow') return ItemSlotType.crossbow
  if (id === 'trident') return ItemSlotType.trident
  if (id.includes('pickaxe')) return ItemSlotType.pickaxe
  // _hoe 必须在 _axe 之前判断（"diamond_hoe" 含 "_hoe" 但不含 "_axe"）
  if (id.includes('_hoe')) return ItemSlotType.hoe
  if (id.includes('shovel')) return ItemSlotType.shovel
  // _axe 单独判断（避免被 sword 等误伤；"axe" 子串只在斧类物品中出现）
  if (id.includes('_axe')) return ItemSlotType.axe
  if (id === 'fishing_rod' || id === 'carrot_on_a_stick') {
    return ItemSlotType.fishingRod
  }
  if (id === 'shears') return ItemSlotType.shears
  if (id === 'elytra') return ItemSlotType.elytra
  if (id === 'shield') return ItemSlotType.shield
  if (id.includes('helmet')) return ItemSlotType.helmet
  if (id.includes('chestplate')) return ItemSlotType.chestplate
  if (id.includes('leggings')) return ItemSlotType.leggings
  if (id.includes('boots')) return ItemSlotType.boots

  return null
}

/** 根据附魔 ID 查找附魔定义 */
export function getEnchantmentById(id: string): Enchantment | undefined {
  return ENCHANTMENTS.find((e) => e.id === id)
}

/**
 * 返回指定物品可用的附魔列表。
 * 不可附魔物品（槽位类型为 null）返回空列表。
 * 鞘翅仅返回通用附魔（原版限制）。
 */
export function getEnchantmentsForItem(item: MinecraftItem): Enchantment[] {
  const slot = getItemSlotType(item)
  if (slot === null) return []
  return ENCHANTMENTS.filter((e) => appliesToSlot(e, slot))
}

/** 判断两个附魔是否互斥（双向检查 conflicts 字段） */
export function areEnchantmentsConflicting(idA: string, idB: string): boolean {
  if (idA === idB) return false // 同一附魔不算互斥
  const a = getEnchantmentById(idA)
  const b = getEnchantmentById(idB)
  if (!a || !b) return false
  return (a.conflicts ?? []).includes(idB) || (b.conflicts ?? []).includes(idA)
}

/** 给定已选附魔列表，判断某附魔是否因互斥而应被禁用 */
export function isEnchantmentDisabledBy(candidateId: string, selectedIds: Iterable<string>): boolean {
  for (const selected of selectedIds) {
    if (areEnchantmentsConflicting(candidateId, selected)) return true
  }
  return false
}

// ── MC 版本判定（NBT 三格式自适应）──────────────────────────

/** 解析版本号为主/次/修订三元组；无法解析的段返回 null */
function parseVersion(mcVersion: string): { major: number | null; minor: number | null; patch: number | null } {
  const parts = mcVersion.split('.')
  return {
    major: parts.length > 0 ? Number.parseInt(parts[0]!, 10) : null,
    minor: parts.length > 1 ? Number.parseInt(parts[1]!, 10) : null,
    patch: parts.length > 2 ? Number.parseInt(parts[2]!, 10) : null,
  }
}

/**
 * 判断 MC 版本是否支持 Data Components（1.20.5+）。
 * 1.20.5 引入物品堆叠组件，附魔从旧 NBT `{ench:[{id,lvl}]}`
 * 迁移到 `[enchantments={...}]`。1.20.4 及以下仅支持 NBT 格式。
 * 版本字符串无法解析时假设新版（Data Components），因当前主流为 1.21+。
 */
export function supportsDataComponents(mcVersion: string): boolean {
  const { major, minor, patch } = parseVersion(mcVersion)
  if (major === null || minor === null) return true
  if (Number.isNaN(major) || Number.isNaN(minor)) return true
  if (major > 1) return true
  if (major < 1) return false
  if (minor > 20) return true
  if (minor < 20) return false
  const patchNum = patch ?? 0
  return patchNum >= 5
}

/**
 * 判断附魔组件是否使用直接映射格式（无 levels 包装层）。
 * MC 1.21.2+（含 26.x 新版）简化了 enchantments 组件结构，
 * 从 `{levels:{"minecraft:sharpness":5}}` 改为直接映射 `{"minecraft:sharpness":5}`。
 * 1.20.5 - 1.21.1 仍使用带 levels 包装层的旧格式。
 * 版本字符串无法解析时假设新版（直接映射），因当前主流为 1.21.2+。
 */
export function usesDirectEnchantmentMap(mcVersion: string): boolean {
  const { major, minor, patch } = parseVersion(mcVersion)
  if (major === null || minor === null) return true
  if (Number.isNaN(major) || Number.isNaN(minor)) return true
  if (major > 1) return true // 2.x+ / 26.x+ → 直接映射
  if (major < 1) return false
  if (minor > 21) return true // 1.22+ → 直接映射
  if (minor < 21) return false // 1.20.x → 旧格式（levels 包装层）
  // minor == 21
  const patchNum = patch ?? 0
  return patchNum >= 2 // 1.21.2+ → 直接映射，1.21.0-1.21.1 → 旧格式
}

/**
 * 判断 MC 版本是否为 26.x（新版版本号体系）。
 * 26.x 起命令中的文本组件（如 custom_name）支持裸 SNBT 形式 `{text:"..."}`，
 * 而 1.20.5 ~ 1.21.x 需用 JSON 字符串形式 `'{"text":"..."}'`。
 * 版本无法解析时假设新版（26.x）。
 */
export function isMc26(mcVersion: string): boolean {
  const { major } = parseVersion(mcVersion)
  if (major === null) return true
  return Number.isNaN(major) || major >= 26
}

// ── give 命令生成 ──────────────────────────────────────────

export interface GiveCommandParams {
  /** 目标玩家名 */
  playerName: string
  /** 物品定义（提供 id） */
  item: MinecraftItem
  /** 数量（已由调用方按 stackSize 限制） */
  count: number
  /** 附魔映射，key 为附魔 ID（不含前缀），value 为等级（1-maxLevel） */
  enchants?: Record<string, number>
  /** 药水配置；非空时生成药水组件（potion_contents + custom_name），与附魔互斥 */
  potion?: PotionConfig | null
  /** MC 服务端版本（如 "1.20.5"、"1.21"、"26.2"），空字符串按新版处理 */
  mcVersion?: string
}

/**
 * 构建药水的 Data Components 组件（custom_name + potion_contents）。
 * 26.x：custom_name 用裸 SNBT 文本组件 `{text:"名称"}`（26.2 有效）；
 * 1.20.5 - 1.21.x：用 JSON 字符串 `'{"text":"名称"}'`。
 * 效果通过 potion_contents.custom_effects 指定，amplifier = 等级-1。
 */
export function buildPotionComponents(potion: PotionConfig, mcVersion: string): string {
  const effect = potion.effect
  const amplifier = potion.level - 1
  // 瞬时效果 duration 固定 1 tick（即刻生效）；其余用配置时长
  const duration = effect.isInstant ? 1 : potion.duration
  const name = potionDisplayName(potion)

  const customName = isMc26(mcVersion) ? `{text:"${name}"}` : `'{"text":"${name}"}'`

  return `[custom_name=${customName},potion_contents={custom_effects:[{id:"minecraft:${effect.effectId}",amplifier:${amplifier},duration:${duration}}],custom_color:${effect.color}}]`
}

/**
 * 生成 give 命令，附魔格式随 MC 版本自适应。
 *
 * 1.21.2+（含 26.x）示例（直接映射，无 levels 包装层）：
 *   give Steve minecraft:diamond_sword[enchantments={"minecraft:sharpness":5,"minecraft:unbreaking":3}] 1
 * 1.20.5 - 1.21.1 示例（带 levels 包装层）：
 *   give Steve minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5,"minecraft:unbreaking":3}}] 1
 * 1.20.4 及以下（旧 NBT）示例：
 *   give Steve minecraft:diamond_sword{ench:[{id:"minecraft:sharpness",lvl:5},{id:"minecraft:unbreaking",lvl:3}]} 1
 *
 * 注意：MC 服务器控制台/RCON 不接受 `/` 前缀（`/` 仅用于玩家聊天框），
 * 因此本函数生成的命令**不带前导 `/`**。
 */
export function buildGiveCommand(params: GiveCommandParams): string {
  const { playerName, item, count, mcVersion = '' } = params
  const enchants = params.enchants ?? {}
  const potion = params.potion ?? null

  // 药水物品 ID 由瓶型决定（minecraft:potion / splash_potion / lingering_potion），
  // 而非效果 id（UI 中效果药水用效果 id 作为虚拟 MinecraftItem）
  const itemId = potion !== null ? fullBottleId(potion.bottle) : `minecraft:${item.id}`
  let buf = `give ${playerName} ${itemId}`

  // 药水组件：potion_contents（custom_effects 自定义效果）+ custom_name（写明效果）。
  // 需要 Data Components（1.20.5+），旧版无法表示效果药水。
  if (potion !== null) {
    if (!supportsDataComponents(mcVersion)) {
      throw new Error('药水物品需要 MC 1.20.5+（Data Components）')
    }
    buf += buildPotionComponents(potion, mcVersion)
  }

  // 附魔组件：格式随版本自适应，保留对 1.20.4 及以下旧版的兼容
  const enchantEntries = Object.entries(enchants)
  if (enchantEntries.length > 0) {
    if (supportsDataComponents(mcVersion)) {
      // 1.20.5+ Data Components 格式
      const entries = enchantEntries.map(([k, v]) => `"minecraft:${k}":${v}`)
      if (usesDirectEnchantmentMap(mcVersion)) {
        // 1.21.2+（含 26.x）直接映射格式
        buf += `[enchantments={${entries.join(',')}}]`
      } else {
        // 1.20.5 - 1.21.1 旧格式（带 levels 包装层）
        buf += `[enchantments={levels:{${entries.join(',')}}}]`
      }
    } else {
      // 旧版 NBT 格式（1.20.4 及以下）
      const entries = enchantEntries.map(([k, v]) => `{id:"minecraft:${k}",lvl:${v}}`)
      buf += `{ench:[${entries.join(',')}]}`
    }
  }

  buf += ` ${count}`
  return buf
}
