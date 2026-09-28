/**
 * Minecraft 实体目录（/summon 命令常用实体）
 * 分类展示，每个条目为无命名空间 ID（summon 时自动加 minecraft:）
 */

export interface McEntity {
  /** 实体 ID（无命名空间前缀），如 "zombie" */
  id: string
  /** 中文显示名，如 "僵尸" */
  name: string
  /** 分类 */
  category: string
}

export const ENTITY_CATEGORIES = [
  '生物',
  '敌对生物',
  '中立生物',
  '被动生物',
  '环境',
  '方块实体',
  '弹射物',
  '载具',
  'NPC',
] as const

/** 常用实体目录（覆盖 /summon 高频实体） */
export const MINECRAFT_ENTITIES: McEntity[] = [
  // 敌对生物
  { id: 'zombie', name: '僵尸', category: '敌对生物' },
  { id: 'skeleton', name: '骷髅', category: '敌对生物' },
  { id: 'creeper', name: '苦力怕', category: '敌对生物' },
  { id: 'spider', name: '蜘蛛', category: '敌对生物' },
  { id: 'enderman', name: '末影人', category: '敌对生物' },
  { id: 'blaze', name: '烈焰人', category: '敌对生物' },
  { id: 'ghast', name: '恶魂', category: '敌对生物' },
  { id: 'witch', name: '女巫', category: '敌对生物' },
  { id: 'slime', name: '史莱姆', category: '敌对生物' },
  { id: 'magma_cube', name: '岩浆怪', category: '敌对生物' },
  { id: 'wither_skeleton', name: '凋灵骷髅', category: '敌对生物' },
  { id: 'guardian', name: '守卫者', category: '敌对生物' },
  { id: 'elder_guardian', name: '远古守卫者', category: '敌对生物' },
  { id: 'shulker', name: '潜影贝', category: '敌对生物' },
  { id: 'phantom', name: '幻翼', category: '敌对生物' },
  { id: 'pillager', name: '掠夺者', category: '敌对生物' },
  { id: 'vindicator', name: '卫道士', category: '敌对生物' },
  { id: 'evoker', name: '唤魔者', category: '敌对生物' },
  { id: 'vex', name: '恼鬼', category: '敌对生物' },
  { id: 'ravager', name: '劫掠兽', category: '敌对生物' },
  { id: 'bogged', name: '沼骸', category: '敌对生物' },
  { id: 'breeze', name: '旋风人', category: '敌对生物' },

  // 中立生物
  { id: 'endermite', name: '末影螨', category: '中立生物' },
  { id: 'piglin_brute', name: '猪灵蛮兵', category: '中立生物' },
  { id: 'zombified_piglin', name: '僵尸猪灵', category: '中立生物' },
  { id: 'wolf', name: '狼', category: '中立生物' },
  { id: 'iron_golem', name: '铁傀儡', category: '中立生物' },
  { id: 'snow_golem', name: '雪傀儡', category: '中立生物' },
  { id: 'bee', name: '蜜蜂', category: '中立生物' },
  { id: 'dolphin', name: '海豚', category: '中立生物' },
  { id: 'panda', name: '熊猫', category: '中立生物' },
  { id: 'polar_bear', name: '北极熊', category: '中立生物' },

  // 被动生物
  { id: 'cow', name: '牛', category: '被动生物' },
  { id: 'pig', name: '猪', category: '被动生物' },
  { id: 'sheep', name: '羊', category: '被动生物' },
  { id: 'chicken', name: '鸡', category: '被动生物' },
  { id: 'rabbit', name: '兔子', category: '被动生物' },
  { id: 'villager', name: '村民', category: '被动生物' },
  { id: 'cat', name: '猫', category: '被动生物' },
  { id: 'ocelot', name: '豹猫', category: '被动生物' },
  { id: 'horse', name: '马', category: '被动生物' },
  { id: 'donkey', name: '驴', category: '被动生物' },
  { id: 'mule', name: '骡', category: '被动生物' },
  { id: 'skeleton_horse', name: '骷髅马', category: '被动生物' },
  { id: 'zombie_horse', name: '僵尸马', category: '被动生物' },
  { id: 'fox', name: '狐狸', category: '被动生物' },
  { id: 'frog', name: '青蛙', category: '被动生物' },
  { id: 'axolotl', name: '美西螈', category: '被动生物' },
  { id: 'goat', name: '山羊', category: '被动生物' },
  { id: 'armadillo', name: '犰狳', category: '被动生物' },
  { id: 'allay', name: '悦灵', category: '被动生物' },
  { id: 'tadpole', name: '蝌蚪', category: '被动生物' },
  { id: 'sniffer', name: '嗅探兽', category: '被动生物' },

  // 环境
  { id: 'armor_stand', name: '盔甲架', category: '环境' },
  { id: 'item', name: '掉落物', category: '环境' },
  { id: 'experience_orb', name: '经验球', category: '环境' },
  { id: 'lightning_bolt', name: '闪电', category: '环境' },
  { id: 'tnt', name: 'TNT', category: '环境' },
  { id: 'falling_block', name: '掉落方块', category: '环境' },

  // 方块实体
  { id: 'chest_minecart', name: '运输矿车', category: '方块实体' },
  { id: 'hopper_minecart', name: '漏斗矿车', category: '方块实体' },
  { id: 'tnt_minecart', name: 'TNT 矿车', category: '方块实体' },
  { id: 'command_block_minecart', name: '命令方块矿车', category: '方块实体' },

  // 弹射物
  { id: 'arrow', name: '箭', category: '弹射物' },
  { id: 'fireball', name: '火球', category: '弹射物' },
  { id: 'small_fireball', name: '小火球', category: '弹射物' },
  { id: 'ender_pearl', name: '末影珍珠', category: '弹射物' },
  { id: 'snowball', name: '雪球', category: '弹射物' },
  { id: 'egg', name: '鸡蛋', category: '弹射物' },
  { id: 'potion', name: '药水', category: '弹射物' },
  { id: 'trident', name: '三叉戟', category: '弹射物' },
  { id: 'breeze_wind_charge', name: '旋风弹', category: '弹射物' },

  // 载具
  { id: 'boat', name: '船', category: '载具' },
  { id: 'chest_boat', name: '运输船', category: '载具' },

  // NPC
  { id: 'wandering_trader', name: '流浪商人', category: 'NPC' },
]

/** 按分类分组实体 */
export function getEntitiesByCategory(): Map<string, McEntity[]> {
  const map = new Map<string, McEntity[]>()
  for (const entity of MINECRAFT_ENTITIES) {
    const list = map.get(entity.category) ?? []
    list.push(entity)
    map.set(entity.category, list)
  }
  return map
}

/** 搜索实体（ID 或中文名包含） */
export function searchEntities(query: string): McEntity[] {
  const q = query.trim().toLowerCase()
  if (!q) return MINECRAFT_ENTITIES
  return MINECRAFT_ENTITIES.filter((e) => e.id.toLowerCase().includes(q) || e.name.includes(q))
}
