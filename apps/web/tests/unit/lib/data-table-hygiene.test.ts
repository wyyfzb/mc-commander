/**
 * 数据表卫生：抄录自 wiki 的标记不得原样出现在界面文案里。
 *
 * 背景：`mc-gamerules.ts` 曾残留 60 处内链语法 `[[...]]` 与 5 处模板残余
 * `{{cmd|…}}` / `{{key|…}}` / `{{cd|…}}` / `{{tr|…|…}}`——抄录时把 wiki 语法带了进来，
 * 而它们会被**原样渲染给用户**（字符串里没有任何渲染步骤）。
 *
 * 这条守卫是硬要求而非可选：数据表按同一方式抄录，不加守卫下次抄录必然复发。
 * 判据只看源文件文本，不依赖任何运行时。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 路径锚在**本文件**而不是 process.cwd()：cwd 取决于从哪个目录发起 vitest
// （包根 / 仓库根 / CI 的 workspace 脚本），换个入口就会指到不存在的目录，
// 而失败信息只会说「ENOENT: scandir」，看不出是路径推导错了。
const LIB_DIR = join(import.meta.dirname, '..', '..', '..', 'src', 'lib')

/** 全部数据表模块（mc-*），排除测试与类型文件 */
function dataTableFiles(): string[] {
  return readdirSync(LIB_DIR)
    .filter((f) => f.startsWith('mc-') && f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
}

describe('数据表不得残留 wiki 标记', () => {
  it('存在可检查的数据表文件（守卫本身不能空转）', () => {
    // 若某天数据表改名/搬家，这条会先红，提示把守卫指到新位置，
    // 而不是让守卫静默地一个文件都不查
    expect(dataTableFiles().length).toBeGreaterThan(10)
  })

  it.each(dataTableFiles())('%s 中零 [[ 内链与 {{ 模板残留', (file) => {
    const src = readFileSync(join(LIB_DIR, file), 'utf8')
    const links = src.match(/\[\[/g) ?? []
    const templates = src.match(/\{\{/g) ?? []
    expect(links, `${file} 残留 wiki 内链 [[...]]：${links.length} 处`).toHaveLength(0)
    expect(templates, `${file} 残留 wiki 模板 {{...}}：${templates.length} 处`).toHaveLength(0)
  })
})
