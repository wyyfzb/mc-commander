/**
 * check-design-tokens.mjs 额度/档位采集内核的单测（第 21/27 条额度 + 第 23 条角色档位表）。
 *
 * 为什么要有：这些判定此前只有「临时植入违规看门禁红」的探针证据——额度记错一位会静默放行
 * 额度外的第 N 处、档位表解析错会让标题档位发散的页面静默通过，探针都发现不了。
 * 纯逻辑用例（node 环境，见 vite.config.ts 的 NODE_ENV_TESTS）。
 */
import { describe, it, expect } from 'vitest'
import {
  baseTierOf,
  collectCardSurfaceOffsets,
  collectHeadingTiers,
  collectRoleTierMaps,
  collectTextBaseHits,
  lineAt,
  overQuota,
  stripComments,
  titleBaseTiers,
} from '../lib/design-token-rules.mjs'

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
    const content = ['<input className="text-base" />', '<textarea className="text-base" />'].join('\n')
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
    const maps = collectRoleTierMaps(`const TIERS = { heading: 'font-semibold', label: 'text-mcs-sm' } as const`)
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
