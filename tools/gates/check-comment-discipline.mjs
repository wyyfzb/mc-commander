#!/usr/bin/env node
/**
 * 注释纪律门禁：把「注释里不得写什么」写成可执行判据。
 *
 * 为什么需要它：这条纪律此前只活在文字里，靠人当场判断「这算不算违规」——
 * 判断就有分歧，分歧就漏，于是同一类问题反复出现。判据能机械化的部分交给脚本，
 * 剩下的语义部分（是否复述代码、是否该留）仍由审查把关。
 *
 * 判定面，**只收零歧义形态**：每加一条模糊规则，误报就会训练人忽略整道门禁。
 *   ① 编号式引用——`issue #309`、`(#326)`、`清单 #27`、`S-P1-2`、`Phase 2`、`feat-4`
 *      一类。它们对仓库读者不可解析，且会随 issue 迁移、仓库改名而漂移。
 *   ② 演化叙述——「此前 / 原先 / 旧实现 / 自某文件原样迁入」这类时间轴，以及「谁提出、
 *      哪天定的」（`owner`、`拍板`、`裁定`）。读者要的是当前实现是什么，不是它从哪来。
 *   ③ 私有工作区指针——`.ai/<目录>/` 这类指路（**顶层排除规则不算**：格式化与目录门禁
 *      必须写明被排除的路径，那是配置事实），以及指向入库面之外文档的**死指针**。
 *   ④ 待办承诺——`TODO`/`FIXME`/`HACK` 标记；未做的事有自己的家（任务清单）。
 * 判定面越靠后越需要「可解析性」这类客观判据；语义部分（是否复述代码、是否该留）仍由审查把关。
 *
 * 用法：`node tools/gates/check-comment-discipline.mjs`（位置无关，仓库根按 `.git` 向上发现）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function findRepoRoot(from) {
  let d = resolve(from)
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const parent = dirname(d)
    if (parent === d) throw new Error(`向上未找到 .git，起点：${from}`)
    d = parent
  }
}

const ROOT = findRepoRoot(SCRIPT_DIR)

/** 判定面＝入库文本文件；产物与锁文件不在其列 */
const SCANNED_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|sh|bash|json|jsonc|yml|yaml|css|md|html)$/

/**
 * 逐文件的豁免：这三处出现的违规形态是**判定对象本身**，不是违规。
 * 除此之外不设豁免——「某文件已豁免」会连带放过它新增的违规。
 */
const FILE_EXEMPT = new Map([
  ['CHANGELOG.md', 'release-please 生成，内容由提交信息与 PR 号构成'],
  ['AGENTS.md', '纪律正文本身要举例说明哪些形态被禁止'],
  ['tools/gates/check-comment-discipline.mjs', '判定面本身要列出被拦截的形态'],
  ['apps/web/tests/unit/token-integrity.test.ts', '编号是用例的输入数据（验证剥离逻辑）'],
])

const RULES = [
  {
    id: '编号引用',
    hint: '换成它承载的那句事实（如「一次性令牌，通过即作废」），不要留编号',
    re: /\bissues?\s*#?\d+|\bPR\s*#?\d+|\(#\d+\)|清单\s*#\d+|条目\s*\d+|\bS-P\d-\d+|\bPhase\s*\d|\bfeat-\d+/,
  },
  {
    id: '演化叙述',
    hint: '直接写当前实现方式（如「字段由配置注入，不再依赖解析」），不写它从哪来',
    // 判定面＝**时间轴词**。反例本身允许留（「行内匹配会把 #eula=true 算作同意」），
    // 但要说成约束而不是「旧实现如何」——去掉主体后信息不丢，故本判据零歧义。
    // 前视排除「因此前」：那是「因此 + 前端」，不是时间轴。
    // 后两项是重构叙述（「自 X 原样迁入」「行为不变迁移」），同属时间轴；
    // 「迁移」本身不拦——DB 迁移、JSON 迁移是世界事实（判据须带「自 <路径>」或「行为不变」）。
    // 「旧命名」「旧字段」「旧路径」等同样不拦：它们多指 MC 或存量数据的既有形态。
    // 后段收「已收敛到 / 现改为 / 原为 / 收敛前」这类**重构叙述**——它们与「此前」同形，
    // 都是在讲改动过程；「还原为 X」「提交前检查」是动作描述，故用前视/后视排除。
    re: /(?<!因)此前|原先|旧实现|取代原先|纯搬移|纯移动|零行为变更|零改动|零变化|自 [A-Za-z0-9_./-]+ ?(?:原样)?(?:迁入|搬移)|行为不变迁移|零样式变更|已收敛(?:到|为|至)|(?:现|已)改为|(?<!还)原为|原本是|收敛前|收口前|重构前|抽取前|改造前|拆分前/,
  },
  {
    id: '归属叙述',
    hint: '去掉「谁提出、哪天定的」——读者需要的是当前实现与它的硬约束',
    // 词边界两侧排除标识符与占位符：GITEE_OWNER、<owner>、ownership 都不算
    re: /(?<![A-Za-z_<])(?:owner|拍板|裁定)(?![A-Za-z_>])/i,
  },
  {
    id: '私有指针',
    hint: '就地用最短一句写清要交代的背景，不指路到私有工作区',
    re: /\.ai\/[A-Za-z0-9_-]+\//,
  },
  {
    id: '待办承诺',
    hint: '未做的事写进任务清单：注释不承诺「以后补」，只写当前实现与它的硬约束',
    // 只收大写标记——领域词（「待办清单」功能、todo 列表）不在此列。
    re: /\b(?:TODO|FIXME|HACK)\b/,
  },
]

/**
 * 指针可解析性：指路必须落在**入库面**里，否则是死指针。
 * 两类形态：带扩展名的路径按仓库根 / 所在目录 / 全仓 basename 三路解析；
 * 私有文档的裸名（「设计文档 §4.5」）在入库面无同名文档时即为死指针——
 * 该清单随入库面自愈：一旦真的收了同名文档，这一项自动不再命中。
 */
const POINTER_NAMES = [
  '设计文档',
  '设计规范',
  '审查指南',
  '审查清单',
  '设计基准',
  'pending-improvements',
  'scan-patterns',
]

const MD_REF = /(?<![\w/.-])([A-Za-z0-9_][A-Za-z0-9_./-]*\.md)\b/g

function trackedFiles() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(sep).join('/'))
    .filter((p) => SCANNED_EXT.test(p))
}

const violations = []
const FILES = trackedFiles()
// 入库面里所有文档的 basename：裸文档名靠它判定是否可解析
const MD_BASENAMES = new Set(FILES.filter((f) => f.endsWith('.md')).map((f) => f.split('/').pop()))

/** 私有文档裸名是否在入库面里有同名文档 */
const nameResolvable = (name) => MD_BASENAMES.has(`${name}.md`)

/** 带扩展名的引用是否指向入库面里真实存在的文件 */
const mdRefResolvable = (ref, fromFile) =>
  [
    resolve(ROOT, ref.replace(/^\//, '')),
    resolve(ROOT, 'docs', ref),
    resolve(ROOT, dirname(fromFile), ref),
  ].some((p) => existsSync(p)) || MD_BASENAMES.has(ref.split('/').pop())

for (const file of FILES) {
  if (FILE_EXEMPT.has(file)) continue
  let text
  try {
    text = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    continue // 已删但未提交：纯删除不算违规（与目录门禁同一口径）
  }
  text.split('\n').forEach((line, i) => {
    const at = { file, line: i + 1, text: line.trim() }
    for (const rule of RULES) {
      if (rule.re.test(line)) violations.push({ ...at, rule })
    }
    // 指针可解析性：死指针与死文档名分开报，理由不同
    for (const m of line.matchAll(MD_REF)) {
      const ref = m[1]
      if (/^https?:/.test(ref)) continue
      if (!mdRefResolvable(ref, file)) {
        violations.push({
          ...at,
          rule: {
            id: '死指针',
            hint: `「${ref}」不在入库面里——就地写清那句话，或改指真实存在的文件`,
          },
        })
      }
    }
    for (const name of POINTER_NAMES) {
      if (line.includes(name) && !nameResolvable(name)) {
        violations.push({
          ...at,
          rule: {
            id: '死指针',
            hint: `「${name}」是私有工作区文档，入库面无同名文件——把那句规则就地写清`,
          },
        })
      }
    }
  })
}

if (violations.length === 0) {
  console.log(
    `✓ 注释纪律门禁通过：${trackedFiles().length} 个文件（豁免 ${FILE_EXEMPT.size} 个判定对象）`,
  )
  process.exit(0)
}

console.error(`✗ 注释纪律门禁失败：${violations.length} 处\n`)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  【${v.rule.id}】`)
  console.error(`      ${v.text.slice(0, 100)}`)
  console.error(`      → ${v.rule.hint}\n`)
}
process.exit(1)
