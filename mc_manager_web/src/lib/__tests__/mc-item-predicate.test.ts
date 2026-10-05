import { describe, it, expect } from 'vitest'
import { buildClearPredicate, buildClearCommand, overLimitEnchantments } from '../mc-item-predicate'

/**
 * 物品查缴谓词拼装（条目 8 的可离线交付部分）。
 *
 * 重点钉住**官方语法形态**——条目备注明确记录了一处「联网搜索给的形状是错的」，
 * 故这里把正确形态与两个常见错形都写成断言，防止后人照抄错形。
 */
/**
 * 形态断言全部对照 **MC 1.21.4 真实服务端**（实机取模，原文见
 * `.ai/References/2026-10-05-实机取模样本.md`）。此前的断言锁的是**臆想的形态**——
 * 三条「正确形态」在真实服务端全部被拒，是典型的「夹具把不存在的形状固化成契约」。
 */
describe('buildClearPredicate - 对照真实服务端的形态', () => {
  it('仅物品 id：不带组件时就是裸 id', () => {
    expect(buildClearPredicate({ itemId: 'diamond' }, '1.21.4')).toEqual({
      predicate: 'minecraft:diamond',
      error: null,
    })
  })

  it('通配用**裸 `*`**（旧实现写的 `minecraft:*` 被服务端拒）', () => {
    // 实测：`clear <玩家> * 0` → Found 8 matching item(s)
    //       `clear <玩家> minecraft:* 0` → Unknown item 'minecraft:'
    expect(buildClearPredicate({ itemId: undefined, enchantments: [] }, '1.21.4').error).toBe(
      'empty-predicate',
    )
    expect(
      buildClearPredicate({ enchantments: [{ id: 'mending', minLevel: 1, maxLevel: 1 }] }, '1.21.4')
        .predicate,
    ).toBe('*[enchantments={levels:{"minecraft:mending":1}}]')
  })

  it('附魔条件写成 `[enchantments={levels:{"<附魔 id>":<等级>}}]`', () => {
    // 实测可用形态：→ Found 2 matching item(s) on player ItemHoldA
    expect(
      buildClearPredicate(
        { itemId: 'diamond_sword', enchantments: [{ id: 'sharpness', minLevel: 5, maxLevel: 5 }] },
        '1.21.4',
      ).predicate,
    ).toBe('minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5}}]')
  })

  it('多个附魔条件合并进**同一个** levels 映射', () => {
    // 实测该形态被服务端接受（匹配与否取决于物品实际附魔）
    expect(
      buildClearPredicate(
        {
          itemId: 'diamond_sword',
          enchantments: [
            { id: 'sharpness', minLevel: 5, maxLevel: 5 },
            { id: 'unbreaking', minLevel: 3, maxLevel: 3 },
          ],
        },
        '1.21.4',
      ).predicate,
    ).toBe(
      'minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":5,"minecraft:unbreaking":3}}]',
    )
  })

  it('区间（≥N / ≤N / N~M）表达不出来 ⇒ 明确报错，不拼必被拒的命令', () => {
    // 实测：`levels:{min:6}` → Malformed …: Not a number missed input: {min:6}
    //       `levels:{"minecraft:sharpness":{min:6}}` → 同上
    // 「≥N 级」是一个能力缺口，不是拼装细节——见本文件尾部的说明
    for (const e of [
      { id: 'sharpness', minLevel: 6 },
      { id: 'sharpness', maxLevel: 2 },
      { id: 'sharpness', minLevel: 3, maxLevel: 7 },
    ]) {
      expect(buildClearPredicate({ enchantments: [e] }, '1.21.4')).toEqual({
        predicate: null,
        error: 'unsupported-level-range',
      })
    }
  })

  it('min > max 仍先报更具体的 invalid-level-range', () => {
    expect(
      buildClearPredicate(
        { enchantments: [{ id: 'sharpness', minLevel: 7, maxLevel: 3 }] },
        '1.21.4',
      ).error,
    ).toBe('invalid-level-range')
  })

  it('不带等级的附魔条件（「带该附魔即可」）同样不可表达 ⇒ 报错', () => {
    // levels 映射的值必须是数字，无法表达「任意等级」
    expect(buildClearPredicate({ enchantments: [{ id: 'mending' }] }, '1.21.4')).toEqual({
      predicate: null,
      error: 'unsupported-level-range',
    })
  })

  it('物品 id + 附魔条件可同时给出', () => {
    expect(
      buildClearPredicate(
        { itemId: 'diamond_sword', enchantments: [{ id: 'sharpness', minLevel: 6, maxLevel: 6 }] },
        '1.20.6',
      ).predicate,
    ).toBe('minecraft:diamond_sword[enchantments={levels:{"minecraft:sharpness":6}}]')
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

  it('挂端判据（≥上限+1）**不能**直接喂给谓词拼装——这是已登记的能力缺口', () => {
    // 实测：`levels:{min:6}` 与 `levels:{"id":{min:6}}` 都被服务端拒（Not a number）
    // ⇒ 「≥N 级」在一条命令里表达不出来。原实现拼了 `{min:N}`，发出去必然被拒。
    // 缺口如何补属产品决策（未定），故这里如实断言「拼不出来」而不是假装能拼。
    const predicates = overLimitEnchantments([{ id: 'sharpness', maxLevel: 5 }])
    expect(predicates).toEqual([{ id: 'sharpness', minLevel: 6 }])
    expect(buildClearPredicate({ enchantments: predicates }, '1.21.4')).toEqual({
      predicate: null,
      error: 'unsupported-level-range',
    })
    // 命令层同样拒绝，不会拼出一条必然被服务端拒的命令
    expect(
      buildClearCommand('Steve', { enchantments: predicates }, '1.21.4', 'probe').command,
    ).toBe(null)
  })
})
