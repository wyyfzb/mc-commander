/**
 * 载荷组装器的「契约导入自检」单测。
 *
 * 为什么要有：服务端 import 了契约包没导出的名字时，产物能打出来、也能装上，
 * 但面板进程一加载就崩（`does not provide an export named ...`）——只有真正跑起来才暴露。
 * 这道自检把它提前到打包现场。
 *
 * 判据是 Node 的真实模块链接，因此这些用例断言的是「链接成功/失败」，
 * 而不是某种文本形态：注释里的 import、导入项内的注释、re-export、默认导入都在判定面内。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { findUnlinkableContractImports } from '../deploy/stage-payload.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIRS = []

/** 造一份「已构建好的 dist」：内容是合法 ESM */
function distWith(decls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dist-'))
  DIRS.push(dir)
  const file = path.join(dir, 'index.js')
  fs.writeFileSync(file, decls)
  return file
}

const REAL = 'export const PANEL_PORT = 25566\nexport function helper() {}\n'

/** 便捷：跑一次判定，返回缺失原因数组 */
const check = (code, dist) => findUnlinkableContractImports([{ rel: 'a.js', code }], dist)

describe('findUnlinkableContractImports', () => {
  afterAll(() => {
    for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true })
  })

  it('导入的名字全都在 → 链接成功', () => {
    const dist = distWith(REAL)
    expect(check('import { PANEL_PORT, helper } from "@mc-commander/schemas"\n', dist)).toEqual([])
  })

  it('导入未导出的名字 → 链接失败并报出该名字', () => {
    const dist = distWith(REAL)
    const bad = check('import { PANEL_PORT, NOPE } from "@mc-commander/schemas"\n', dist)
    expect(bad).toHaveLength(1)
    expect(bad[0].rel).toBe('a.js')
    expect(bad[0].reason).toContain('NOPE')
  })

  it('默认导入 + 具名缺项同样拦得下（正则只看花括号里的内容，会漏掉这类形态）', () => {
    const dist = distWith(`${REAL}export default 1\n`)
    const bad = check('import D, { MISSING } from "@mc-commander/schemas"\n', dist)
    expect(bad).toHaveLength(1)
    expect(bad[0].reason).toContain('MISSING')
  })

  it('默认导入而 dist 没有 default → 同样算链接失败（装到用户机上会崩）', () => {
    const dist = distWith(REAL)
    const bad = check('import D from "@mc-commander/schemas"\n', dist)
    expect(bad).toHaveLength(1)
    expect(bad[0].reason).toContain('default')
  })

  it('re-export 缺项同样拦得下（`export {...} from` 不经过本地绑定）', () => {
    const dist = distWith(REAL)
    const bad = check('export { PANEL_PORT, MISSING } from "@mc-commander/schemas"\n', dist)
    expect(bad).toHaveLength(1)
    expect(bad[0].reason).toContain('MISSING')
  })

  it('注释里的 import 不参与判定（文本匹配会在这里误报）', () => {
    const dist = distWith(REAL)
    const code = '// import { GHOST } from "@mc-commander/schemas"\nexport const x = 1\n'
    expect(check(code, dist)).toEqual([])
  })

  it('导入项里的注释不干扰判定', () => {
    const dist = distWith(REAL)
    expect(
      check('import { PANEL_PORT /* 端口段 */, helper } from "@mc-commander/schemas"\n', dist),
    ).toEqual([])
  })

  it('与契约包无关的导入不在判定面内（本地模块由 Node 自行解析或跳过）', () => {
    const dist = distWith(REAL)
    expect(check('import { anything } from "./local.js"\n', dist)).toEqual([])
  })
})
