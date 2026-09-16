/**
 * 错误码映射（设计文档 §5.1 errors.ts）
 * 对照服务端 utils/response.js ErrorCodes 全表；
 * 策略：服务端 message 已本地化的（40902/40904 等）直接透传，
 *       英文默认文案的用本地友好文案覆盖
 */
import { ApiError } from './client'

/** 服务端错误码枚举（与 ErrorCodes 对齐） */
export const ErrorCode = {
  SUCCESS: 0,
  SERVER_ERROR: 50000,
  VALIDATION_ERROR: 40000,
  NOT_FOUND: 40400,
  RATE_LIMITED: 42900,

  INVALID_API_KEY: 40101,

  // 安全主线：管理员认证（routes/auth.js）
  AUTH_INVALID_CREDENTIALS: 40102,
  AUTH_SESSION_EXPIRED: 40103,
  AUTH_NOT_CONFIGURED: 40013,
  AUTH_ALREADY_CONFIGURED: 40911,
  AUTH_LOGIN_LOCKED: 42901,
  /** 首访设密 SETUP_TOKEN 校验失败（缺失/错误/已作废；公网部署所有权证明，issue 309） */
  AUTH_SETUP_TOKEN_INVALID: 40104,
  /** 密码已通过、尚缺第二因子：据此显示动态口令输入框（服务端此时未签发会话） */
  AUTH_TOTP_REQUIRED: 40105,
  /** 第二因子错误（动态口令或恢复码），与密码错误分开提示 */
  AUTH_TOTP_INVALID: 40106,
  /** 两步验证尚未挂靠（无候选密钥或未确认） */
  AUTH_TOTP_NOT_ENROLLED: 40015,
  /** 两步验证已启用：需先关闭才能重新挂靠 */
  AUTH_TOTP_ALREADY_ENABLED: 40913,
  /** API Key 通道被部署配置关闭（API_KEY_ENABLED=false）：须改用会话登录 */
  API_KEY_DISABLED: 40303,
  /** 只读机器凭据通道被部署配置关闭（READONLY_API_KEY_ENABLED=false） */
  READONLY_API_KEY_DISABLED: 40304,
  /** 只读机器凭据访问白名单之外的端点（凭据有效但权限不足） */
  AUTH_INSUFFICIENT_ROLE: 40305,

  INSTANCE_NOT_FOUND: 40401,
  INSTANCE_NOT_RUNNING: 40002,
  INSTANCE_RUNNING: 40003,
  /** 卸载实例缺少/不匹配实例名确认（服务端强制，见 DELETE /instances/:id） */
  INSTANCE_DELETE_CONFIRM_REQUIRED: 40016,
  /** 卸载的实例没有任何备份：须显式确认不可恢复后才放行 */
  INSTANCE_DELETE_NO_BACKUP: 40914,
  /** 部署互斥：已有部署在途 */
  DEPLOY_IN_PROGRESS: 40905,

  BACKUP_NOT_FOUND: 40402,
  BACKUP_IN_PROGRESS: 40901,
  BACKUP_RCON_UNAVAILABLE: 40902,
  RESTORE_IN_PROGRESS: 40903,
  BACKUP_FORMAT_UNSUPPORTED: 40904,
  BACKUP_FAILED: 50002,

  TASK_NOT_FOUND: 40405,
  INVALID_CRON_EXPRESSION: 40004,

  FILE_NOT_FOUND: 40406,
  PATH_TRAVERSAL_DETECTED: 40302,
  FILE_TOO_LARGE: 40005,
  BINARY_FILE_NOT_SUPPORTED: 40006,
  FILE_UPLOAD_TOO_LARGE: 40007,
  FILE_TYPE_NOT_ALLOWED: 40008,
  FILE_ALREADY_EXISTS: 40909,

  WEBHOOK_NOT_FOUND: 40410,
  WEBHOOK_INVALID_URL: 40010,
  WEBHOOK_INVALID_EVENTS: 40011,
  WEBHOOK_TEST_FAILED: 50010,

  // 升级
  UPGRADE_IN_PROGRESS: 40907,
  UPGRADE_VERSION_SAME: 40012,

  // 插件管理（feat-8，routes/plugins.js）
  PLUGIN_NOT_FOUND: 40411,
  PLUGIN_STATE_CONFLICT: 40910,
  PLUGIN_FILE_EXISTS: 40912,

  // 插件市场（feat-8 延伸：Modrinth 代理）
  MARKET_PROJECT_NOT_FOUND: 40412,
  MARKET_VERSION_NOT_FOUND: 40413,
  MARKET_UPSTREAM_ERROR: 50301,
  MARKET_CHECKSUM_MISMATCH: 40014,

  // RCON 不可用（命令路由需要 RCON 响应但连接未启用或已断开）
  RCON_UNAVAILABLE: 50302,
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

/** 需要本地化文案覆盖的错误码（服务端返回英文默认文案） */
const LOCALIZED_MESSAGES: Partial<Record<ErrorCodeValue, string>> = {
  [ErrorCode.SERVER_ERROR]: '服务器内部错误，请稍后重试',
  [ErrorCode.VALIDATION_ERROR]: '请求参数校验失败',
  [ErrorCode.NOT_FOUND]: '请求的资源不存在',
  [ErrorCode.RATE_LIMITED]: '请求过于频繁，请稍后再试',
  [ErrorCode.INVALID_API_KEY]: 'API Key 无效或已过期',
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: '密码错误',
  [ErrorCode.AUTH_SESSION_EXPIRED]: '登录会话已过期，请重新登录',
  [ErrorCode.AUTH_NOT_CONFIGURED]: '管理员密码尚未设置，请先完成初始化',
  [ErrorCode.AUTH_ALREADY_CONFIGURED]: '管理员密码已设置，请直接登录',
  [ErrorCode.AUTH_LOGIN_LOCKED]: '登录失败次数过多，请稍后再试',
  [ErrorCode.AUTH_SETUP_TOKEN_INVALID]: 'SETUP_TOKEN 缺失或错误：请粘贴部署完成时输出的一次性令牌',
  [ErrorCode.AUTH_TOTP_REQUIRED]: '请输入两步验证码或恢复码',
  [ErrorCode.AUTH_TOTP_INVALID]: '两步验证码或恢复码错误',
  [ErrorCode.AUTH_TOTP_NOT_ENROLLED]: '两步验证尚未挂靠，请先完成挂靠',
  [ErrorCode.AUTH_TOTP_ALREADY_ENABLED]: '两步验证已启用，请先关闭后再重新挂靠',
  [ErrorCode.API_KEY_DISABLED]: 'API Key 通道已关闭，请改用管理员会话登录',
  [ErrorCode.INSTANCE_NOT_FOUND]: '服务器实例不存在',
  [ErrorCode.INSTANCE_NOT_RUNNING]: '实例未在运行',
  [ErrorCode.INSTANCE_RUNNING]: '实例正在运行',
  [ErrorCode.DEPLOY_IN_PROGRESS]: '服务端已有部署在进行中，请等待其完成后再发起新部署',
  [ErrorCode.BACKUP_NOT_FOUND]: '备份不存在',
  [ErrorCode.BACKUP_IN_PROGRESS]: '已有备份任务进行中',
  [ErrorCode.RESTORE_IN_PROGRESS]: '已有恢复任务进行中',
  [ErrorCode.BACKUP_FAILED]: '备份失败',
  [ErrorCode.TASK_NOT_FOUND]: '定时任务不存在',
  [ErrorCode.INVALID_CRON_EXPRESSION]: 'cron 表达式无效',
  [ErrorCode.FILE_NOT_FOUND]: '文件不存在',
  [ErrorCode.PATH_TRAVERSAL_DETECTED]: '检测到非法路径访问',
  [ErrorCode.FILE_TOO_LARGE]: '文件过大',
  [ErrorCode.BINARY_FILE_NOT_SUPPORTED]: '不支持二进制文件',
  [ErrorCode.FILE_UPLOAD_TOO_LARGE]: '上传文件过大',
  [ErrorCode.FILE_TYPE_NOT_ALLOWED]: '该文件类型不允许上传',
  [ErrorCode.FILE_ALREADY_EXISTS]: '文件或目录已存在',
  [ErrorCode.WEBHOOK_NOT_FOUND]: 'Webhook 不存在',
  [ErrorCode.WEBHOOK_INVALID_URL]: 'Webhook URL 无效（仅允许 http/https）',
  [ErrorCode.WEBHOOK_INVALID_EVENTS]: '包含无效事件类型',
  [ErrorCode.WEBHOOK_TEST_FAILED]: 'Webhook 测试投递失败',
  [ErrorCode.PLUGIN_NOT_FOUND]: '插件文件不存在（可能已被删除或改名）',
  [ErrorCode.PLUGIN_STATE_CONFLICT]: '插件状态冲突（可能已在目标状态或同名文件存在）',
  [ErrorCode.PLUGIN_FILE_EXISTS]: '同名插件文件已存在，可选择覆盖上传',
  [ErrorCode.MARKET_PROJECT_NOT_FOUND]: '插件市场：Modrinth 上未找到该项目（可能已下架）',
  [ErrorCode.MARKET_VERSION_NOT_FOUND]: '插件市场：Modrinth 上未找到该版本',
  [ErrorCode.MARKET_UPSTREAM_ERROR]: '插件市场：Modrinth 服务暂时不可用，请稍后再试',
  [ErrorCode.MARKET_CHECKSUM_MISMATCH]: '插件市场：文件完整性校验失败，安装已拒绝（下载可能损坏，请重试）',
  [ErrorCode.RCON_UNAVAILABLE]: 'RCON 未启用或连接已断开，请在 server.properties 启用 RCON',
  [ErrorCode.UPGRADE_IN_PROGRESS]: '已有升级任务进行中',
  [ErrorCode.UPGRADE_VERSION_SAME]: '目标版本与当前版本相同',
}

/** 服务端已本地化的错误码（message 直接透传，不覆盖） */
const SERVER_LOCALIZED_CODES: ReadonlySet<ErrorCodeValue> = new Set([
  ErrorCode.BACKUP_RCON_UNAVAILABLE, // 40902 中文文案
  ErrorCode.BACKUP_FORMAT_UNSUPPORTED, // 40904 中文文案
])

/**
 * 校验失败 details 数组 → 字段级错误拼接文案（如 "mcVersion Required；name Too short"）。
 * 非数组/空数组/无有效项返回 null，调用方维持原通用文案。
 */
function formatValidationDetails(details: unknown): string | null {
  if (!Array.isArray(details) || details.length === 0) return null
  const items = details
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    .map((d) => {
      const path = typeof d.path === 'string' ? d.path : ''
      const message = typeof d.message === 'string' ? d.message : ''
      return path && message ? `${path} ${message}` : path || message
    })
    .filter(Boolean)
  return items.length > 0 ? items.join('；') : null
}

/**
 * 返回用户友好的错误文案。
 * 服务端已本地化的 message 透传；英文默认文案按错误码映射。
 * 校验失败（40000）且携带结构化 details 时，拼接字段级错误帮助定位。
 */
export function getFriendlyErrorMessage(code: number, serverMessage?: string, details?: unknown): string {
  const base = SERVER_LOCALIZED_CODES.has(code as ErrorCodeValue)
    ? serverMessage || LOCALIZED_MESSAGES[code as ErrorCodeValue] || '操作失败'
    : LOCALIZED_MESSAGES[code as ErrorCodeValue] || serverMessage || `操作失败（错误码 ${code}）`
  if (code === ErrorCode.VALIDATION_ERROR) {
    const detailText = formatValidationDetails(details)
    if (detailText) return `${base}：${detailText}`
  }
  return base
}

/**
 * catch 块 unknown 错误 → 友好文案（ApiError 走错误码映射，其余网络错误兜底）
 * 供各调用方 catch (e) 后统一使用
 */
export function getFriendlyErrorText(err: unknown): string {
  if (err instanceof ApiError) return getFriendlyErrorMessage(err.code, err.message, err.details)
  return '网络错误'
}
