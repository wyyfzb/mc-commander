/**
 * 连接配置纯逻辑
 * - normalizeBaseUrl：默认 https 协议 + 去尾斜杠（单输入框语义）
 * - panelAddress / sessionAppliesToPanel：面板身份与「会话是否属于本面板」判定
 * - isInternalHost：本机/内网地址判断（localhost/::1/127.x/10.x/192.168.x/172.16-31.x）
 * - needsHttpPlaintextWarning：公网 http 明文传输警告判定
 * - serialize/parseConnectionConfig：连接配置的文本互转（复制/粘贴导入）
 */

/** 规范化面板地址：默认 https 协议 + 去尾斜杠（协议前缀大小写不敏感） */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim()
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * 面板身份（把登录会话绑定到签发它的面板）。
 * 空地址＝同源部署，取当前站点根；带路径的地址保留路径——同一主机的两个子路径
 * 是两个面板，不能被归一。主机大小写由 URL 解析器归一（`origin` 恒小写），
 * 尾斜杠、协议大小写也一并归一；**路径大小写不折叠**（大小写敏感的服务端上
 * /MC 与 /mc 是两块面板，折叠会把 A 的令牌发给 B 并误判 40103）。
 */
export function panelAddress(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (raw === '') {
    return typeof window !== 'undefined' ? window.location.origin.toLowerCase() : ''
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return withScheme.replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * 会话是否适用于目标面板。会话没记签发面板时（旧 localStorage 会话）按适用处理——
 * 宽限到下一次请求成功（`backfillSessionPanel()` 会把签发面板补上），
 * 避免升级后把已在用的人挡在门外。注意空串是「未知」而非「同源」语义。
 */
export function sessionAppliesToPanel(
  session: { token?: string; issuedFor?: string } | null,
  baseUrl: string,
): boolean {
  if (!session?.token) return false
  return !session.issuedFor || session.issuedFor === panelAddress(baseUrl)
}

/**
 * 主机是否属于本机/内网地址。
 * http 明文传输警告仅针对公网地址触发；局域网自建服务器场景不打扰用户。
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m == null) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 127) return true // 127.0.0.0/8 本机回环
  if (a === 10) return true // 10.0.0.0/8
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  return false
}

/**
 * 完整 URL 是否触发明文传输警告：
 * 显式 http:// 协议且目标非内网/本机地址
 */
export function needsHttpPlaintextWarning(url: string): boolean {
  let uri: URL
  try {
    uri = new URL(url)
  } catch {
    return false
  }
  if (uri.protocol !== 'http:') return false
  const host = uri.hostname
  if (host === '') return false
  return !isInternalHost(host)
}

/**
 * 连接配置的复制/粘贴文本格式。
 *
 * 用 `key: value` 两行而不是 JSON：这段文本的用途是**人在聊天/笔记里传递**，
 * JSON 的引号与转义在人工编辑时极易弄坏（少个引号就整段不可用），
 * 而 key: value 一行一项，缺一项只缺一项、错一行只错一行。
 *
 * 不使用 `url#key` 单行形态（owner 已拍板）：明文 API Key 进 URL 会留在浏览器历史、
 * 剪贴板与聊天记录里，与本仓「只存摘要、明文只显示一次」的姿态相冲。
 */
const CONFIG_TEXT_URL_KEY = '面板地址'
const CONFIG_TEXT_API_KEY_KEY = 'API Key'

/** 序列化连接配置为可粘贴文本（API Key 为空则省略该行——登录会话用户没有 Key 也正常） */
export function serializeConnectionConfig(config: { baseUrl: string; apiKey: string }): string {
  const lines = [`${CONFIG_TEXT_URL_KEY}: ${config.baseUrl}`]
  if (config.apiKey) lines.push(`${CONFIG_TEXT_API_KEY_KEY}: ${config.apiKey}`)
  return lines.join('\n')
}

/**
 * 解析粘贴的连接配置文本（解析不出地址时返回 null）。
 *
 * 宽容到什么程度是刻意的：**只认「键名 + 冒号 + 值」这一种结构**，但
 * 键名接受中英文与常见变体、分隔符接受全角冒号、行的前后空白一律忽略——
 * 因为这些差异全部来自「人手抄/聊天软件替换标点」，与配置本身无关，
 * 为它们报错只会让用户反复重输。真正的形态错误（没有地址）才拒绝。
 *
 * 不校验地址是否可达、Key 是否有效：那是「测试连接」的职责（服务端裁决），
 * 前端预判只会与服务端口径漂移。
 */
export function parseConnectionConfig(text: string): null | { baseUrl: string; apiKey: string } {
  let baseUrl = ''
  let apiKey = ''
  for (const rawLine of text.split(/\r?\n/)) {
    // 全角冒号是中文输入法的默认产物，一律按半角处理
    const line = rawLine.replace(/：/g, ':').trim()
    if (line === '') continue
    const sep = line.indexOf(':')
    if (sep < 0) continue
    // 键名折叠空白与大小写后比对：`API Key` / `api key` / `apikey` 是同一件事，
    // 差异只来自手抄习惯，不是用户填错了配置
    const key = line.slice(0, sep).replace(/\s+/g, '').toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (value === '') continue
    // 键名的备选写法：序列化只产第一列，其余是「手抄/别处粘贴」的宽容面
    if (
      key === CONFIG_TEXT_URL_KEY.replace(/\s+/g, '').toLowerCase() ||
      key === 'url' ||
      key === '地址'
    ) {
      baseUrl = value
    } else if (key === CONFIG_TEXT_API_KEY_KEY.replace(/\s+/g, '').toLowerCase() || key === 'key') {
      apiKey = value
    }
  }
  if (baseUrl === '') return null
  return { baseUrl, apiKey }
}
