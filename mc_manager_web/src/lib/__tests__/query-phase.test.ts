/**
 * lib/query-phase 单测
 * 覆盖：
 * - 四相判定：首帧 loading / 失败无数据 failed / 失败有旧值 stale / 正常 ready
 * - queryFailed 的核心动机：重试窗口内 isError 瞬时归 false，仍须判为失败
 * - 恢复后不残留：成功落定时间追过失败时间 → 不再判失败
 * - 边界：「有旧值可留」取是否成功落定过，成功后的空集合不被当成无数据
 * - 重试期间不退回 loading/骨架（那会抹掉用户正在看的旧数据）
 */
import { describe, expect, it } from 'vitest'
import { queryFailed, queryPhase } from '../query-phase'

/** 造一条 query 状态快照（默认＝已成功落定） */
function q(
  over: Partial<{
    isPending: boolean
    isError: boolean
    errorUpdatedAt: number
    dataUpdatedAt: number
  }>,
) {
  return { isPending: false, isError: false, errorUpdatedAt: 0, dataUpdatedAt: 1000, ...over }
}

describe('queryFailed', () => {
  it('isError 为真即失败', () => {
    expect(queryFailed(q({ isError: true, errorUpdatedAt: 2000 }))).toBe(true)
  })

  it('重试窗口内 isError 已瞬时归 false，但失败时间戳仍晚于成功 → 仍判失败', () => {
    // 这一条是该函数存在的全部理由：只看 isError 会让提示连同重试按钮在整个请求窗口消失
    expect(queryFailed(q({ isError: false, errorUpdatedAt: 2000, dataUpdatedAt: 1000 }))).toBe(true)
  })

  it('恢复成功后不再判失败（成功时间追过失败时间）', () => {
    expect(queryFailed(q({ isError: false, errorUpdatedAt: 2000, dataUpdatedAt: 3000 }))).toBe(
      false,
    )
  })

  it('从未失败过时不误判（errorUpdatedAt 停在 0）', () => {
    expect(queryFailed(q({}))).toBe(false)
  })
})

describe('queryPhase', () => {
  it('首帧未落定且 pending → loading', () => {
    expect(queryPhase(q({ isPending: true, dataUpdatedAt: 0 }))).toBe('loading')
  })

  it('失败且从未成功过（无旧值可留）→ failed', () => {
    expect(queryPhase(q({ isError: true, errorUpdatedAt: 2000, dataUpdatedAt: 0 }))).toBe('failed')
  })

  it('失败但有上一轮数据 → stale（不替换主体）', () => {
    expect(queryPhase(q({ isError: true, errorUpdatedAt: 2000 }))).toBe('stale')
  })

  it('正常有数据 → ready', () => {
    expect(queryPhase(q({}))).toBe('ready')
  })

  it('成功后的空集合仍走 ready（空是真实事实，不是「没数据」）', () => {
    // hasData 取「是否成功落定过」而非数组长度，故此处与上一条同相
    expect(queryPhase(q({}))).toBe('ready')
  })

  it('重试期间不退回骨架：曾成功 + 曾失败 → 保持 stale', () => {
    // 轮询重试时 isPending 会翻真，此时退回骨架就把用户正在看的旧数据抹掉了
    expect(queryPhase(q({ isPending: true, errorUpdatedAt: 2000 }))).toBe('stale')
  })

  it('首帧重试（从未成功过）不冒充 stale', () => {
    expect(queryPhase(q({ isPending: true, errorUpdatedAt: 2000, dataUpdatedAt: 0 }))).toBe(
      'failed',
    )
  })
})
