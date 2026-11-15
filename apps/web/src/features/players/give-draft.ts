/**
 * 给予物品的草稿（本次给予的清单 + 目录检索词）
 *
 * 归属是「本次打开详情」，不是「当前 Tab」：草稿挂在 store 而非组件内，切到物品栏再切回
 * 不会清空；关闭详情面板（或换实例）才清。切换玩家时**保留**——清单头明写「发放给谁」，
 * 由用户决定是否清空，而不是替用户静默丢掉或静默改发。
 */
import { create } from 'zustand'
import {
  MINECRAFT_POTIONS,
  POTION_BOTTLE_TYPES,
  durationsForLevel,
  type PotionConfig,
} from '@/lib/mc-potions'
import { MAX_GIVE_COUNT, type GiveEntry } from '@/lib/mc-give'
import type { MinecraftItem } from '@/lib/mc-items'

interface GiveDraftState {
  /** 清单（数组顺序 = 加入顺序，渲染与命令顺序一致） */
  entries: GiveEntry[]
  /** 目录检索词（随草稿保留） */
  search: string
  /** 目录分类（随草稿保留） */
  category: string
  /** 点击目录格子：已存在则移除，否则以数量 1 加入（药水带默认配置） */
  toggleItem: (item: MinecraftItem) => void
  /** 加入并累加数量（礼包/最近入口用） */
  addItem: (item: MinecraftItem, count?: number) => void
  removeItem: (id: string) => void
  setCount: (id: string, count: number) => void
  setEnchants: (id: string, enchants: Record<string, number>) => void
  setPotion: (id: string, potion: PotionConfig) => void
  setSearch: (search: string) => void
  setCategory: (category: string) => void
  /** 清空清单（目录检索词保留：用户可能在筛选后继续挑下一件） */
  clear: () => void
  /** 关闭详情时整体复位（清单 + 检索词 + 分类），下次打开回到初始目录 */
  reset: () => void
}

/** 新条目的初始配置（效果药水需要一份可用的默认瓶型/等级/时长） */
function makeEntry(item: MinecraftItem, count: number): GiveEntry {
  const effect = MINECRAFT_POTIONS.find((e) => e.effectId === item.id)
  const durations = effect ? durationsForLevel(effect, 1) : []
  return {
    item,
    count: Math.min(MAX_GIVE_COUNT, Math.max(1, count)),
    enchants: {},
    potion: effect
      ? {
          effect,
          bottle: POTION_BOTTLE_TYPES[0]!,
          level: 1,
          duration: durations[0]?.ticks ?? 1,
        }
      : null,
  }
}

export const useGiveDraftStore = create<GiveDraftState>()((set) => ({
  entries: [],
  search: '',
  category: '全部',

  toggleItem: (item) =>
    set((s) => {
      if (s.entries.some((e) => e.item.id === item.id)) {
        return { entries: s.entries.filter((e) => e.item.id !== item.id) }
      }
      return { entries: [...s.entries, makeEntry(item, 1)] }
    }),

  addItem: (item, count = 1) =>
    set((s) => {
      const index = s.entries.findIndex((e) => e.item.id === item.id)
      if (index === -1) return { entries: [...s.entries, makeEntry(item, count)] }
      const entries = [...s.entries]
      const current = entries[index]!
      entries[index] = { ...current, count: Math.min(MAX_GIVE_COUNT, current.count + count) }
      return { entries }
    }),

  removeItem: (id) => set((s) => ({ entries: s.entries.filter((e) => e.item.id !== id) })),

  setCount: (id, count) =>
    set((s) => ({
      entries:
        count < 1
          ? s.entries.filter((e) => e.item.id !== id)
          : s.entries.map((e) =>
              e.item.id === id ? { ...e, count: Math.min(MAX_GIVE_COUNT, count) } : e,
            ),
    })),

  setEnchants: (id, enchants) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.item.id === id ? { ...e, enchants } : e)),
    })),

  setPotion: (id, potion) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.item.id === id ? { ...e, potion } : e)),
    })),

  setSearch: (search) => set({ search }),
  setCategory: (category) => set({ category }),
  clear: () => set({ entries: [] }),
  reset: () => set({ entries: [], search: '', category: '全部' }),
}))
