/**
 * check-design-tokens.mjs 额度/档位采集内核的单测（第 21/27 条额度 + 第 23 条角色档位表）。
 *
 * 为什么要有：这些判定必须有单测钉住——额度记错一位会静默放行
 * 额度外的第 N 处、档位表解析错会让标题档位发散的页面静默通过，探针都发现不了。
 * 纯逻辑用例（node 环境）。
 */
import { describe, it, expect } from 'vitest'
import {
  baseTierOf,
  collectBareFocusHits,
  collectCardSurfaceOffsets,
  collectDangerousButtonBorderHits,
  collectFocusCancellationHits,
  collectHandwrittenAriaHits,
  collectHeadingTiers,
  collectRoleTierMaps,
  collectSmallTargetHits,
  collectTextBaseHits,
  collectTintAsInteractionHits,
  lineAt,
  overQuota,
  stripComments,
  titleBaseTiers,
} from '../gates/lib/design-token-rules.mjs'

describe('额度口径（第 21/27 条共用：额度放行前 N 处现场，不是白名单整个文件）', () => {
  it('额度外的第 N+1 处即报', () => {
    expect(overQuota([10, 20, 30], 1)).toEqual([20, 30])
  })

  it('未登记（undefined）即额度 0：一处即报', () => {
    expect(overQuota([10, 20], undefined)).toEqual([10, 20])
  })

  it('额度内全部放行、零现场不报', () => {
    expect(overQuota([10], 1)).toEqual([])
    expect(overQuota([], 3)).toEqual([])
  })
})

describe('第 21 条卡片面现场采集（判定标记 shadow-mcs-card）', () => {
  it('按现场数计，注释里的配方示例不算现场', () => {
    const code = stripComments(
      [
        '// 非卡片面共用 shadow-mcs-card 的现场须登记额度',
        "const a = cn('rounded-mcs-md shadow-mcs-card')",
        "const b = cn('shadow-mcs-card')",
        '/* shadow-mcs-card（块注释里的示例） */',
      ].join('\n'),
    )
    expect(collectCardSurfaceOffsets(code)).toHaveLength(2)
  })

  it('偏移量可回溯到 1 基行号（报错行号与编辑器一致）', () => {
    const code = ['const a = 1', "const b = cn('shadow-mcs-card')"].join('\n')
    expect(collectCardSurfaceOffsets(code).map((offset) => lineAt(code, offset))).toEqual([2])
  })
})

describe('第 27 条 text-base 现场采集（整词比对，额度按现场数而非行数）', () => {
  it('逐处命中并给出所在行号', () => {
    const content = ['<input className="text-base" />', '<textarea className="text-base" />'].join(
      '\n',
    )
    expect(collectTextBaseHits(content)).toEqual([{ line: 1 }, { line: 2 }])
  })

  it('同一行两处各计一次', () => {
    expect(collectTextBaseHits(`cn('text-base', 'text-base')`)).toHaveLength(2)
  })

  it('变体前缀与拼写看不见（已声明的宁漏不误报边界，不是白名单）', () => {
    expect(collectTextBaseHits(`cn('sm:text-base')`)).toEqual([])
    expect(collectTextBaseHits(`cn('text-base/')`)).toEqual([])
  })

  it('豁免额度只放行前 1 处：第 2 处即报（ui/input 现场口径）', () => {
    const content = ['cn("text-base")', 'cn("text-base")'].join('\n')
    expect(overQuota(collectTextBaseHits(content), 1)).toEqual([{ line: 2 }])
  })
})

describe('G23 角色档位表采集（档位不硬编码：改基座角色表即改口径）', () => {
  it('采集 as const 对象的字号档条目（档＝字号档后缀，与标题标签行的档同口径）', () => {
    const maps = collectRoleTierMaps(
      `const CARD_TITLE_TIERS = { heading: 'text-mcs-lg', label: 'text-mcs-sm' } as const`,
    )
    expect(maps.get('CARD_TITLE_TIERS')).toEqual(
      new Map([
        ['heading', 'lg'],
        ['label', 'sm'],
      ]),
    )
  })

  it('非 as const 的对象不采集（它不构成档位事实源）', () => {
    expect(collectRoleTierMaps(`const TIERS = { heading: 'text-mcs-lg' }`).size).toBe(0)
  })

  it('非字号档取值不进表：读不出档就不计档', () => {
    const maps = collectRoleTierMaps(
      `const TIERS = { heading: 'font-semibold', label: 'text-mcs-sm' } as const`,
    )
    expect(maps.get('TIERS')).toEqual(new Map([['label', 'sm']]))
  })
})

const CARD_BASE = [
  `const CARD_TITLE_TIERS = { heading: 'text-mcs-lg', label: 'text-mcs-sm' } as const`,
  `export function CardTitle({ variant = 'heading', className, children }) {`,
  `  return <h3 className={cn(CARD_TITLE_TIERS[variant], className)}>{children}</h3>`,
  `}`,
].join('\n')

const HEADER_BASE = `export function PageHeader({ title }) {\n  return <header className="text-mcs-xl">{title}</header>\n}`

describe('第 23 条档位解析：基座声明 → 调用点取档', () => {
  it('角色轴基座：默认角色取参数默认值，显式 variant 按调用点取档', () => {
    const [facet] = titleBaseTiers(CARD_BASE)
    expect(facet.name).toBe('CardTitle')
    expect(facet.defaultRole).toBe('heading')
    expect(baseTierOf(facet, '<CardTitle variant="label">')).toBe('sm')
    expect(baseTierOf(facet, '<CardTitle>')).toBe('lg')
  })

  it('variant 非字面量按缺省角色计档（表达式/跨行写的实际角色静态不可判）', () => {
    const [facet] = titleBaseTiers(CARD_BASE)
    expect(baseTierOf(facet, '<CardTitle variant={tier}>')).toBe('lg')
  })

  it('未登记角色不计档', () => {
    const [facet] = titleBaseTiers(CARD_BASE)
    expect(baseTierOf(facet, '<CardTitle variant="compact">')).toBeUndefined()
  })

  it('单档基座读组件体内承载标题的元素的首个字号档', () => {
    expect(titleBaseTiers(HEADER_BASE)).toEqual([{ name: 'PageHeader', tier: 'xl' }])
  })
})

describe('第 23 条标题档位采集（一层页内模块的静态近似）', () => {
  const PAGE = [
    `export default function DashboardPage() {`,
    `  return (<>`,
    `    <PageHeader title="仪表盘" />`,
    `    <CardTitle>概览</CardTitle>`,
    `    <h2 className="text-mcs-sm">明细</h2>`,
    `  </>)`,
    `}`,
  ].join('\n')

  it('页头 + 卡片标题 + 显式标签档 = 3 档（贴上限仍通过）', () => {
    const tiers = collectHeadingTiers([PAGE], [PAGE, HEADER_BASE, CARD_BASE])
    expect([...tiers].sort()).toEqual(['lg', 'sm', 'xl'])
  })

  it('再加一档 → 4 档（门禁判越界）', () => {
    const page = PAGE.replace('  </>)', `    <h3 className="text-mcs-md">汇总</h3>\n  </>)`)
    const tiers = collectHeadingTiers([page], [page, HEADER_BASE, CARD_BASE])
    expect(tiers.size).toBe(4)
  })

  it('判定面之外的模块不计档（已声明边界：只覆盖一层页内模块）', () => {
    const inner = `export function Widget() {\n  return <h4 className="text-mcs-2xs">子模块</h4>\n}`
    const page = `export default function P() {\n  return <Widget />\n}`
    // 未把子模块交进判定面 → 其标题档看不见（宁漏不误报）
    expect([...collectHeadingTiers([page], [page])]).toEqual([])
    // 门禁按一层导入把它交进来后即可见
    expect([...collectHeadingTiers([page, inner], [page, inner])]).toEqual(['2xs'])
  })

  it('基座只贡献档位查表，其自身的标题标签不计入同屏', () => {
    const sectionBase = `export function SectionHeader() {\n  return <h2 className="text-mcs-lg">区块</h2>\n}`
    const page = `export default function P() {\n  return <div>空页</div>\n}`
    // page 并未渲染 SectionHeader：基座里的 h2 不是页面标题
    expect([...collectHeadingTiers([page], [page, sectionBase])]).toEqual([])
    // 同一模块一旦进入判定面（页内模块），其标题标签才计入
    expect([...collectHeadingTiers([page, sectionBase], [page, sectionBase])]).toEqual(['lg'])
  })
})

describe('第 28 条：弱档危险描边 + 按钮语义同行采集', () => {
  it('手写危险按钮配方命中并给出所在行号', () => {
    const code = [
      'export function Bar() {',
      '  return <Button variant="outline" className="border-mcs-error-border" onClick={fn}>删除</Button>',
      '}',
    ].join('\n')
    expect(collectDangerousButtonBorderHits(stripComments(code))).toEqual([{ line: 2 }])
  })

  it('四类按钮语义标记均可触发（onClick / Button / 原生 button / role）', () => {
    for (const marker of ['onClick={fn}', '<Button', '<button', 'role="button"']) {
      const code = `<div className="border-mcs-error-border" ${marker} />`
      expect(collectDangerousButtonBorderHits(code)).toHaveLength(1)
    }
  })

  it('强档描边（-strong）不命中：那是变体与 tone 词表的声明域', () => {
    const code =
      '<Button variant="outline" className="border-mcs-error-border-strong" onClick={fn}>'
    expect(collectDangerousButtonBorderHits(code)).toEqual([])
  })

  it('无按钮语义的弱档描边（普通告警卡描边）不命中', () => {
    const code =
      '<div className="border border-mcs-error-border bg-mcs-error-bg-subtle px-3 py-2" />'
    expect(collectDangerousButtonBorderHits(code)).toEqual([])
  })

  it('注释里引用的配方示例不算现场（stripComments 后正文判定）', () => {
    const code = [
      '// 历史现场：variant="outline" + className="border-mcs-error-border" onClick={fn}',
      '/* 块注释里的配方示例：border-mcs-error-border 与 onClick={fn} 同行 */',
      'export const ok = 1',
    ].join('\n')
    expect(collectDangerousButtonBorderHits(stripComments(code))).toEqual([])
  })

  it('同行判定不跨行共现：描边与 onClick 分处两行不命中（防退化为全文共现判定）', () => {
    const code = [
      '<div className="border-mcs-error-border" />',
      '<Button onClick={fn}>删除</Button>',
    ].join('\n')
    expect(collectDangerousButtonBorderHits(stripComments(code))).toEqual([])
  })

  it('同一文件多现场各计一次，行号递增', () => {
    const code = [
      '<button className="border-mcs-error-border" onClick={fn}>a</button>',
      'const ok = 1',
      '<span role="button" className="border-mcs-error-border">b</span>',
    ].join('\n')
    expect(collectDangerousButtonBorderHits(stripComments(code))).toEqual([
      { line: 1 },
      { line: 3 },
    ])
  })

  it('剥离注释后行号仍与原文对齐（stripComments 等长替换，报错行号不得漂移）', () => {
    const code = [
      '// 前置注释占用第一行：variant="outline" + border-mcs-error-border onClick={fn}',
      '<Button className="border-mcs-error-border" onClick={fn}>x</Button>',
    ].join('\n')
    expect(collectDangerousButtonBorderHits(stripComments(code))).toEqual([{ line: 2 }])
  })
})

describe('第 29 条：交互元素裸取消 outline 采集', () => {
  it('outline-none + 按钮语义同行且无替换 → 命中', () => {
    const code =
      '<button type="button" className="rounded-mcs-xs px-2 outline-none" onClick={fn}>x</button>'
    expect(collectFocusCancellationHits(code)).toEqual([{ line: 1 }])
  })

  it('outline-hidden 同判（v4 的两种取消形）', () => {
    const code = '<div role="button" tabIndex={0} className="outline-hidden" onKeyDown={fn} />'
    expect(collectFocusCancellationHits(code)).toEqual([{ line: 1 }])
  })

  it('有 focus ring/outline 替换 → 放行（输入框与 skip-link 的既有形态）', () => {
    const withRing = '<input className="outline-none focus:ring-1 focus:ring-mcs-focus-ring" />'
    const withOutline =
      '<Button className="focus-visible:outline-none focus-visible:ring-2" onClick={fn}>'
    expect(collectFocusCancellationHits(withRing)).toEqual([])
    expect(collectFocusCancellationHits(withOutline)).toEqual([])
  })

  it('outline-none 但非交互元素（弹层面板）不判', () => {
    const code = '<div className="rounded-mcs-md bg-popover outline-none p-4" />'
    expect(collectFocusCancellationHits(code)).toEqual([])
  })
})

describe('第 29 条边界（替换口径与判定面分工）', () => {
  it('outline-none + 仅 outline 颜色类（假替换）不归本条：成对抵消由第 8 条判', () => {
    const code =
      '<button type="button" className="outline-none focus-visible:outline-mcs-focus-ring" onClick={fn}>x</button>'
    expect(collectFocusCancellationHits(code)).toEqual([])
  })

  it('focus-visible:outline-1 不算替换（须达全局兜底同级 2px 基线）→ 命中', () => {
    const code =
      '<button type="button" className="outline-none focus-visible:outline-1" onClick={fn}>x</button>'
    expect(collectFocusCancellationHits(code)).toEqual([{ line: 1 }])
  })

  it('表单控件也在判定面（命令面板输入框反例的形态）：裸取消命中', () => {
    const code = '<input data-slot="command-input" className="w-full text-sm outline-none" />'
    expect(collectFocusCancellationHits(code)).toEqual([{ line: 1 }])
  })

  it('表单控件带 ring 替换 → 放行', () => {
    const code = '<input className="outline-none focus-visible:ring-1 focus-visible:ring-ring" />'
    expect(collectFocusCancellationHits(code)).toEqual([])
  })

  it('属性逐个换行（className 在标签下方数行）同样命中，行号指向 className 行', () => {
    // 现实形态：give-item-ticket 的数量输入框。同行匹配看不见它——属性换行是常态写法
    const code = [
      '    <input',
      '      type="number"',
      '      aria-label="数量"',
      '      className="h-full w-9 outline-none"',
      '    />',
    ].join('\n')
    expect(collectFocusCancellationHits(code)).toEqual([{ line: 4 }])
  })

  it('跨行形态下带替换 → 放行（不得因换行误报）', () => {
    const code = [
      '    <input',
      '      type="number"',
      '      className="h-full outline-none focus-visible:ring-1"',
      '    />',
    ].join('\n')
    expect(collectFocusCancellationHits(code)).toEqual([])
  })

  it('字符串里的 `>` 不截断标签（aria-label 含大于号时仍能判到 className）', () => {
    const code = ['<input', '  aria-label="a > b"', '  className="outline-none"', '/>'].join('\n')
    expect(collectFocusCancellationHits(code)).toEqual([{ line: 3 }])
  })
})

describe('第 30 条：交互悬浮只走覆盖层（内容面 tint 不得上状态前缀）', () => {
  it('hover 上内容面 tint → 命中（ui/button destructive-outline 曾是现实反例）', () => {
    const code = "'border-mcs-error-border-strong bg-mcs-bg-secondary hover:bg-mcs-error-bg-subtle'"
    expect(collectTintAsInteractionHits(code)).toEqual([{ line: 1 }])
  })

  it('常驻面用 tint 不命中（那正是它的用途）', () => {
    expect(collectTintAsInteractionHits('<div className="bg-mcs-error-bg-subtle" />')).toEqual([])
  })

  it('覆盖层档放行：state-hover 与危险族专用档都不是 tint', () => {
    expect(collectTintAsInteractionHits('a hover:bg-mcs-state-hover b')).toEqual([])
    expect(collectTintAsInteractionHits('a hover:bg-mcs-state-hover-error b')).toEqual([])
  })

  it('各类状态前缀都命中（含组合前缀与 group/dark 变体）', () => {
    const cases = [
      'focus-visible:bg-mcs-accent-bg-subtle',
      'group-hover:bg-mcs-purple-bg-subtle',
      'dark:hover:bg-mcs-info-bg-subtle',
      'active:bg-mcs-success-bg-subtle',
    ]
    for (const c of cases) expect(collectTintAsInteractionHits(c), c).toEqual([{ line: 1 }])
  })

  it('选中态用内容面 tint 是正当的，不拦（data-[state=active] 与 hover 语义不同）', () => {
    // tone.ts 的 TONE_SELECTED_* 就是「bg-subtle 表已选中」——那是常驻面不是悬浮覆盖层。
    // 这条放行是故意的、且正则本身看不出意图，改正则的人无从得知，故显式钉住
    expect(collectTintAsInteractionHits('data-[state=active]:bg-mcs-accent-bg-subtle')).toEqual([])
  })

  it('行号逐行报（只报命中那一行，其余行不牵连）', () => {
    const code = ['<div className="p-2" />', '<button className="hover:bg-mcs-error-bg-subtle" />']
    expect(collectTintAsInteractionHits(code.join('\n'))).toEqual([{ line: 2 }])
  })
})

describe('第 31 条：自造 ARIA 交互组件', () => {
  it('手写 switch / tablist / listbox / combobox 命中', () => {
    for (const role of ['switch', 'tablist', 'listbox', 'combobox', 'menu', 'radiogroup']) {
      const code = `<div role="${role}" />`
      expect(collectHandwrittenAriaHits(code), role).toEqual([{ line: 1, role }])
    }
  })

  it('role="button" 不判（自定义可点容器是合理选择）', () => {
    expect(collectHandwrittenAriaHits('<div role="button" tabIndex={0} />')).toEqual([])
  })

  it('注释里的写法示例不算现场（判定面是剥离注释后的正文）', () => {
    const raw = '/** 不要手写 role="switch" */\n<div className="x" />'
    expect(collectHandwrittenAriaHits(stripComments(raw), raw)).toEqual([])
  })

  it('@design-system-ok 豁免：写明理由即放行', () => {
    const raw =
      '/** @design-system-ok: 焦点须常驻输入框，弹层模型不适用 */\n<div role="combobox" />'
    expect(collectHandwrittenAriaHits(stripComments(raw), raw)).toEqual([])
  })

  it('空理由不放行（豁免不能变成随手加的静音开关）', () => {
    const raw = '/** @design-system-ok: */\n<div role="combobox" />'
    expect(collectHandwrittenAriaHits(stripComments(raw), raw)).toEqual([
      { line: 2, role: 'combobox' },
    ])
  })
})

describe('第 32 条：指针目标 <24×24（WCAG 2.2 SC 2.5.8）', () => {
  it('按钮上的 size-4 / w-5 / h-5 命中', () => {
    expect(collectSmallTargetHits('<button className="size-4" onClick={fn} />')).toEqual([
      { line: 1 },
    ])
    expect(collectSmallTargetHits('<button className="w-5" onClick={fn} />')).toEqual([{ line: 1 }])
  })

  it('h-6 / size-6（24px）不判', () => {
    expect(collectSmallTargetHits('<button className="size-6" onClick={fn} />')).toEqual([])
    expect(collectSmallTargetHits('<button className="h-6 w-6" onClick={fn} />')).toEqual([])
  })

  it('非交互元素上的图标尺寸不判（纯装饰）', () => {
    expect(collectSmallTargetHits('<Minus className="size-3" aria-hidden />')).toEqual([])
  })

  it('aria-hidden 的标记不判（即便同行有按钮语义）', () => {
    expect(
      collectSmallTargetHits(
        '<button onClick={fn}><Minus className="size-3" aria-hidden /></button>',
      ),
    ).toEqual([])
  })
})

describe('第 33 条：焦点样式用 focus: 而非 focus-visible:', () => {
  it('focus:ring-1 命中', () => {
    expect(
      collectBareFocusHits('<input className="focus:ring-1 focus:ring-mcs-focus-ring" />'),
    ).toEqual([{ line: 1 }])
  })

  it('focus-visible: 不判', () => {
    expect(
      collectBareFocusHits(
        '<input className="focus-visible:ring-1 focus-visible:ring-mcs-focus-ring" />',
      ),
    ).toEqual([])
  })

  it('同 className 内已有 focus-visible: 时放行（两档并存是允许的）', () => {
    expect(collectBareFocusHits('className="focus:border-x focus-visible:ring-1"')).toEqual([])
  })
})
