/**
 * 预设礼包数据与持久化
 * - 6 个默认礼包（从未配置过时回退）
 * - 持久化 schema：{name, icon, desc, items:[{id,count}]}
 * - 礼包中可能存在不在物品目录中的 id（如 quartz_block），应用时"找不到则跳过"的容错由调用方保留
 */
import type { PanelPreferences } from '@mc-commander/schemas'
import { writePreference } from '@/stores/panel-preferences'

export interface KitItem {
  /** 物品 ID（无命名空间前缀） */
  id: string
  /** 数量 */
  count: number
}

export interface KitPreset {
  /** 礼包名 */
  name: string
  /** emoji 图标 */
  icon: string
  /** 描述 */
  desc: string
  /** 物品列表（同一物品可重复出现，如药水包） */
  items: KitItem[]
}

/** 默认礼包列表（从未配置过礼包时使用） */
export const DEFAULT_KITS: KitPreset[] = [
  {
    name: '新手起步包',
    icon: '🌱',
    desc: '木镐+石剑+面包×16+床',
    items: [
      { id: 'wooden_pickaxe', count: 1 },
      { id: 'stone_sword', count: 1 },
      { id: 'bread', count: 16 },
      { id: 'red_bed', count: 1 },
    ],
  },
  {
    name: '钻石套装',
    icon: '💎',
    desc: '全套钻石甲+剑+工具+钻×16+面包×32',
    items: [
      { id: 'diamond_helmet', count: 1 },
      { id: 'diamond_chestplate', count: 1 },
      { id: 'diamond_leggings', count: 1 },
      { id: 'diamond_boots', count: 1 },
      { id: 'diamond_sword', count: 1 },
      { id: 'diamond_pickaxe', count: 1 },
      { id: 'diamond_axe', count: 1 },
      { id: 'diamond_shovel', count: 1 },
      { id: 'diamond', count: 16 },
      { id: 'bread', count: 32 },
    ],
  },
  {
    name: '下界合金套装',
    icon: '🔥',
    desc: '全套下界合金甲+重锤+工具',
    items: [
      { id: 'netherite_helmet', count: 1 },
      { id: 'netherite_chestplate', count: 1 },
      { id: 'netherite_leggings', count: 1 },
      { id: 'netherite_boots', count: 1 },
      { id: 'mace', count: 1 },
      { id: 'netherite_pickaxe', count: 1 },
      { id: 'netherite_axe', count: 1 },
      { id: 'netherite_shovel', count: 1 },
    ],
  },
  {
    name: '建材包',
    icon: '🧱',
    desc: '64×常用建筑方块10种',
    items: [
      { id: 'stone', count: 64 },
      { id: 'oak_planks', count: 64 },
      { id: 'glass', count: 64 },
      // 官方 id 是 `bricks`（砖块），`brick_block` 不存在
      { id: 'bricks', count: 64 },
      { id: 'sandstone', count: 64 },
      { id: 'quartz_block', count: 64 },
      { id: 'cobblestone', count: 64 },
      { id: 'oak_log', count: 64 },
      { id: 'terracotta', count: 64 },
      // 官方没有裸 `concrete`（混凝土只有染色变体），原写法 give 必失败
      { id: 'white_concrete', count: 64 },
    ],
  },
  {
    name: '食物包',
    icon: '🍖',
    desc: '64×牛排/面包/金苹果',
    items: [
      { id: 'cooked_beef', count: 64 },
      { id: 'bread', count: 64 },
      { id: 'golden_apple', count: 64 },
    ],
  },
  {
    name: '药水包',
    icon: '⚗️',
    desc: '治疗/力量/速度/抗火/夜视各3瓶',
    items: [
      { id: 'potion', count: 3 },
      { id: 'potion', count: 3 },
      { id: 'potion', count: 3 },
      { id: 'potion', count: 3 },
      { id: 'potion', count: 3 },
    ],
  },
]

/** 序列化礼包 */
export function kitToJson(kit: KitPreset): Record<string, unknown> {
  return {
    name: kit.name,
    icon: kit.icon,
    desc: kit.desc,
    items: kit.items.map((e) => ({ id: e.id, count: e.count })),
  }
}

/** 反序列化礼包（损坏数据回退默认值；空 id 条目丢弃） */
export function kitFromJson(json: unknown): KitPreset | null {
  if (typeof json !== 'object' || json === null) return null
  const obj = json as Record<string, unknown>
  const rawItems = Array.isArray(obj.items) ? obj.items : []
  const items: KitItem[] = rawItems
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      id: typeof e.id === 'string' ? e.id : '',
      count: typeof e.count === 'number' ? Math.floor(e.count) : 1,
    }))
    .filter((e) => e.id.length > 0)
  if (items.length === 0 && !(typeof obj.name === 'string' && obj.name.length > 0)) return null
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    icon: typeof obj.icon === 'string' ? obj.icon : '📦',
    desc: typeof obj.desc === 'string' ? obj.desc : '',
    items,
  }
}

/**
 * 从偏好快照派生礼包列表：渲染期直接订阅，列表本身不另存本地副本——
 * 本地快照与服务端之间必然存在不一致窗口，而删除/新增都要基于最新列表整份覆盖。
 *
 * 空列表是「用户把礼包删光了」的合法配置，不回退默认：删掉的礼包下次打开又出现，
 * 删除看起来就像没生效。只有从未写过这一项才用默认礼包。
 */
export function kitsFromPreferences(remote: PanelPreferences | null): KitPreset[] {
  return remote?.kits ?? DEFAULT_KITS
}

/** 写入礼包列表（整份替换）；失败抛出，由调用方提示 */
export function saveKits(kits: KitPreset[]): Promise<void> {
  return writePreference('kits', kits)
}

/** 应用礼包时按 id 查找物品（不在目录中的 id 返回 undefined，调用方跳过） */
export function resolveKitItems<T extends { id: string }>(
  kits: KitPreset[],
  lookup: (id: string) => T | undefined,
): Array<{ item: T; count: number; skippedMissing: boolean }> {
  const result: Array<{ item: T; count: number; skippedMissing: boolean }> = []
  for (const kit of kits) {
    for (const entry of kit.items) {
      const item = lookup(entry.id)
      result.push({
        item: item as T,
        count: entry.count,
        skippedMissing: item === undefined,
      })
    }
  }
  return result
}
