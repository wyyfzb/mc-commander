/**
 * 文件路径工具（列表 dir 参数口径：'/' 前缀风格）。
 *
 * `parentDirOf` 是单一实现：files-page（返回上级、重命名/移动拼新路径）与 files/queries
 * （操作后失效哪个目录的缓存）必须同规则——各写一份时缓存失效目录会与实际列表
 * 目录错位，表现为「操作成功但列表不刷新」，且两处不会同时报错、只在运行期显形。
 *
 * 同时认 `\` 分隔（不区分平台）：服务端列表出参已统一为 '/'（routes/files.js 的
 * toVirtualPath），但**连旧版本服务端**时收到的是 win32 的 `\plugins\Foo\config.yml`——
 * 只切 '/' 会让它一律回退到 '/'，于是重命名/移动把文件拼到实例根（静默搬家）。
 * 这里多认一个分隔符是一行成本，换掉的是「客户端与服务端版本必须同时升级」的隐式约束。
 */
export function parentDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx <= 0 ? '/' : path.slice(0, idx).replace(/\\/g, '/')
}

/**
 * 归一化手填的目标目录（返回 null = 形态非法）——「移动到…」的目标输入。
 *
 * 只拦**显然错**的形态：非 `/` 开头、含 `.`/`..` 段、含反斜杠、含 NUL 等控制字符。
 * 不校验存在性/越界/同名冲突——那些由服务端裁决（`resolveInstancePath` 四步防线 +
 * `renameNoClobber`），前端预判只会与服务端口径漂移；错误码由 `getFriendlyErrorText` 翻译。
 *
 * 去空白段（首/尾/重复斜杠）用 `split('/').filter(Boolean)` 一趟做完，而不是只剥尾部：
 * 只剥尾部时 `//` 会得到**空串**——既不是 null（放行）又不以 `/` 开头，
 * 调用点拼出 `/名称` 把文件搬到实例根，toast 还显示成「已移动到 」。
 * 全斜杠一律归一为根 `/`（用户意图无歧义），故返回值要么 null、要么 `/` 开头的规范形态。
 *
 * 与 parentDirOf 同住本模块：两者都是「文件路径口径」的纯函数。放 files-page 里会让
 * 单测为一个字符串判定去 import 整页（连带拉起 Monaco，node 环境直接崩）。
 */
export function normalizeDirInput(raw: string): null | string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return null
  // oxlint-disable-next-line no-control-regex -- 控制字符校验是安全面刻意为之（拒绝 \x00-\x1f）
  if (/[\x00-\x1f\\]/.test(trimmed)) return null
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..')) return null
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}
