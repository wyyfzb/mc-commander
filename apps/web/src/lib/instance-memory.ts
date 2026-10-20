/**
 * 实例内存账本：把「这台机器还能给新实例分多少」算成能直接照做的一句结论。
 *
 * 可分配 = 总内存 − 系统保留。保留取 15%（实测面板 142 MB + rsync 备份 7 MB + 无 MC 基线
 * 1.2 GB，8 GB 机器上留 1.2 GB 够用）；Paper 官方按同样比例建议 8 GB 主机给 6500 MB。
 *
 * 已分配按 -Xmx 计，不按实际驻留：G1 下官方要求按能用满整个 -Xmx 规划，且停着的实例
 * 随时会被启动；按驻留记账会让「还能开几台」随负载漂移。代价是偏保守——实测两个 -Xmx4G
 * 实例在 7.4 GB 机器上 RSS 合计只有几十 MB，所以界面上说「分配了」不说「占了」。
 *
 * 结果向下取到 0.5 GB：滑块与档位都按半档走，避免出现 6.3 这种选不中的值。
 */
/* 档位是给部署时快速选的，不等于可分配上限：连续值交给设置弹窗的 0.5 GB 滑块。
   只到 8G 会让 32/64 GB 的机器选不到该给的内存，只能先建 8G 再进设置里拖 */
export const MEMORY_TIERS_GB = [1, 2, 4, 8, 16, 32, 64] as const

/** 系统保留比例与下限（低于 1 GB 时面板自身就可能被 OOM 杀掉） */
export const SYSTEM_RESERVE_RATIO = 0.15
export const SYSTEM_RESERVE_MIN_GB = 1

/* 下限 2 GB：实测 MC 26.3 空服 -Xmx1G 能启动（24 秒到 Done），装插件/模组后不够 */
export const RECOMMEND_MIN_GB = 2

/** GB 向下取半档 */
export function floorToHalfGB(gb: number): number {
  return Math.floor(gb * 2) / 2
}

/** 内存字段 → GB：`'4G'`/`'2048M'` 字符串；数值按 MB（旧库与 mock 的既有约定） */
export function parseMemoryGB(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value > 0 ? value / 1024 : null
  const matched = value.match(/^(\d+(?:\.\d+)?)([GM])$/i)
  if (!matched) return null
  const amount = Number.parseFloat(matched[1]!)
  return matched[2]!.toUpperCase() === 'G' ? amount : amount / 1024
}

/** GB → JVM 内存参数：-Xmx 不支持小数 G 后缀，非整数转 M */
export function formatMemoryForJvm(gb: number): string {
  if (gb === Math.round(gb)) return `${Math.round(gb)}G`
  return `${Math.round(gb * 1024)}M`
}

/** 系统保留量（GB，半档取整） */
export function systemReserveGB(totalGB: number): number {
  return Math.max(SYSTEM_RESERVE_MIN_GB, floorToHalfGB(totalGB * SYSTEM_RESERVE_RATIO))
}

/** 这台机器可分配给全部实例的总量（已扣系统保留） */
export function allocatableMemoryGB(totalGB: number): number {
  if (!(totalGB > 0)) return 0
  return Math.max(0, floorToHalfGB(totalGB - systemReserveGB(totalGB)))
}

/**
 * -Xmx 合计（GB）。无法解析的条目按 0 计：脏数据不该把「还能分配」算成负数，
 * 也不该让一台机器的内存凭空消失。
 */
export function sumAllocatedGB(values: readonly (string | number | null | undefined)[]): number {
  return values.reduce<number>((sum, value) => sum + (parseMemoryGB(value) ?? 0), 0)
}

/** 一台机器的内存账。字段名已自明，只有两个容易混的加了注 */
export interface MemoryBudget {
  totalGB: number
  reserveGB: number
  /** 其他实例已分配的 -Xmx 之和 */
  othersGB: number
  /** 有内存配置的其他实例台数 */
  otherCount: number
  /** 整机可分配给全部实例的总量（已扣系统保留） */
  allocatableGB: number
  /** 还能给这一台用多少（已扣其他实例，半档取整，最小 0） */
  availableGB: number
}

export function memoryBudget(
  totalGB: number,
  others: readonly (string | number | null | undefined)[],
): MemoryBudget {
  const total = totalGB > 0 ? totalGB : 0
  const parsed = others
    .map((value) => parseMemoryGB(value))
    .filter((gb): gb is number => gb != null)
  const othersGB = parsed.reduce((sum, gb) => sum + gb, 0)
  const allocatableGB = allocatableMemoryGB(total)
  return {
    totalGB: total,
    reserveGB: systemReserveGB(total),
    othersGB,
    otherCount: parsed.length,
    allocatableGB,
    availableGB: Math.max(0, floorToHalfGB(allocatableGB - othersGB)),
  }
}

/**
 * 新实例可选档位：只留装得下的。一个都装不下时仍保留最低档——
 * 把部署彻底堵死会让「内存吃紧」变成「面板用不了」，后果交给页面上的警告交代。
 */
export function selectableTiersGB(availableGB: number): number[] {
  const fits = MEMORY_TIERS_GB.filter((gb) => gb <= availableGB)
  return fits.length > 0 ? [...fits] : [MEMORY_TIERS_GB[0]]
}

/** 这台机器还装得下一个最低档实例吗 */
export function hasRoomForInstance(availableGB: number): boolean {
  return availableGB >= MEMORY_TIERS_GB[0]
}

/**
 * 「还能再开一台吗」的一句话结论（部署引导块用）。
 * 说余量不说「还剩几个」：条目数取决于要开多大的服，报数字会被当成配额。
 * 总内存读数缺失时返回 null：算不出余量还说「已分完」，用户会照着去卸载实例。
 */
export function remainingMemoryHint(budget: MemoryBudget): string | null {
  if (!(budget.totalGB > 0)) return null
  if (!hasRoomForInstance(budget.availableGB)) {
    // 说「共分配」不说「已占」：这是 -Xmx 之和，不是物理占用。实测两个 -Xmx4G 实例在
    // 7.4 GB 机器上 RSS 合计仅 57 MB（其余被换出），「已占 8 GB」会和整机 7.4 GB 打架
    return budget.otherCount > 0
      ? `内存已分完（${budget.otherCount} 个实例共分配 ${budget.othersGB} GB），再加需先卸载`
      : '内存已分完，再加需先卸载'
  }
  return `还能分给新实例 ${budget.availableGB.toFixed(1)} GB`
}

/**
 * 新实例推荐量：目标 = min(可用量, 可分配总量的一半且不低于 2 GB)，取最近的档。
 * 官方的 6–10 GB 是单服独占整机的口径，这里一台机器开几个服，吃光余量等于堵死第二台；
 * 16 GB 机器（可分配 14 GB）走这条规则正好落在官方下限 8 GB。
 * 取最近档不向下取：14 GB 可分配量给 4G 太寒酸，超过可用量的风险由封顶兜住。
 */
export function recommendNewInstanceGB(availableGB: number, allocatableGB = availableGB): number {
  if (!(availableGB > 0)) return MEMORY_TIERS_GB[0]
  const tiers = MEMORY_TIERS_GB.filter((gb) => gb <= availableGB)
  if (tiers.length === 0) return MEMORY_TIERS_GB[0]
  const target = Math.min(availableGB, Math.max(allocatableGB / 2, RECOMMEND_MIN_GB))
  return tiers.reduce((best, gb) => (Math.abs(gb - target) < Math.abs(best - target) ? gb : best))
}
