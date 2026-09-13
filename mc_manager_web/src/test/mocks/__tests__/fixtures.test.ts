/**
 * mock 夹具自身的一致性守卫
 * 夹具是伪数据，但必须自洽：名称内嵌日期、而时间字段用相对时间（`now - 1d`）的夹具，
 * 会把「名称写 08-14 / 时间显示 09-10」这类矛盾直接渲染进首屏；而断言通常只查
 * 「名称是否存在」——矛盾不会让任何用例变红，只能靠人眼发现（J32）。
 * 故在此对夹具立约：名称不内嵌日期、名称唯一。
 * （`scripts/mock-server.mjs` 的孪生夹具无法在 vitest 中导入，其三条名称由 e2e 以
 * `{ exact: true }` 精确断言钉住；子串匹配不算防线，改夹具名必须让 e2e 变红。）
 */
import { describe, it, expect } from 'vitest'
import { mockBackups } from '../handlers'

describe('备份夹具一致性', () => {
  it('名称不内嵌日期（与 createdAt 的相对/独立时间会互相矛盾）', () => {
    for (const backup of mockBackups) {
      expect(backup.name).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  it('名称互不重复（e2e 与 RTL 均按名称定位操作按钮，重名会触发 strict 冲突）', () => {
    const names = mockBackups.map((b) => b.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
