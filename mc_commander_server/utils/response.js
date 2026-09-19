// 错误码定义
export const ErrorCodes = {
  // 通用错误
  SUCCESS: { code: 0, message: 'Success', status: 200 },
  SERVER_ERROR: { code: 50000, message: 'Internal Server Error', status: 500 },
  VALIDATION_ERROR: { code: 40000, message: 'Validation Error', status: 400 },
  NOT_FOUND: { code: 40400, message: 'Resource Not Found', status: 404 },
  RATE_LIMITED: { code: 42900, message: 'Too Many Requests', status: 429 },

  // 认证错误
  // 凭据「无效」（带了 Key/令牌但对不上）：与「压根没带凭据」分开，
  // 前者该去核对/轮换 Key，后者该去配置 Key 或重新登录（见 AUTH_CREDENTIALS_REQUIRED）
  INVALID_API_KEY: { code: 40101, message: 'Invalid or expired API Key', status: 401 },
  // 未提供任何凭据（无 X-API-Key、无 Bearer）：客户端据此提示「请配置凭据/登录」，
  // 而不是误导用户去轮换一把其实没问题的 Key
  AUTH_CREDENTIALS_REQUIRED: {
    code: 40107,
    message: '未提供访问凭据：请携带 X-API-Key 头或登录会话令牌',
    status: 401,
  },

  // 实例错误
  INSTANCE_NOT_FOUND: { code: 40401, message: 'Instance not found', status: 404 },
  INSTANCE_NOT_RUNNING: { code: 40002, message: 'Instance is not running', status: 400 },
  INSTANCE_RUNNING: { code: 40003, message: 'Instance is running', status: 409 },

  // 部署互斥：已有部署在途（部署实例尚未入库，重复发起会产出重复实例目录与 DB 记录）
  DEPLOY_IN_PROGRESS: { code: 40905, message: 'A deployment is already in progress', status: 409 },
  // 取消部署时无可取消对象（部署已终态、被取消过、或进程重启后注册表为空）：
  // 明确拒绝而非静默成功——静默成功会让客户端一直等一个不会到来的终态事件
  DEPLOY_NOT_IN_FLIGHT: {
    code: 40906,
    message: 'No deployment in progress for this instance',
    status: 409,
  },
  // 用户取消导致长任务未完成（部署 POST 的响应；终态事件会另行推送 cancelled 阶段）
  TASK_CANCELLED: { code: 40915, message: 'Task cancelled by user', status: 409 },
  // 卸载实例的实例名确认（服务端强制）：前端弹窗的输入只存在于客户端，
  // 不带确认的直连 API 调用此前可无确认删除，故确认必须由服务端裁决
  INSTANCE_DELETE_CONFIRM_REQUIRED: {
    code: 40016,
    message: '需在请求体提供 confirmName 且与实例名完全一致才能卸载实例',
    status: 400,
  },
  // 卸载空名实例：实例名确认为空串时「输入实例名」这道闸门不承载任何信息
  // （空串天然匹配），需调用方额外声明已接受不可恢复
  INSTANCE_DELETE_UNNAMED: {
    code: 40916,
    message: '该实例无名称，名称确认不构成有效确认；确认后请携带 acknowledgeIrreversible=true 重试',
    status: 409,
  },
  // 卸载实例且备份清单为空：没有任何灾备副本可回退，仅凭实例名确认不足，
  // 需调用方额外声明已接受不可恢复
  INSTANCE_DELETE_NO_BACKUP: {
    code: 40914,
    message:
      '该实例没有任何备份，删除后世界数据与配置不可恢复；确认后请携带 acknowledgeIrreversible=true 重试',
    status: 409,
  },

  // 备份错误
  BACKUP_NOT_FOUND: { code: 40402, message: 'Backup not found', status: 404 },
  BACKUP_IN_PROGRESS: { code: 40901, message: 'Backup already in progress', status: 409 },
  BACKUP_NOT_ACTIVE: { code: 40904, message: 'No active backup operation', status: 409 },
  BACKUP_FAILED: { code: 50002, message: 'Backup failed', status: 500 },
  // 运行中实例无法在线备份（RCON 不可用）：在线备份依赖 save-off/save-all/save-on
  // 原子序列保证一致性，RCON 缺失时静默直压运行中世界会产出不一致包（find 审计）
  BACKUP_RCON_UNAVAILABLE: {
    code: 40902,
    message:
      '无法执行在线备份：服务器未启用 RCON。请先停止服务器，或在 server.properties 启用 RCON',
    status: 409,
  },
  // 恢复互斥：另一恢复正在进行（同一实例 status='restoring'）
  RESTORE_IN_PROGRESS: { code: 40903, message: 'Restore already in progress', status: 409 },
  // 恢复缺少/不匹配实例名确认（服务端强制）：恢复会用快照覆盖实例目录，
  // 前端弹窗的实例名输入此前是唯一闸门，直连 API 可无确认覆盖
  BACKUP_RESTORE_CONFIRM_REQUIRED: {
    code: 40017,
    message: '需在请求体提供 confirmName 且与该备份所属实例名完全一致才能恢复',
    status: 400,
  },
  // 归档挂载依赖备份表索引（判断哪些快照已被登记）：索引不可读时无法安全挂载
  // （会插重复行），也谈不上「没有可挂载的快照」——503 明示服务端依赖故障
  BACKUP_INDEX_UNAVAILABLE: {
    code: 50303,
    message: '备份索引不可读，请稍后重试',
    status: 503,
  },

  // 定时任务错误
  TASK_NOT_FOUND: { code: 40405, message: 'Scheduled task not found', status: 404 },
  INVALID_CRON_EXPRESSION: { code: 40004, message: 'Invalid cron expression', status: 400 },

  // 文件错误
  FILE_NOT_FOUND: { code: 40406, message: 'File not found', status: 404 },
  PATH_TRAVERSAL_DETECTED: { code: 40302, message: 'Path traversal detected', status: 403 },
  FILE_TOO_LARGE: { code: 40005, message: 'File too large', status: 400 },
  BINARY_FILE_NOT_SUPPORTED: { code: 40006, message: 'Binary file not supported', status: 400 },
  FILE_UPLOAD_TOO_LARGE: { code: 40007, message: 'File upload too large', status: 400 },
  FILE_TYPE_NOT_ALLOWED: { code: 40008, message: 'File type not allowed', status: 400 },
  FILE_ALREADY_EXISTS: { code: 40909, message: 'File already exists', status: 409 },

  // Webhook 错误
  WEBHOOK_NOT_FOUND: { code: 40410, message: 'Webhook not found', status: 404 },
  WEBHOOK_INVALID_URL: {
    code: 40010,
    message: 'Invalid webhook URL (only http/https allowed)',
    status: 400,
  },
  WEBHOOK_INVALID_EVENTS: { code: 40011, message: 'Invalid webhook event types', status: 400 },
  WEBHOOK_TEST_FAILED: { code: 50010, message: 'Webhook test delivery failed', status: 500 },

  // 升级错误
  UPGRADE_IN_PROGRESS: { code: 40907, message: 'Upgrade already in progress', status: 409 },
  // 取消升级时无可取消对象（升级已终态、已被取消、或进程重启后注册表为空）
  UPGRADE_NOT_IN_PROGRESS: {
    code: 40908,
    message: 'No upgrade in progress for this instance',
    status: 409,
  },
  UPGRADE_VERSION_SAME: {
    code: 40012,
    message: 'Target version is the same as current version',
    status: 400,
  },

  // 插件错误（feat-8 P0-5）
  PLUGIN_NOT_FOUND: { code: 40411, message: 'Plugin not found', status: 404 },
  // 启停语义冲突：目标已是请求状态 / 重命名目标名已存在
  PLUGIN_STATE_CONFLICT: { code: 40910, message: 'Plugin state conflict', status: 409 },
  // 上传同名冲突：plugins/ 目录已存在同名文件且未显式 overwrite
  PLUGIN_FILE_EXISTS: { code: 40912, message: 'Plugin file already exists', status: 409 },

  // 插件市场（feat-8 延伸：Modrinth 代理）
  // Modrinth 上未找到项目（slug 无效或已下架）
  MARKET_PROJECT_NOT_FOUND: { code: 40412, message: 'Project not found on Modrinth', status: 404 },
  // Modrinth 上未找到指定版本号 / 版本无可下载文件
  MARKET_VERSION_NOT_FOUND: { code: 40413, message: 'Version not found on Modrinth', status: 404 },
  // Modrinth 上游错误（搜索/版本/下载任一环节，保留 502 语义）
  MARKET_UPSTREAM_ERROR: { code: 50301, message: 'Modrinth upstream error', status: 502 },
  // 市场下载文件 sha512 校验不匹配：与 Modrinth 官方哈希比对失败，拒绝安装（供应链完整性闸门）
  MARKET_CHECKSUM_MISMATCH: {
    code: 40014,
    message: 'Market file integrity check failed',
    status: 400,
  },

  // RCON 不可用（命令路由需要 RCON 响应但连接未启用或已断开）
  RCON_UNAVAILABLE: { code: 50302, message: 'RCON not available', status: 503 },

  // 管理员登录（安全主线）
  AUTH_INVALID_CREDENTIALS: { code: 40102, message: '密码错误', status: 401 },
  // Bearer 会话不存在 / 已过期 / 已被踢出——客户端应重新登录
  AUTH_SESSION_EXPIRED: { code: 40103, message: '会话已过期，请重新登录', status: 401 },
  // 登录失败次数过多，暂时锁定
  AUTH_LOGIN_LOCKED: { code: 42901, message: '登录失败次数过多，请稍后再试', status: 429 },
  // 首访设密时已存在密码
  AUTH_ALREADY_CONFIGURED: { code: 40911, message: '管理员密码已设置', status: 409 },
  // 未设密码时尝试登录
  AUTH_NOT_CONFIGURED: { code: 40013, message: '管理员密码尚未设置，请先完成初始化', status: 400 },
  // 首访设密 SETUP_TOKEN 校验失败（缺失/错误/已作废；公网部署所有权证明，#309）
  AUTH_SETUP_TOKEN_INVALID: {
    code: 40104,
    message: 'SETUP_TOKEN 缺失或错误：请携带部署完成时输出的一次性令牌',
    status: 403,
  },
  // 密码已通过、尚缺第二因子：客户端据此显示动态口令输入框，服务端此时不签发会话
  AUTH_TOTP_REQUIRED: { code: 40105, message: '需要两步验证码', status: 401 },
  // 第二因子错误（动态口令或恢复码）：与密码错误分开，客户端可区分提示；
  // 同样计入登录失败封禁（与密码失败共用计数）
  AUTH_TOTP_INVALID: { code: 40106, message: '两步验证码或恢复码错误', status: 401 },
  // 两步验证未挂靠（无候选 secret / 未确认）却调用 confirm/disable
  AUTH_TOTP_NOT_ENROLLED: { code: 40015, message: '两步验证尚未挂靠，请先完成挂靠', status: 400 },
  // 已挂靠状态下重复 enroll：必须先 disable 再重新挂靠（避免静默替换正在使用的 secret）
  AUTH_TOTP_ALREADY_ENABLED: {
    code: 40913,
    message: '两步验证已启用，请先关闭后再重新挂靠',
    status: 409,
  },
  // API Key 通道被配置关闭（API_KEY_ENABLED=false）：拒绝而非降级放行，
  // 提示改用会话登录（浏览器的唯一正常通道）
  API_KEY_DISABLED: {
    code: 40303,
    message: 'API Key 通道已关闭，请改用管理员会话登录',
    status: 403,
  },
  // 只读 Key 通道被配置关闭（READONLY_API_KEY_ENABLED=false）：与未配置
  // READONLY_API_KEY_HASH 的区别只在轮换端点——那里需要明确告知操作者
  // 「哈希保留、重开即恢复」，请求侧两条路径同归无效凭据
  READONLY_API_KEY_DISABLED: {
    code: 40304,
    message: '只读 API Key 通道已关闭，请改用管理员凭据',
    status: 403,
  },
  // 只读凭据访问白名单之外的端点：403（凭据有效但权限不足，故不是 401），
  // 响应体不回显白名单内容与凭据，避免给出权限边界的探测面
  AUTH_INSUFFICIENT_ROLE: {
    code: 40305,
    message: '只读凭据无权访问该端点，请改用管理员凭据',
    status: 403,
  },
};

// 自定义错误类
export class AppError extends Error {
  constructor(errorCode, message, details) {
    super(message || errorCode.message);
    this.name = 'AppError';
    this.code = errorCode.code;
    this.status = errorCode.status;
    this.details = details || null;
  }
}

// 成功响应
export function success(data, message = 'Success') {
  return {
    status: 'ok',
    code: 0,
    message,
    data: data || null,
    timestamp: new Date().toISOString(),
  };
}

// 分页成功响应
export function successPaginated(data, total, page, pageSize, message = 'Success') {
  return {
    status: 'ok',
    code: 0,
    message,
    data: data || [],
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
    timestamp: new Date().toISOString(),
  };
}

// 错误响应
export function error(errorCode, message, details) {
  return {
    status: 'error',
    code: errorCode.code,
    message: message || errorCode.message,
    details: details || null,
    timestamp: new Date().toISOString(),
  };
}

export default {
  ErrorCodes,
  AppError,
  success,
  successPaginated,
  error,
};
