/**
 * 弱 API Key 检测（S-P0-5）
 * 生产环境启动前校验明文 API_KEY 是否过弱，防止默认/空/低熵密钥
 * 直接用于生产环境。
 *
 * 弱 = 长度 < 16 或纯重复字符（如 'aaaaaaaa'）。
 * 哈希值无法逆推，因此仅在明文迁移路径中可检测。
 */

/**
 * 判断明文 API Key 是否为弱密钥
 * @param {string} key
 * @returns {boolean}
 */
export function isWeakApiKey(key) {
  if (typeof key !== 'string') return true;
  if (key.length < 16) return true;
  // 纯重复字符：所有字符相同（如 'aaaa...'、'111...'）
  if (/^(.)\1+$/.test(key)) return true;
  return false;
}
