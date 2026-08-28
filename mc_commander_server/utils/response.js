// 错误码定义
export const ErrorCodes = {
  // 通用错误
  SUCCESS: { code: 0, message: 'Success', status: 200 },
  SERVER_ERROR: { code: 50000, message: 'Internal Server Error', status: 500 },
  VALIDATION_ERROR: { code: 40000, message: 'Validation Error', status: 400 },
  UNAUTHORIZED: { code: 40100, message: 'Unauthorized', status: 401 },
  FORBIDDEN: { code: 40300, message: 'Permission Denied', status: 403 },
  NOT_FOUND: { code: 40400, message: 'Resource Not Found', status: 404 },
  RATE_LIMITED: { code: 42900, message: 'Too Many Requests', status: 429 },
  
  // 认证错误
  INVALID_API_KEY: { code: 40101, message: 'Invalid or expired API Key', status: 401 },
  
  // 权限错误
  PERMISSION_DENIED: { code: 40301, message: 'Insufficient permissions', status: 403 },
  
  // 实例错误
  INSTANCE_NOT_FOUND: { code: 40401, message: 'Instance not found', status: 404 },
  INSTANCE_ALREADY_RUNNING: { code: 40001, message: 'Instance is already running', status: 400 },
  INSTANCE_NOT_RUNNING: { code: 40002, message: 'Instance is not running', status: 400 },
  INSTANCE_RUNNING: { code: 40003, message: 'Instance is running', status: 409 },
  INSTANCE_START_FAILED: { code: 50001, message: 'Failed to start instance', status: 500 },
  
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
  
  // 玩家错误
  PLAYER_NOT_FOUND: { code: 40403, message: 'Player not found', status: 404 },
  PLAYER_NOT_ONLINE: { code: 40003, message: 'Player is not online', status: 400 },
  
  
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
