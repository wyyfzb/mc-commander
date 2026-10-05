/**
 * 版本兜底表的**不变量守卫**。
 *
 * 背景：`FALLBACK_VERSIONS` 是版本端点的离线兜底，属**人工快照**——新版本发布后它不会
 * 自动更新。台账要求「避免它悄悄陈旧成第二事实源」，而「是否已陈旧」需要联网才能判定
 * （测试必须离线确定性），所以这里守不住「新版本没加进来」，只守住**能静态判定**的部分：
 * 形态、排序、去重、默认项即首项。
 *
 * 它们各自对应用户能直接看到的后果：
 * - 排序错 ⇒ 下拉里版本乱序，用户按「第一个就是最新」的习惯选错
 * - 有重复 ⇒ 同一版本出现两次，选择器里像是两个不同版本
 * - 形态不合法 ⇒ 用户选了一个服务端认不出的版本，部署必然失败
 * - 首项不是最新 ⇒ 表单默认值指向旧版本（本次修的就是这个：首项曾是 26.2，而最新是 26.3）
 */
import { describe, it, expect } from 'vitest'
import { FALLBACK_VERSIONS } from '../mc-deploy'

/** 版本形态与仓库其它处一致：`<主>.<次>` 或 `<主>.<次>.<修订>` */
const VERSION_RE = /^\d+(\.\d+){1,2}$/

/** 数值化用于比较：段数不同的版本按段逐位比，缺位补 0（`26.1` == `26.1.0`） */
function parts(v: string): number[] {
  return v.split('.').map((n) => Number.parseInt(n, 10))
}

/**
 * `a` 比 `b` 新多少：> 0 表示 a 更新。
 * 判据是「降序排列里前一项必须比后一项新」，故返回 `a - b` 而不是 `b - a`。
 */
function compareNewer(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

describe('FALLBACK_VERSIONS 兜底表的不变量', () => {
  it('非空，且每一项都是合法版本形态', () => {
    expect(FALLBACK_VERSIONS.length).toBeGreaterThan(0)
    for (const v of FALLBACK_VERSIONS) {
      expect(v, `版本形态不合法: ${v}`).toMatch(VERSION_RE)
    }
  })

  it('降序（下拉按此顺序展示，用户会默认第一项是最新）', () => {
    // 用「排序后应等于原序」表达，避免按下标取值——`noUncheckedIndexedAccess` 下逐项索引
    // 得到 `string | undefined`，为收窄再补断言反而更绕。
    // 严格性由「无重复」用例补足：降序 + 无重复 ⇒ 严格降序。
    // 注意方向：`sort` 的比较器返回正数表示「a 排在 b 之后」，
    // 要得到「新的在前」必须传 `compareNewer(b, a)`
    const byNewest = [...FALLBACK_VERSIONS].sort((a, b) => compareNewer(b, a))
    expect(byNewest).toEqual([...FALLBACK_VERSIONS])
  })

  it('无重复（重复会让同一版本在选择器里看起来是两个）', () => {
    expect(new Set(FALLBACK_VERSIONS).size).toBe(FALLBACK_VERSIONS.length)
  })

  it('条目总数固定（删条目与改首项一样要显式：删两档就少两个可选版本）', () => {
    // 探针发现：只断言「降序/去重/形态」时，**删掉中间某一项不会转红**——而降序依然成立、
    // 也不重复、形态也合法。故这里钉住数量，让删除必须是有意的。
    expect(FALLBACK_VERSIONS).toHaveLength(11)
  })

  it('保留各代锚点版本（跨大版本各留一档，避免只剩最新几档）', () => {
    // 兜底的价值在于「上游挂了也能选到需要的版本」；若某一代被整段删掉，
    // 那代的服务端就无法在离线态部署了
    for (const anchor of ['26.3', '26.1', '1.21.4', '1.20.4', '1.18.2']) {
      expect(FALLBACK_VERSIONS, `缺少锚点版本 ${anchor}`).toContain(anchor)
    }
  })

  it('首项即表单默认值来源（改了首项就是改了默认部署版本，必须是有意的）', () => {
    // 表单默认取列表首项；这条把「默认版本」这件事显式化，避免首项被无意改动
    expect(FALLBACK_VERSIONS[0]).toBe('26.3')
  })
})
