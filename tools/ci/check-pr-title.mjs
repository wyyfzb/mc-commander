#!/usr/bin/env node
/**
 * PR 标题校验：必须是 Conventional Commits 格式。
 *
 * 仓库只用 squash 合并，PR 标题会成为 `main` 上的那条提交，也是 release-please
 * 唯一的解析输入。标题格式不对（类型拼错、非本仓库约定的类型、冒号后没写描述）时
 * release-please **不报错**，只是把这条改动当不存在——不 bump 版本、不进 CHANGELOG。
 * 那种漏发没有任何信号，所以在这里拦。
 *
 * 用法：node tools/ci/check-pr-title.mjs "<PR 标题>"
 * 退出码 0 = 通过；1 = 格式不合规（stderr 给可执行的修改建议）。
 */
import { pathToFileURL } from 'node:url'

/** release-please 认的全部类型；不在表内的一律视为「不会被记账」 */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'perf',
  'revert',
  'refactor',
  'docs',
  'chore',
  'test',
  'build',
  'ci',
  'style',
]

/** `<type>[(scope)][!]: <描述>`；冒号后必须有一个空格，描述不得为空 */
const PATTERN = /^([a-z]+)(?:\(([^()]+)\))?(!)?: (\S.*)$/

/**
 * 校验一个 PR 标题。
 * @param {string | null | undefined} title 来自 `github.event.pull_request.title`，可能为空
 * @returns {{ ok: true } | { ok: false, reason: string, hint: string }}
 */
export function checkPrTitle(title) {
  const trimmed = String(title ?? '').trim()
  if (trimmed === '') {
    return {
      ok: false,
      reason: '标题为空',
      hint: '按 Conventional Commits 填写，如 `feat(web): …`',
    }
  }
  const match = PATTERN.exec(trimmed)
  if (!match) {
    return {
      ok: false,
      reason: '不是 Conventional Commits 格式',
      hint: '形如 `feat(web): 玩家详情新增成就标签页`（冒号后要有空格，描述不能为空）',
    }
  }
  const type = match[1]
  if (!COMMIT_TYPES.includes(type)) {
    return {
      ok: false,
      reason: `类型 \`${type}\` 不在仓库约定的类型内`,
      hint: `可用：${COMMIT_TYPES.join(' / ')}`,
    }
  }
  return { ok: true }
}

// 作为 CLI 直接运行（CI 与本地均此形态）；被单测 import 时不执行。
// 用 pathToFileURL 而非拼 `file://`：Windows 的盘符路径拼出来是 `file://D:/…`，
// 而 import.meta.url 是 `file:///D:/…`，字符串比较会永远不等（CLI 静默不执行）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = process.argv.slice(2).join(' ')
  const result = checkPrTitle(title)
  if (result.ok) process.exit(0)
  console.error(`PR 标题不合规：${result.reason}`)
  console.error(`  标题：${title || '(空)'}`)
  console.error(`  改法：${result.hint}`)
  console.error('  原因：squash 合并后 PR 标题就是 main 上的提交信息，格式错会静默漏发版')
  process.exit(1)
}
