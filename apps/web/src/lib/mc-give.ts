/**
 * 给予物品的领域逻辑（与界面无关）
 *
 * 命令拼装失败是**预期状态**而非异常：目标版本没有这件物品时 `buildGiveCommand` 会抛错，
 * 而清单在渲染期就要显示「为什么不能发」。故此处提供 `tryBuildGiveCommand` 把异常收敛成
 * 可渲染的结果，并给出「这件物品在该版本可用吗」的唯一判据 `giveEntryBlockReason`。
 * 面板只消费这两个函数，不在渲染期直接调用会抛错的 `buildGiveCommand`。
 */
import { buildGiveCommand, getEnchantmentById, type GiveCommandParams } from './mc-enchantments'
import { isItemAvailableIn, requiredVersionFor } from './mc-item-versions'
import type { MinecraftItem } from './mc-items'
import { POTION_LEVEL_ROMAN, type PotionConfig } from './mc-potions'

/** 单条发放项（一件物品 + 数量 + 属性） */
export interface GiveEntry {
  item: MinecraftItem
  count: number
  /** 附魔 id → 等级 */
  enchants: Record<string, number>
  /** 效果药水配置；普通物品为 null */
  potion: PotionConfig | null
}

/** 数量上限：单条命令一次能给出的最大数量（面板口径，非游戏协议上限） */
export const MAX_GIVE_COUNT = 6400

/** 该物品在目标版本不可用的原因；可用或无版本信息时返回 null */
export function itemAvailabilityError(item: MinecraftItem, mcVersion: string): string | null {
  if (!mcVersion) return null
  const need = requiredVersionFor(item.id)
  if (need === null || isItemAvailableIn(item.id, mcVersion)) return null
  return `「${item.name}」需要 MC ${need}+，当前实例是 ${mcVersion}`
}

/** 该发放项能否生成命令；不能时给出给用户看的原因 */
export function giveEntryBlockReason(entry: GiveEntry, mcVersion: string): string | null {
  // 药水虚拟物品的 id 是效果 id，不在物品注册表里
  if (entry.potion !== null) return null
  return itemAvailabilityError(entry.item, mcVersion)
}

export type GiveCommandResult = { ok: true; command: string } | { ok: false; error: string }

/** `buildGiveCommand` 的不抛错包装（渲染期命令预览与执行前校验共用） */
export function tryBuildGiveCommand(params: GiveCommandParams): GiveCommandResult {
  try {
    return { ok: true, command: buildGiveCommand(params) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '命令生成失败' }
  }
}

/** tick → 「m:ss」/「N秒」（药水时长摘要用） */
function formatDuration(ticks: number): string {
  const seconds = Math.round(ticks / 20)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${seconds}秒`
}

/**
 * 超过一组时补「≈N组」，让 640 这类数字有可感知的量级。
 * 单件/未满一组返回空串（「1 个钻石」不需要换算）。
 */
export function stackHint(item: MinecraftItem, count: number): string {
  if (item.stackSize <= 1 || count <= item.stackSize) return ''
  const stacks = Math.floor(count / item.stackSize)
  const rest = count % item.stackSize
  return rest > 0 ? `≈${stacks}组+${rest}` : `=${stacks}组`
}

/**
 * 清单行的属性摘要（人读的一句话）：附魔名 / 药水瓶型·等级·时长 / 堆叠组数。
 * 命令是结果、摘要才是用户在清单里要核对的信息。
 */
export function summarizeGiveEntry(entry: GiveEntry): string {
  const parts: string[] = []
  const enchantIds = Object.keys(entry.enchants)
  if (enchantIds.length > 0) {
    parts.push(enchantIds.map((id) => getEnchantmentById(id)?.name ?? id).join('、'))
  }
  if (entry.potion !== null) {
    const { effect, bottle, level, duration } = entry.potion
    const bottleLabel =
      bottle.itemId === 'splash_potion'
        ? '喷溅'
        : bottle.itemId === 'lingering_potion'
          ? '滞留'
          : '饮用'
    const roman = POTION_LEVEL_ROMAN[level - 1] ?? String(level)
    const levelLabel = level > effect.vanillaMaxLevel ? `${roman}·自定义` : roman
    parts.push(
      `${bottleLabel} ${levelLabel} · ${effect.isInstant ? '瞬时' : formatDuration(duration)}`,
    )
  }
  const stacks = stackHint(entry.item, entry.count)
  if (stacks) parts.push(stacks)
  return parts.join(' · ')
}
