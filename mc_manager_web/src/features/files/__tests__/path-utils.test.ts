/**
 * parentDirOf 契约测试（I 类「两处各写一份公式」的技术债收编，见 path-utils.ts 注释）
 * 口径：'/' 前缀风格，根/无斜杠一律归一为 '/'。
 */
import { describe, it, expect } from 'vitest'
import { normalizeDirInput, parentDirOf } from '../path-utils'

describe('parentDirOf', () => {
  it('嵌套路径取上一级', () => {
    expect(parentDirOf('/a/b')).toBe('/a')
    expect(parentDirOf('/a/b/c.txt')).toBe('/a/b')
  })

  it('根目录下一级 → 根（不返回空串）', () => {
    expect(parentDirOf('/a')).toBe('/')
    expect(parentDirOf('/a.txt')).toBe('/')
  })

  it('无斜杠路径 → 根（列表请求的 dir 参数不接受空串）', () => {
    expect(parentDirOf('a.txt')).toBe('/')
    expect(parentDirOf('')).toBe('/')
  })

  it('相对路径取上一级（保留相对语义）', () => {
    expect(parentDirOf('a/b')).toBe('a')
  })

  /**
   * 反斜杠路径（旧版服务端 / win32 的 `path.join` 出参）也必须取对父目录。
   *
   * 只切 '/' 时 `\plugins\Foo\config.yml` 的 lastIndexOf('/') 是 -1 → 一律回退 '/',
   * 于是重命名/移动把它拼成 `/config.yml` **静默搬到实例根**，缓存失效目录也错位。
   * 本仓服务端现已统一输出 '/'（toVirtualPath），这条守的是「连旧服务端」的兼容面。
   */
  it('反斜杠分隔同样取对父目录（兼容旧服务端出参与 win32）', () => {
    expect(parentDirOf('\\plugins\\Foo\\config.yml')).toBe('/plugins/Foo')
    expect(parentDirOf('\\server.properties')).toBe('/')
    expect(parentDirOf('world\\level.dat')).toBe('world')
  })
})

/**
 * normalizeDirInput 契约（文件「移动到…」的目标目录输入）。
 *
 * 判据是「只拦显然错的形态」：非 `/` 开头、`.`/`..` 段、控制字符、反斜杠。
 * **不**校验存在性/越界/同名冲突——那些由服务端裁决（resolveInstancePath + noClobber），
 * 前端预判只会与服务端口径漂移。故「/不存在的目录」必须放行：它由服务端回错误码。
 */
describe('normalizeDirInput', () => {
  it('合法目录：保留、去首尾与重复斜杠、根目录归一为 /', () => {
    expect(normalizeDirInput('/plugins')).toBe('/plugins')
    expect(normalizeDirInput('/a/b')).toBe('/a/b')
    expect(normalizeDirInput('/plugins/')).toBe('/plugins')
    expect(normalizeDirInput('/plugins//')).toBe('/plugins')
    expect(normalizeDirInput('/')).toBe('/')
    expect(normalizeDirInput('  /plugins  ')).toBe('/plugins')
  })

  /**
   * 全斜杠输入归一为根 `/`，**不得**返回空串。
   *
   * 空串曾是一条静默改目的地的通路：它既不被调用点判为 null（放行），又不以 `/` 开头，
   * 拼出的 `newPath` 是 `/名称` —— 文件被搬到实例根，toast 还显示成「已移动到 」。
   * 输入 `/` 本就无歧义（目标只能是根），故判定「全斜杠 ⇒ 根」而不是拒绝。
   */
  it('全斜杠输入归一为根 /（不得返回空串）', () => {
    for (const input of ['//', '///', '////']) {
      expect(normalizeDirInput(input)).toBe('/')
    }
    expect(normalizeDirInput(' // ')).toBe('/')
  })

  it('不校验存在性：不存在的目录放行，由服务端裁决', () => {
    expect(normalizeDirInput('/definitely-not-here')).toBe('/definitely-not-here')
  })

  it('非 / 开头一律拒（服务端口径是绝对路径风格）', () => {
    expect(normalizeDirInput('plugins')).toBeNull()
    expect(normalizeDirInput('')).toBeNull()
    expect(normalizeDirInput('   ')).toBeNull()
    expect(normalizeDirInput('./plugins')).toBeNull()
  })

  it('`.` / `..` 段拒（路径穿越的两种写法）', () => {
    expect(normalizeDirInput('/a/../b')).toBeNull()
    expect(normalizeDirInput('/..')).toBeNull()
    expect(normalizeDirInput('/a/./b')).toBeNull()
    expect(normalizeDirInput('/.')).toBeNull()
    // 只是名字里含点不算穿越
    expect(normalizeDirInput('/a.b')).toBe('/a.b')
    expect(normalizeDirInput('/...')).toBe('/...')
  })

  /**
   * 反斜杠用 `\\`（转义后是一个反斜杠 U+005C）。写成 '/a\b' 会变成**退格符** U+0008，
   * 被 \x00-\x1f 那条覆盖面顺手拦下——测名宣称的「Windows 分隔符」实则零覆盖，
   * 删掉正则里的 `\\` 分支也照样绿（实测）。故此处显式用双反斜杠。
   */
  it('反斜杠与控制字符拒（Windows 分隔符与 NUL 注入面）', () => {
    expect(normalizeDirInput('/a\\b')).toBeNull()
    expect(normalizeDirInput('\\plugins')).toBeNull()
    expect(normalizeDirInput('/a\u0000b')).toBeNull()
    expect(normalizeDirInput('/a\nb')).toBeNull()
  })
})
