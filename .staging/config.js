import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

export default {
  apiKey: process.env.API_KEY || '',
  apiKeyHash: process.env.API_KEY_HASH || '',
  // 首访设密所有权证明（一次性 SETUP_TOKEN，audit S-P0-1 / issue #309）：
  // 部署脚本首次部署生成写入 .env；POST /auth/setup 强制校验，通过即作废
  //（内存清空 + .env 移除，重启后同样失效）。未配置 = 未开启（本机首发兼容）
  setupToken: process.env.SETUP_TOKEN || '',
  host: process.env.HOST || '127.0.0.1',
  // 信任反向代理层数（Express trust proxy）。默认 1 兼容 nginx/CDN 反代场景，
  // 设 0 不信任代理头（req.ip = 直连 IP）；影响 req.ip 解析（不影响锁定键，
  // 锁定键始终取 socket.remoteAddress）
  trustProxy: parseInt(process.env.TRUST_PROXY || '1'),
  port: parseInt(process.env.PORT || '25566'),
  serversDir: path.resolve(process.env.SERVERS_DIR || './servers'),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  backupsDir: path.resolve(process.env.BACKUPS_DIR || './backups'),
  // 前端静态产物随包分发（release 打包复制到服务端 public/），锚定服务端目录
  // 而非 cwd——服务器从任意工作目录启动都不影响托管（运行时数据目录仍保持 cwd 相对）
  publicDir: path.resolve(__dirname, process.env.PUBLIC_DIR || './public'),
  logLevel: process.env.LOG_LEVEL || 'info',
  // 认证前 JSON body 上限（P2-7）：全局 10mb 过宽（认证前攻击面），收紧至
  // 1mb；文件上传走 multer multipart 独立通道不受此值影响，大型插件/文件
  // 场景不受影响
  bodyLimitJson: process.env.BODY_LIMIT_JSON || '1mb',
  // 管理员密码登录（安全主线）：Bearer 会话滑动续期；登录失败锁定为
  // 按账号/来源 IP 的内存级限制（重启即清零，配合全局速率限流足够
  // 单管理员自托管场景；TOTP 挂靠点见 admin_account.totp_secret）
  adminSession: {
    // 会话有效期（滑动）：默认 7 天，每次认证触达续期；续期上限 cap 在
    // absoluteTtlMs 边界，不能无限推迟重登（P2-11）
    ttlMs: parseInt(process.env.ADMIN_SESSION_TTL_HOURS || '168') * 3600_000,
    // 会话绝对存活期（P2-11）：自创建起 30 天后强制重登，限制被窃取令牌的
    // 永久有效窗口；设 0 关闭（不建议）
    absoluteTtlMs: parseInt(process.env.ADMIN_SESSION_ABSOLUTE_TTL_DAYS || '30') * 86400_000,
    // 每用户会话上限（P2-11）：新登录挤掉最旧会话（last_seen_at 最旧）
    maxSessions: parseInt(process.env.ADMIN_SESSION_MAX_SESSIONS || '5'),
    loginLockMaxFails: parseInt(process.env.AUTH_LOGIN_MAX_FAILS || '10'),
    loginLockMs: parseInt(process.env.AUTH_LOGIN_LOCK_MS || '300000'),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    // 240/min：前端常态轮询 6-8 个端点 × 5s ≈ 72-96 req/min，100 会在多标签页
    // 场景触发 429 误伤正常使用；仍保留对命令执行类之外的滥用拦截空间
    max: parseInt(process.env.RATE_LIMIT_MAX || '240')
  },
  // 备份保留策略（自动清理）：备份完成时清理超出上限的旧备份
  backupRetention: {
    maxBackups: parseInt(process.env.BACKUP_RETENTION_MAX || '10'),
    maxAgeDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30')
  },
  // 面板自身数据备份（SQLite 在线快照，每日定时）：面板库与管理员账号、
  // 审计日志等同库存储，实例备份不覆盖它。保留策略默认继承实例备份配置
  // （BACKUP_RETENTION_*），可用 PANEL_BACKUP_RETENTION_* 独立覆盖
  panelBackup: {
    enabled: (process.env.PANEL_BACKUP_ENABLED || 'true') !== 'false',
    cron: process.env.PANEL_BACKUP_CRON || '0 4 * * *',
    retention: {
      maxBackups: parseInt(process.env.PANEL_BACKUP_RETENTION_MAX || process.env.BACKUP_RETENTION_MAX || '10'),
      maxAgeDays: parseInt(process.env.PANEL_BACKUP_RETENTION_DAYS || process.env.BACKUP_RETENTION_DAYS || '30'),
    },
  },
  // 备份/恢复子进程超时上限（毫秒）：大世界压缩可能远超默认 5 分钟，
  // 实际超时按预估规模动态计算（每 MB 4s，下限 5min，上限本值）
  backupSpawnTimeoutMs: parseInt(process.env.BACKUP_SPAWN_TIMEOUT_MS || '3600000'),
  // append-only 表保留策略（每日定时清理）：审计日志、webhook 投递记录与
  // 命令历史只增不删，长期运行表无限增长拖慢查询。调度器周期调用
  // AuditLog.prune / WebhookModel.pruneDeliveries / CommandHistoryModel.prune，
  // 服务启动时先执行一次。
  // 默认天数沿用 model 签名值（审计 90 / 投递 30 / 命令历史 90）
  retentionPrune: {
    enabled: (process.env.RETENTION_PRUNE_ENABLED || 'true') !== 'false',
    cron: process.env.RETENTION_PRUNE_CRON || '30 4 * * *',
    auditLogDays: parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90'),
    webhookDeliveryDays: parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || '30'),
    commandHistoryDays: parseInt(process.env.COMMAND_HISTORY_RETENTION_DAYS || '90'),
  },
  // 进行中备份/恢复记录的卡死判定阈值：服务启动与互斥检查时，
  // 状态变更超过此阈值的 creating（→failed）/restoring（→completed）记录自动重置
  backupInProgressTimeoutMs: parseInt(process.env.BACKUP_IN_PROGRESS_TIMEOUT_MS || '3600000'),
  // 崩溃循环熔断：滑动窗口（ms）内连续崩溃达阈值自动禁用 autoRestart
  crashLoop: {
    windowMs: parseInt(process.env.CRASH_LOOP_WINDOW_MS || '300000'),
    maxCrashes: parseInt(process.env.CRASH_LOOP_MAX_CRASHES || '5'),
  },
  // 磁盘使用率告警阈值（百分比）
  diskAlert: {
    warningPercent: parseInt(process.env.DISK_WARNING_PERCENT || '85'),
    errorPercent: parseInt(process.env.DISK_ERROR_PERCENT || '95'),
  },
  // 面板重启后自动恢复实例间隔（ms）
  autoStartDelayMs: parseInt(process.env.AUTO_START_DELAY_MS || '3000'),
  // npm 包名（更新检查用）
  npmPkgName: 'mc-commander-server',
};
