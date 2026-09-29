import { describe, it, expect } from 'vitest'
import { buildClearPredicate, buildClearCommand, overLimitEnchantments } from '../mc-item-predicate'

/**
 * 物品查缴谓词拼装（条目 8 的可离线交付部分）。
 *
 * 重点钉住**官方语法形态**——条目备注明确记录了一处「联网搜索给的形状是错的」，
 * 故这里把正确形态与两个常见错形都写成断言，防止后人照抄错形。
 */
describe('buildClearPredicate - 官方语法形态', () => {
  it('仅物品 id：不带组件时就是裸 id', () => {
    expect(buildClearPredicate({ itemId: 'diamond' }, '1.21.4')).toEqual({
      predicate: 'minecraft:diamond',
      error: null,
    })
  })

  it('enchantments 是**数组**（条目备注记录的错形是嵌套对象，此处锁正确形态）', () => {
    const r = buildClearPredicate({ enchantments: [{ id: 'sharpness', minLevel: 6 }] }, '1.21.4')
    expect(r.error).toBe(null)
    // 正确：数组，每项含 enchantments + levels
    expect(r.predicate).toBe('minecraft:*[{enchantments:"minecraft:sharpness",levels:{min:6}}]')
    // 反面：不得出现「嵌套对象」形态
    expect(r.predicate).not.toContain('levels:{"minecraft:sharpness"')
    expect(r.predicate).not.toContain('{min:6,max:')
  })

  it('levels 支持区间：[Int] 精确值 / [Compound] min-max', () => {
    // 精确值用裸整数，不是 {min:5,max:5}
    expect(
      buildClearPredicate(
        { enchantments: [{ id: 'sharpness', minLevel: 5, maxLevel: 5 }] },
        '1.21.4',
      ).predicate,
    ).toBe('minecraft:*[{enchantments:"minecraft:sharpness",levels:5}]')
    // 单边界
    expect(
      buildClearPredicate({ enchantments: [{ id: 'sharpness', minLevel: 6 }] }, '1.21.4').predicate,
    ).toContain('levels:{min:6}')
    expect(
      buildClearPredicate({ enchantments: [{ id: 'sharpness', maxLevel: 2 }] }, '1.21.4').predicate,
    ).toContain('levels:{max:2}')
    // 区间
    expect(
      buildClearPredicate(
        { enchantments: [{ id: 'sharpness', minLevel: 3, maxLevel: 7 }] },
        '1.21.4',
      ).predicate,
    ).toContain('levels:{min:3,max:7}')
  })

  it('不带 levels 时只按附魔存在性匹配（不带空的 min/max）', () => {
    expect(buildClearPredicate({ enchantments: [{ id: 'mending' }] }, '1.21.4').predicate).toBe(
      'minecraft:*[{enchantments:"minecraft:mending"}]',
    )
  })

  it('多个附魔条件组合进同一数组（OR 语义）', () => {
    expect(
      buildClearPredicate(
        {
          enchantments: [
            { id: 'sharpness', minLevel: 6 },
            { id: 'protection', minLevel: 5 },
          ],
        },
        '1.21.4',
      ).predicate,
    ).toBe(
      'minecraft:*[{enchantments:"minecraft:sharpness",levels:{min:6}},{enchantments:"minecraft:protection",levels:{min:5}}]',
    )
  })

  it('物品 id + 附魔条件可同时给出', () => {
    expect(
      buildClearPredicate(
        { itemId: 'diamond_sword', enchantments: [{ id: 'sharpness', minLevel: 6 }] },
        '1.20.6',
      ).predicate,
    ).toBe('minecraft:diamond_sword[{enchantments:"minecraft:sharpness",levels:{min:6}}]')
  })
})

describe('buildClearPredicate - 拒绝而非静默降级', () => {
  it('空谓词被拒：否则 `clear <玩家>` 会退化成「清空整个背包」', () => {
    // 这是最危险的一种「静默降级」——用户以为在查缴某物，实际把背包全清了
    expect(buildClearPredicate({}, '1.21.4')).toEqual({
      predicate: null,
      error: 'empty-predicate',
    })
    expect(buildClearPredicate({ enchantments: [] }, '1.21.4').error).toBe('empty-predicate')
  })

  it('1.20.4 及以下不支持 Data Components 谓词 ⇒ 附魔条件报错（不拼出无效命令）', () => {
    for (const v of ['1.20.4', '1.19.4', '1.16.5']) {
      expect(
        buildClearPredicate({ enchantments: [{ id: 'sharpness', minLevel: 6 }] }, v),
        v,
      ).toEqual({
        predicate: null,
        error: 'unsupported-version',
      })
    }
    // 但纯物品 id 在低版本仍可用（谓词语法本身 1.13+ 就有）
    expect(buildClearPredicate({ itemId: 'diamond' }, '1.20.4').error).toBe(null)
  })

  it('min > max 的区间被拒（那是一条永远匹配不到的命令）', () => {
    expect(
      buildClearPredicate(
        { enchantments: [{ id: 'sharpness', minLevel: 7, maxLevel: 3 }] },
        '1.21.4',
      ).error,
    ).toBe('invalid-level-range')
  })

  it('非法 id / 注入尝试被拒', () => {
    // 注意空串不在此列：它是 falsy，会先命中 empty-predicate（那是更准确的诊断——
    // 「你什么都没给」比「你的 id 非法」更贴合事实）
    for (const bad of ['../evil', 'a b', 'a;b', 'A', 'x"y', 'a}b', '-lead']) {
      expect(buildClearPredicate({ itemId: bad }, '1.21.4'), bad).toMatchObject({
        error: 'invalid-id',
      })
    }
    expect(
      buildClearPredicate({ enchantments: [{ id: 'sharp"] ,levels:{min:1' }] }, '1.21.4').error,
    ).toBe('invalid-id')
  })

  it('空串 itemId 报 empty-predicate 而非 invalid-id（诊断要贴合事实）', () => {
    expect(buildClearPredicate({ itemId: '' }, '1.21.4').error).toBe('empty-predicate')
  })
})

describe('buildClearCommand - 三种模式', () => {
  it('probe：追加 maxCount 0 = 只查不删（条目口径）', () => {
    const r = buildClearCommand('Steve', { itemId: 'diamond' }, '1.21.4', 'probe')
    expect(r.command).toBe('clear Steve minecraft:diamond 0')
  })

  it('clear：省略 maxCount = 清空全部匹配项', () => {
    const r = buildClearCommand('Steve', { itemId: 'diamond' }, '1.21.4', 'clear')
    expect(r.command).toBe('clear Steve minecraft:diamond')
  })

  it('limit：只清前 n 个', () => {
    const r = buildClearCommand('Steve', { itemId: 'diamond' }, '1.21.4', 'limit', 3)
    expect(r.command).toBe('clear Steve minecraft:diamond 3')
  })

  it('limit 非正整数被拒（否则会退化成「只查」或非法命令）', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(
        buildClearCommand('Steve', { itemId: 'diamond' }, '1.21.4', 'limit', bad).command,
        String(bad),
      ).toBe(null)
    }
  })

  it('玩家名白名单挡注入（官方名允许 [A-Za-z0-9_]{3,16}）', () => {
    for (const bad of ['a', 'ab', 'a b', 'Steve;stop', 'Steve\nclear Alex', 'x'.repeat(17)]) {
      expect(buildClearCommand(bad, { itemId: 'diamond' }, '1.21.4').command, bad).toBe(null)
    }
    expect(buildClearCommand('Alex_99', { itemId: 'diamond' }, '1.21.4').command).toBe(
      'clear Alex_99 minecraft:diamond',
    )
  })

  it('谓词失败时命令为 null 且透传原因', () => {
    const r = buildClearCommand('Steve', {}, '1.21.4')
    expect(r.command).toBe(null)
    expect(r.error).toBe('empty-predicate')
  })
})

describe('overLimitEnchantments - 非法物品判据', () => {
  it('原版上限 +1 即超限判据（用 min 表达 ≥，纯命令匹配）', () => {
    expect(overLimitEnchantments([{ id: 'sharpness', maxLevel: 5 }])).toEqual([
      { id: 'sharpness', minLevel: 6 },
    ])
    expect(overLimitEnchantments([{ id: 'protection', maxLevel: 4 }])).toEqual([
      { id: 'protection', minLevel: 5 },
    ])
  })

  it('多个附魔批量生成', () => {
    expect(
      overLimitEnchantments([
        { id: 'sharpness', maxLevel: 5 },
        { id: 'mending', maxLevel: 1 },
      ]),
    ).toEqual([
      { id: 'sharpness', minLevel: 6 },
      { id: 'mending', minLevel: 2 },
    ])
  })

  it('非法 maxLevel 被过滤（不产出无意义的判据）', () => {
    expect(
      overLimitEnchantments([
        { id: 'x', maxLevel: 0 },
        { id: 'y', maxLevel: NaN },
      ]),
    ).toEqual([])
  })

  it('生成的判据能直接喂给谓词拼装（端到端串起来）', () => {
    const predicates = overLimitEnchantments([{ id: 'sharpness', maxLevel: 5 }])
    const r = buildClearPredicate({ enchantments: predicates }, '1.21.4')
    expect(r.error).toBe(null)
    expect(r.predicate).toBe('minecraft:*[{enchantments:"minecraft:sharpness",levels:{min:6}}]')
    // 落到命令上即「查谁有 ≥6 级锋利」
    expect(
      buildClearCommand('Steve', { enchantments: predicates }, '1.21.4', 'probe').command,
    ).toBe('clear Steve minecraft:*[{enchantments:"minecraft:sharpness",levels:{min:6}}] 0')
  })
})
