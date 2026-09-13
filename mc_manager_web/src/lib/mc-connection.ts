/**
 * 连接配置纯逻辑
 * - normalizeBaseUrl：默认 https 协议 + 去尾斜杠（单输入框语义）
 * - panelAddress / sessionAppliesToPanel：面板身份与「会话是否属于本面板」判定
 * - isInternalHost：本机/内网地址判断（localhost/::1/127.x/10.x/192.168.x/172.16-31.x）
 * - needsHttpPlaintextWarning：公网 http 明文传输警告判定
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
