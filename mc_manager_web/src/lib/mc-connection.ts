/**
 * 连接配置纯逻辑
 * - normalizeBaseUrl：默认 https 协议 + 去尾斜杠（单输入框语义）
 * - isInternalHost：本机/内网地址判断（localhost/::1/127.x/10.x/192.168.x/172.16-31.x）
 * - needsHttpPlaintextWarning：公网 http 明文传输警告判定
 */

/** 规范化面板地址：默认 https 协议 + 去尾斜杠 */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`
  }
  return url.endsWith('/') ? url.slice(0, -1) : url
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
