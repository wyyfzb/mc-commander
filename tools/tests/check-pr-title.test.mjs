/**
 * PR 标题校验的单测。
 *
 * 为什么要有：这条检查守卫的是「静默漏发版」——release-please 遇到不合规的标题
 * 不报错、只是当它不存在。检查本身判错一次，要么误拦全部 PR，要么把漏洞留着。
 */
import { describe, it, expect } from 'vitest'
import { checkPrTitle, COMMIT_TYPES } from '../ci/check-pr-title.mjs'

describe('checkPrTitle', () => {
  it('仓库历史里出现过的形态一律通过', () => {
    for (const title of [
      'feat(web): 玩家详情新增成就标签页',
      'fix(server): 实例未运行时白名单操作返回 400 而非 500',
      'fix(deps): bump the minor-and-patch group across 1 directory with 13 updates',
      'chore(main): release 0.13.3',
      'feat: 全局总览与性能诊断接入，实例升级与部署体验收口',
      'refactor(repo): 目录结构重排与工程化收敛 (#659)',
    ]) {
      expect(checkPrTitle(title), title).toEqual({ ok: true })
    }
  })

  it('全部约定类型均可通过', () => {
    for (const type of COMMIT_TYPES) {
      expect(checkPrTitle(`${type}: 描述`), type).toEqual({ ok: true })
    }
  })

  it('带 ! 的 breaking 标记通过', () => {
    expect(checkPrTitle('feat(web)!: 重写给予接口')).toEqual({ ok: true })
    expect(checkPrTitle('feat!: 重写给予接口')).toEqual({ ok: true })
  })

  it('缺少类型 / 缺冒号 / 缺空格 → 拒绝', () => {
    expect(checkPrTitle('修复给予界面').ok).toBe(false)
    expect(checkPrTitle('fix(web) 修复给予界面').ok).toBe(false)
    expect(checkPrTitle('fix(web):修复给予界面').ok).toBe(false)
  })

  it('描述为空 → 拒绝', () => {
    expect(checkPrTitle('fix(web):').ok).toBe(false)
    expect(checkPrTitle('fix(web):   ').ok).toBe(false)
  })

  it('空标题 → 拒绝', () => {
    expect(checkPrTitle('').ok).toBe(false)
    expect(checkPrTitle('   ').ok).toBe(false)
    expect(checkPrTitle(null).ok).toBe(false)
  })

  it('未约定的类型 → 拒绝（release-please 不会记账）', () => {
    const r = checkPrTitle('update(web): 一些改动')
    expect(r.ok).toBe(false)
    // 收窄：断言 ok 为 false 后 TS 不会自动收窄，先挡一道再取 reason/hint
    if (r.ok) throw new Error('应当拒绝')
    expect(r.reason).toContain('update')
    // 提示里要列出可用类型，避免只告诉用户「错了」
    expect(r.hint).toContain('feat')
  })
  it('大小写不符 → 拒绝（GitHub 上的 PR 标题常被手写）', () => {
    expect(checkPrTitle('Feat(web): 新功能').ok).toBe(false)
  })

  it('首尾空白被忽略', () => {
    expect(checkPrTitle('  fix(web): 修一处  ')).toEqual({ ok: true })
  })
})
