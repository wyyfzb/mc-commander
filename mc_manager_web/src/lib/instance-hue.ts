/**
 * instance-hue —— 实例固定色相标识（非语义 identity 色族）
 *
 * 只回答「是哪个实例」：由实例 id 稳定哈希落 6 槽之一（同一 id 恒得同一槽，不落库——
 * instances 表无 color 列，跨端不涉及）。
 * 禁用范围、与 tone.ts 的分工边界见 mc_manager_web/docs/design-review-guidelines.md
 * 「非语义 identity 色族」（该口径的唯一声明源）。
 *
 * 槽位 → 类名的映射只在本文件声明（消费点只调 instanceHueFillClass，不得再写第二份）。
 * 类名是字面量而非运行时拼接：Tailwind 能静态扫到，不会静默不生成。
 */

/** 槽数 = identity 色族档位数（--mcs-identity-1..6） */
export const INSTANCE_HUE_SLOTS = 6

export type InstanceHueSlot = 1 | 2 | 3 | 4 | 5 | 6

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a 32 位 + murmur3 fmix32 雪崩收尾，再按高位乘移落槽。
 *
 * 选型约束（三条都是实测出来的，改哈希前必须重新验证）：
 * - 纯整数运算（Math.imul 保证 32 位回绕跨环境一致）、零依赖、无随机源 → 同一 id 恒得同一槽；
 * - **不能只用 FNV-1a 裸输出**：真实实例名是「同前缀 + 序号」形态（s1 / s2 / server-1），
 *   裸 FNV 的高位对这类 id 有系统性偏置（6000 个样本卡方 104-143，5 自由度临界值 11.07）；
 *   补一轮 fmix32 后各 id 形态家族卡方落在 1.4-7.5；
 * - 取**高位**（乘移）而非 `% 6`：乘移不引入模偏置，且不依赖低位质量。
 */
const FMIX_A = 0x85ebca6b
const FMIX_B = 0xc2b2ae35

function avalanche32(hash: number): number {
  let h = hash >>> 0
  h ^= h >>> 16
  h = Math.imul(h, FMIX_A)
  h ^= h >>> 13
  h = Math.imul(h, FMIX_B)
  h ^= h >>> 16
  return h >>> 0
}

/** 实例 id → 槽位（1..6）。空串、任意 Unicode 都返回合法槽位，不抛异常 */
export function instanceHueSlot(id: string): InstanceHueSlot {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  const slot = Math.floor((avalanche32(hash) * INSTANCE_HUE_SLOTS) / 2 ** 32)
  return (slot + 1) as InstanceHueSlot
}

/**
 * 槽位 → 小图形填充类（8px 色点 / 2px 色条）。
 * 只作图形填充：不承载文字、不做容器底，故本族没有 -fg / -bg-subtle 档。
 */
const INSTANCE_HUE_FILL_CLASSES: Record<InstanceHueSlot, string> = {
  1: 'bg-mcs-identity-1',
  2: 'bg-mcs-identity-2',
  3: 'bg-mcs-identity-3',
  4: 'bg-mcs-identity-4',
  5: 'bg-mcs-identity-5',
  6: 'bg-mcs-identity-6',
}

/** 实例 id → 色点/色条类名（消费点唯一入口） */
export function instanceHueFillClass(id: string): string {
  return INSTANCE_HUE_FILL_CLASSES[instanceHueSlot(id)]
}
