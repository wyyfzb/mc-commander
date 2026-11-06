import { z } from 'zod'

/**
 * 性能诊断契约（POST /instances/:id/perf/snapshot）。
 *
 * `kind` 区分两路：`perf` 主口径（窗口内 tick 耗时、堆占用、热点子树、各维度区块与实体数），
 * `jfr` 备口径（同窗口的 GC 次数与开销、分配速率）。两者都是**一次性取样**，
 * 采集窗口长度由 `windowMs` 如实交代。
 *
 * `verdict` 由服务端给出：判定要用窗口内的原始样本与阈值，两端各算一次必然漂移。
 */

export const PERF_SNAPSHOT_KINDS = ['perf', 'jfr'] as const
export type PerfSnapshotKind = (typeof PERF_SNAPSHOT_KINDS)[number]

/**
 * 两路采集的固定窗口（毫秒），界面上的「正在取样 N 秒」由它派生。
 * 数值的唯一来处是服务端：`/perf start` 自己采 10 秒、JFR 录制 15 秒，
 * 面板无从缩短或延长。两端各写一份时，调窗口只会改到服务端，等待提示会开始骗人。
 */
export const PERF_SNAPSHOT_WINDOW_MS = { perf: 10_000, jfr: 15_000 } as const

export const perfSnapshotRequestSchema = z.object({
  /** 采集哪一路；缺省走主口径 perf */
  kind: z.enum(PERF_SNAPSHOT_KINDS).default('perf'),
})

/** 结论档：critical 是「已经出问题」，warning 是「还没出问题但快到了」，healthy 是「余量充足」 */
export const perfVerdictLevelSchema = z.enum(['healthy', 'warning', 'critical'])

/**
 * 一条依据。`label` 是「看的是什么」，`value` 是带单位的值，`hint` 解释这个值意味着什么。
 * 值一律在服务端格式化（含单位与精度）：单位是结论的一部分，交给前端拼会各处不一致。
 */
export const perfFindingSchema = z.object({
  label: z.string(),
  value: z.string(),
  hint: z.string().nullable().optional(),
})

export const perfVerdictSchema = z.object({
  level: perfVerdictLevelSchema,
  /** 首屏那一句人话结论（完整句子，不含实现细节） */
  headline: z.string(),
  /** 依据与下一步：为什么是这个结论、用户接下来该看什么 */
  detail: z.string(),
  findings: z.array(perfFindingSchema),
})

export const perfTickSchema = z.object({
  /** 每刻实际耗时（毫秒，MSPT）；取自 stats.txt 的 average_tick_time */
  averageMs: z.number(),
  p99Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
  /** 参与统计的刻数（窗口长度变化时行数会变，不假定固定值） */
  samples: z.number(),
  tickSpan: z.number().nullable(),
  timeSpanMs: z.number().nullable(),
  ticksPerSecond: z.number().nullable(),
})

export const perfHeapSchema = z.object({
  /** 窗口内堆占用峰值（MiB）；口径是 used，不是 committed */
  usedPeakMiB: z.number(),
  usedStartMiB: z.number(),
  usedEndMiB: z.number(),
  /** 堆上限（MiB）；取不到时为 null，此时不判内存压力 */
  maxMiB: z.number().nullable(),
  /** 峰值占上限的百分比；maxMiB 为 null 时同样为 null */
  usedPeakPercent: z.number().nullable(),
  samples: z.number(),
})

/** tick 子树里的热点：`sharePercent` 是该段在 tick 内部耗时中的占比 */
export const perfHotspotSchema = z.object({
  name: z.string(),
  sharePercent: z.number(),
})

export const perfDimensionSchema = z.object({
  name: z.string(),
  chunks: z.number(),
  entities: z.number(),
})

export const perfDetailSchema = z.object({
  mcVersion: z.string().nullable(),
  javaVersion: z.string().nullable(),
  cpus: z.number().nullable(),
  /** 进程自启动以来平均占用（单核百分比）；不是 10 秒窗口内的瞬时值 */
  processCpuPercent: z.number().nullable(),
  tick: perfTickSchema.nullable(),
  heap: perfHeapSchema.nullable(),
  hotspots: z.array(perfHotspotSchema),
  dimensions: z.array(perfDimensionSchema),
})

export const jfrDetailSchema = z.object({
  /** 录制时长（毫秒）：短窗口下 GC 与分配速率都不具代表性 */
  durationMs: z.number(),
  gcCount: z.number().nullable(),
  gcOverheadPercent: z.number().nullable(),
  gcTotalDurationMs: z.number().nullable(),
  allocationRateMiBPerSecond: z.number().nullable(),
  /** JVM 自身 CPU 占用（百分比）；服务端跑满时会接近「核数 × 100」 */
  cpuJvmAveragePercent: z.number().nullable(),
  tickAverageMs: z.number().nullable(),
  tickMaxMs: z.number().nullable(),
})

export const perfSnapshotResponseSchema = z.object({
  kind: z.enum(PERF_SNAPSHOT_KINDS),
  /** 采集完成时刻（ISO） */
  collectedAt: z.string(),
  /** 实际采样窗口长度（毫秒）：界面据此说明「这是一次取样」 */
  windowMs: z.number(),
  verdict: perfVerdictSchema,
  /** kind === 'perf' 时非空 */
  perf: perfDetailSchema.nullable(),
  /** kind === 'jfr' 时非空 */
  jfr: jfrDetailSchema.nullable(),
  /** 原始产物相对实例目录的路径（交给既有文件下载端点），取不到时为 null */
  archivePath: z.string().nullable(),
  /**
   * 解析降级说明：产物里读不出的部分逐条列出，界面原样呈现。
   * 空数组＝全部解析成功。空数组与「字段全为 null」不是一回事，后者必须伴随一条说明。
   */
  parseWarnings: z.array(z.string()),
})

export type PerfFinding = z.infer<typeof perfFindingSchema>
export type PerfVerdict = z.infer<typeof perfVerdictSchema>
export type PerfTick = z.infer<typeof perfTickSchema>
export type PerfHeap = z.infer<typeof perfHeapSchema>
export type PerfHotspot = z.infer<typeof perfHotspotSchema>
export type PerfDimension = z.infer<typeof perfDimensionSchema>
export type PerfDetail = z.infer<typeof perfDetailSchema>
export type JfrDetail = z.infer<typeof jfrDetailSchema>
export type PerfSnapshotRequest = z.infer<typeof perfSnapshotRequestSchema>
export type PerfSnapshotResponse = z.infer<typeof perfSnapshotResponseSchema>
