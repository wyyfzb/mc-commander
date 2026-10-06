/**
 * 数据包命令面：拼装 + 解析。
 *
 * 全部夹具都是 **MC 26.3 实机返回的逐字原文**（含把多行拼成一行后的形态）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildDatapackListCommand,
  buildDatapackEnableCommand,
  buildDatapackDisableCommand,
  buildDatapackCreateCommand,
  parseDatapackList,
  parseDatapackAction,
  supportsDatapackCreate,
} from '../mc-datapack'

describe('datapack 命令拼装', () => {
  it('list 三个域', () => {
    expect(buildDatapackListCommand()).toBe('datapack list')
    expect(buildDatapackListCommand('available')).toBe('datapack list available')
    expect(buildDatapackListCommand('enabled')).toBe('datapack list enabled')
  })

  it('enable：名字加引号（实测含 `/` 的名字必须加引号）', () => {
    expect(buildDatapackEnableCommand('file/uatpack.zip')).toEqual({
      command: 'datapack enable "file/uatpack.zip"',
      error: null,
    })
    expect(buildDatapackEnableCommand('vanilla')).toEqual({
      command: 'datapack enable "vanilla"',
      error: null,
    })
  })

  it('enable：排序位置三种形态', () => {
    expect(buildDatapackEnableCommand('file/a.zip', { at: 'last' }).command).toBe(
      'datapack enable "file/a.zip" last',
    )
    expect(buildDatapackEnableCommand('file/a.zip', { at: 'first' }).command).toBe(
      'datapack enable "file/a.zip" first',
    )
    expect(
      buildDatapackEnableCommand('file/a.zip', { at: 'before', existing: 'vanilla' }).command,
    ).toBe('datapack enable "file/a.zip" before "vanilla"')
    expect(
      buildDatapackEnableCommand('file/a.zip', { at: 'after', existing: 'file/b.zip' }).command,
    ).toBe('datapack enable "file/a.zip" after "file/b.zip"')
  })

  it('disable：不拦 vanilla（实测服务端允许 disable vanilla）', () => {
    expect(buildDatapackDisableCommand('vanilla')).toEqual({
      command: 'datapack disable "vanilla"',
      error: null,
    })
  })

  it('create：描述一律加引号（实测不加引号的多词描述被拒）', () => {
    expect(buildDatapackCreateCommand('uatcreated', 'UAT 新建数据包')).toEqual({
      command: 'datapack create uatcreated "UAT 新建数据包"',
      error: null,
    })
  })

  it.each([
    ['名字含空格', 'my pack.zip'],
    ['名字含引号（命令注入面）', 'a"b'],
    ['名字含分号', 'a;b'],
    ['名字以斜杠开头', '/etc/passwd'],
    ['名字含换行', 'a\nb'],
    ['空名字', ''],
  ])('enable/disable 拒绝非法名字：%s', (_label, name) => {
    expect(buildDatapackEnableCommand(name).error).toBe('invalid-name')
    expect(buildDatapackDisableCommand(name).error).toBe('invalid-name')
    expect(buildDatapackEnableCommand(name).command).toBe(null)
  })

  it('enable 的参照包名也走同一套校验', () => {
    expect(buildDatapackEnableCommand('file/a.zip', { at: 'before', existing: 'a b' }).error).toBe(
      'invalid-name',
    )
  })

  it.each([
    ['描述含引号', 'he said "hi"'],
    ['描述含反斜杠', 'path\\to'],
    ['描述含换行', 'a\nb'],
    ['描述为空白', '   '],
    ['描述为空', ''],
  ])('create 拒绝不安全的描述：%s', (_label, desc) => {
    expect(buildDatapackCreateCommand('uatcreated', desc).error).toBe('invalid-description')
  })

  it('create 的 id 拒绝非法字符（服务端另有校验，这里先挡）', () => {
    expect(buildDatapackCreateCommand('Bad Id!', 'desc').error).toBe('invalid-id')
  })
})

describe('datapack list 解析（夹具＝实机原文）', () => {
  it('list：两段拼接且**之间没有分隔符**', () => {
    const r = parseDatapackList(
      'There are 2 data pack(s) enabled: [vanilla (built-in)], [file/uatpack.zip (world)]There are no more data packs available',
    )
    expect(r.enabled).toEqual([
      { name: 'vanilla', source: 'built-in' },
      { name: 'file/uatpack.zip', source: 'world' },
    ])
    expect(r.available).toEqual([])
    expect(r.unparsed).toBe(null)
  })

  it('list enabled：只有启用段，available 为 null（＝本次未列出，不是空）', () => {
    const r = parseDatapackList('There are 1 data pack(s) enabled: [vanilla (built-in)]')
    expect(r.enabled).toEqual([{ name: 'vanilla', source: 'built-in' }])
    expect(r.available).toBe(null)
  })

  it('list available：非空形态', () => {
    const r = parseDatapackList('There are 1 data pack(s) available: [file/uatpack.zip (world)]')
    expect(r.enabled).toBe(null)
    expect(r.available).toEqual([{ name: 'file/uatpack.zip', source: 'world' }])
  })

  it('list available：确无更多', () => {
    const r = parseDatapackList('There are no more data packs available')
    expect(r.enabled).toBe(null)
    expect(r.available).toEqual([])
  })

  it('list：禁用后形态（启用段 + 可用段都在，中间仍无分隔符）', () => {
    const r = parseDatapackList(
      'There are 1 data pack(s) enabled: [vanilla (built-in)]There are 1 data pack(s) available: [file/uatpack.zip (world)]',
    )
    expect(r.enabled).toEqual([{ name: 'vanilla', source: 'built-in' }])
    expect(r.available).toEqual([{ name: 'file/uatpack.zip', source: 'world' }])
  })

  it('不认识的响应如实返回原文，不静默给空', () => {
    const r = parseDatapackList("Unknown data pack 'file/nope.zip'")
    expect(r).toEqual({
      enabled: null,
      available: null,
      unparsed: "Unknown data pack 'file/nope.zip'",
    })
  })

  it('名字里本身带括号时只剥末尾的来源限定', () => {
    const r = parseDatapackList('There are 1 data pack(s) enabled: [file/my (copy).zip (world)]')
    expect(r.enabled).toEqual([{ name: 'file/my (copy).zip', source: 'world' }])
  })

  it('没有来源限定时不臆造 source', () => {
    const r = parseDatapackList('There are 1 data pack(s) enabled: [file/plain.zip]')
    expect(r.enabled).toEqual([{ name: 'file/plain.zip', source: null }])
  })
})

describe('datapack enable/disable/create 返回分类（夹具＝实机原文逐字）', () => {
  it.each([
    [
      '启用成功',
      'Enabling data pack [file/uatpack.zip (world)]',
      { outcome: 'enabled', entry: { name: 'file/uatpack.zip', source: 'world' } },
    ],
    [
      '禁用 vanilla 也允许',
      'Disabling data pack [vanilla (built-in)]',
      { outcome: 'disabled', entry: { name: 'vanilla', source: 'built-in' } },
    ],
    [
      '重复启用：幂等提示，既非成功也非失败',
      "Pack 'file/uatpack.zip' is already enabled!",
      { outcome: 'already-enabled', name: 'file/uatpack.zip' },
    ],
    [
      '名字不存在（enable 与 disable 同措辞）',
      "Unknown data pack 'file/nope.zip'",
      { outcome: 'unknown-pack', name: 'file/nope.zip' },
    ],
    [
      '创建成功',
      "Created new empty pack with name 'uatcreated'",
      { outcome: 'created', name: 'uatcreated' },
    ],
    [
      '名字非法（服务端校验）',
      "Invalid characters in new pack name 'Bad Id!'",
      { outcome: 'invalid-name', name: 'Bad Id!' },
    ],
  ])('%s', (_label, response, expected) => {
    expect(parseDatapackAction(response)).toEqual(expected)
  })

  it('参数不合法：描述没加引号时的原文（带 <--[HERE] 标记）', () => {
    const r = parseDatapackAction('Incorrect argument for command...eated UAT 新建数据包<--[HERE]')
    expect(r.outcome).toBe('bad-arguments')
  })

  it('措辞不认识 → 保留原文，不猜成成功或失败', () => {
    // 「不认识就当作成功」是最危险的猜法：用户会以为已生效
    expect(parseDatapackAction('Something entirely new')).toEqual({
      outcome: 'unrecognized',
      raw: 'Something entirely new',
    })
    expect(parseDatapackAction('')).toEqual({ outcome: 'unrecognized', raw: '' })
  })

  it('措辞对但条目解析不出来 → 同样按未识别，不返回半成品', () => {
    // 前缀认识、里面却没有 `[...]` 形态
    expect(parseDatapackAction('Enabling data pack 没有方括号')).toEqual({
      outcome: 'unrecognized',
      raw: 'Enabling data pack 没有方括号',
    })
  })

  it.each([
    ['unknown-pack 分支', 'Unknown data pack 没有引号'],
    ['created 分支', 'Created new empty pack with name 没有引号'],
    ['invalid-name 分支', 'Invalid characters in new pack name 没有引号'],
    ['already-enabled 分支', 'Pack 没有引号 is already enabled!'],
  ])('引号形态缺失名字时按未识别（不返回空名字）：%s', (_label, response) => {
    // 各分支都要覆盖：只测其中一个时，另一个分支的 null 守卫不被承重
    // （探针实测——只测 unknown-pack 时，把 created 的守卫去掉照样全绿）
    expect(parseDatapackAction(response).outcome).toBe('unrecognized')
  })
})

describe('supportsDatapackCreate（create 的版本边界）', () => {
  /*
   * 边界不是自述，而是从**服务端产物**里读出来的，可复核：
   * 官方 server.jar 是 bundler jar，真正的服务端在内层
   * `META-INF/versions/<版本>/server-<版本>.jar`；`commands.datapack.create.*`
   * 这组翻译键只在子命令注册时存在。逐字节扫内层 jar 的 class：
   *
   *   1.21.5  server.jar 57269758 B / sha1 e6ec2f64e608… → 只有
   *           list/enable/disable/modify 的键，**没有 create 的任何键**
   *   1.21.6  server.jar 57554576 B / sha1 6e64dcabba3c… → create 六个键
   *           （already_exists / invalid_name / invalid_full_name / io_failure /
   *            metadata_encode_failure / success）开始出现
   *   26.3    server.jar 62294556 B / sha1 33680f5f2ac3… → 键集与 1.21.6 **逐字相同**
   *
   * 方法与 26.3 这条已知为真（该版本已实机验证过 create 存在）互为自证；
   * jar 的 size + sha1 都核过（本机链路有静默截断史，只看文件存在会得出错结论）。
   */
  it.each([
    ['1.21.5', false],
    ['1.21.6', true],
    ['1.21.10', true],
    ['26.3', true],
    ['1.22', true],
    ['2.0', true],
  ])('%s → %s', (version, expected) => {
    expect(supportsDatapackCreate(version)).toBe(expected)
  })

  it('1.21.10 不因字符串比较被误判为小于 1.21.6', () => {
    // 字符串比较下 '1.21.10' < '1.21.6' 为真，会把有 create 的版本判成没有
    expect(supportsDatapackCreate('1.21.10')).toBe(true)
  })

  it.each([[''], ['unknown'], ['26.3-snapshot-2']])(
    '版本不可解析（「%s」）按支持处置：不隐藏能力，最坏只是服务端回一句措辞',
    (version) => {
      expect(supportsDatapackCreate(version)).toBe(true)
    },
  )
})
