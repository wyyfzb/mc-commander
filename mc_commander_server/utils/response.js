// 错误码定义
export const ErrorCodes = {
  // 通用错误
  SUCCESS: { code: 0, message: 'Success', status: 200 },
  SERVER_ERROR: { code: 50000, message: 'Internal Server Error', status: 500 },
  VALIDATION_ERROR: { code: 40000, message: 'Validation Error', status: 400 },
  NOT_FOUND: { code: 40400, message: 'Resource Not Found', status: 404 },
  RATE_LIMITED: { code: 42900, message: 'Too Many Requests', status: 429 },
  
  // 认证错误
  INVALID_API_KEY: { code: 40101, message: 'Invalid or expired API Key', status: 401 },
  
  // 实例错误
  INSTANCE_NOT_FOUND: { code: 40401, message: 'Instance not found', status: 404 },
  INSTANCE_NOT_RUNNING: { code: 40002, message: 'Instance is not running', status: 400 },
  INSTANCE_RUNNING: { code: 40003, message: 'Instance is running', status: 409 },

  // 部署互斥：已有部署在途（部署实例尚未入库，重复发起会产出重复实例目录与 DB 记录）
  DEPLOY_IN_PROGRESS: { code: 40905, message: 'A deployment is already in progress', status: 409 },
  
  // 备份错误
  BACKUP_NOT_FOUND: { code: 40402, message: 'Backup not found', status: 404 },
  BACKUP_IN_PROGRESS: { code: 40901, message: 'Backup already in progress', status: 409 },
  BACKUP_FAILED: { code: 50002, message: 'Backup failed', status: 500 },
  // 运行中实例无法在线备份（RCON 不可用）：在线备份依赖 save-off/save-all/save-on
  // 原子序列保证一致性，RCON 缺失时静默直压运行中世界会产出不一致包（find 审计）
  BACKUP_RCON_UNAVAILABLE: {
    code: 40902,
    message: '无法执行在线备份：服务器未启用 RCON。请先停止服务器，或在 server.properties 启用 RCON',
    status: 409,
  },
  // 恢复互斥：另一恢复正在进行（同一实例 status='restoring'）
  RESTORE_IN_PROGRESS: { code: 40903, message: 'Restore already in progress', status: 409 },
  // 旧格式备份（zip 压缩包）不支持恢复：快照方案改造后恢复为目录复制，
  // 旧 zip 备份仅保留可删（无解压链路，不保留 unzip 攻击面）
  BACKUP_FORMAT_UNSUPPORTED: {
    code: 40904,
    message: '旧格式备份（zip 压缩包）不支持恢复，仅可删除',
    status: 409,
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
  WEBHOOK_INVALID_URL: { code: 40010, message: 'Invalid webhook URL (only http/https allowed)', status: 400 },
  WEBHOOK_INVALID_EVENTS: { code: 40011, message: 'Invalid webhook event types', status: 400 },
  WEBHOOK_TEST_FAILED: { code: 50010, message: 'Webhook test delivery failed', status: 500 },

  // 升级错误
  UPGRADE_IN_PROGRESS: { code: 40907, message: 'Upgrade already in progress', status: 409 },
  UPGRADE_VERSION_SAME: { code: 40012, message: 'Target version is the same as current version', status: 400 },

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
  MARKET_CHECKSUM_MISMATCH: { code: 40014, message: 'Market file integrity check failed', status: 400 },

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
    timestamp: new Date().toISOString()
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
      totalPages: Math.ceil(total / pageSize)
    },
    timestamp: new Date().toISOString()
  };
}

// 错误响应
export function error(errorCode, message, details) {
  return {
    status: 'error',
    code: errorCode.code,
    message: message || errorCode.message,
    details: details || null,
    timestamp: new Date().toISOString()
  };
}

export default {
  ErrorCodes,
  AppError,
  success,
  successPaginated,
  error
};
