import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// 数值环境变量统一收口：parseInt(process.env.X || '默认') 模式兜不住「设置了
// 非法值」——env 非空即真，parseInt 的 NaN（及前缀截断 "8O"→8 / "3000ms"→3000）
// 静默进入运行时（如 BACKUP_IN_PROGRESS_TIMEOUT_MS=abc 会使卡死备份记录的重置
// 比较永假，DELETE 实例互斥防线永久 409）。统一严格整数校验：未设置或空串走
// 默认（保持 || 短路既有语义），合法整数（含正负号、首尾空白）放行，其余在
// 启动时 fail-fast 一次列出全部非法项——非法配置属部署错误，显式暴露优于静默
// 回退（回退默认会让用户设置失效且难以察觉），且与 port NaN listen 抛错的既有
// fail-fast 行为一致化
const invalidNumberEnv = [];

function intFromEnv(envNames, fallback) {
  const names = Array.isArray(envNames) ? envNames : [envNames];
  for (const name of names) {
    const raw = process.env[name];
    // 未设置/空串 → 下一个候选（与 a || b || 默认 的短路语义一致）
    if (raw === undefined || raw === '') continue;
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      invalidNumberEnv.push({ name, raw });
      return parseInt(fallback, 10); // 占位值：收集完成后统一 fail-fast
    }
    return parseInt(raw.trim(), 10);
  }
  return parseInt(fallback, 10);
}

const config = {
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
  trustProxy: intFromEnv('TRUST_PROXY', '1'),
  port: intFromEnv('PORT', '25566'),
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
    ttlMs: intFromEnv('ADMIN_SESSION_TTL_HOURS', '168') * 3600_000,
    // 会话绝对存活期（P2-11）：自创建起 30 天后强制重登，限制被窃取令牌的
    // 永久有效窗口；设 0 关闭（不建议）
    absoluteTtlMs: intFromEnv('ADMIN_SESSION_ABSOLUTE_TTL_DAYS', '30') * 86400_000,
    // 每用户会话上限（P2-11）：新登录挤掉最旧会话（last_seen_at 最旧）
    maxSessions: intFromEnv('ADMIN_SESSION_MAX_SESSIONS', '5'),
    loginLockMaxFails: intFromEnv('AUTH_LOGIN_MAX_FAILS', '10'),
    loginLockMs: intFromEnv('AUTH_LOGIN_LOCK_MS', '300000'),
  },
  rateLimit: {
    windowMs: intFromEnv('RATE_LIMIT_WINDOW', '60000'),
    // 240/min：前端常态轮询 6-8 个端点 × 5s ≈ 72-96 req/min，100 会在多标签页
    // 场景触发 429 误伤正常使用；仍保留对命令执行类之外的滥用拦截空间
    max: intFromEnv('RATE_LIMIT_MAX', '240')
  },
  // 备份保留策略（自动清理）：备份完成时清理超出上限的旧备份
  backupRetention: {
    maxBackups: intFromEnv('BACKUP_RETENTION_MAX', '10'),
    maxAgeDays: intFromEnv('BACKUP_RETENTION_DAYS', '30')
  },
  // 面板自身数据备份（SQLite 在线快照，每日定时）：面板库与管理员账号、
  // 审计日志等同库存储，实例备份不覆盖它。保留策略默认继承实例备份配置
  // （BACKUP_RETENTION_*），可用 PANEL_BACKUP_RETENTION_* 独立覆盖
  panelBackup: {
    enabled: (process.env.PANEL_BACKUP_ENABLED || 'true') !== 'false',
    cron: process.env.PANEL_BACKUP_CRON || '0 4 * * *',
    retention: {
      maxBackups: intFromEnv(['PANEL_BACKUP_RETENTION_MAX', 'BACKUP_RETENTION_MAX'], '10'),
      maxAgeDays: intFromEnv(['PANEL_BACKUP_RETENTION_DAYS', 'BACKUP_RETENTION_DAYS'], '30'),
    },
  },
  // 备份/恢复子进程超时上限（毫秒）：大世界压缩可能远超默认 5 分钟，
  // 实际超时按预估规模动态计算（每 MB 4s，下限 5min，上限本值）
  backupSpawnTimeoutMs: intFromEnv('BACKUP_SPAWN_TIMEOUT_MS', '3600000'),
  // append-only 表保留策略（每日定时清理）：审计日志、webhook 投递记录与
  // 命令历史只增不删，长期运行表无限增长拖慢查询。调度器周期调用
  // AuditLog.prune / WebhookModel.pruneDeliveries / CommandHistoryModel.prune，
  // 服务启动时先执行一次。
  // 默认天数沿用 model 签名值（审计 90 / 投递 30 / 命令历史 90）
  retentionPrune: {
    enabled: (process.env.RETENTION_PRUNE_ENABLED || 'true') !== 'false',
    cron: process.env.RETENTION_PRUNE_CRON || '30 4 * * *',
    auditLogDays: intFromEnv('AUDIT_LOG_RETENTION_DAYS', '90'),
    webhookDeliveryDays: intFromEnv('WEBHOOK_DELIVERY_RETENTION_DAYS', '30'),
    commandHistoryDays: intFromEnv('COMMAND_HISTORY_RETENTION_DAYS', '90'),
  },
  // 进行中备份/恢复记录的卡死判定阈值：服务启动与互斥检查时，
  // 状态变更超过此阈值的 creating（→failed）/restoring（→completed）记录自动重置
  backupInProgressTimeoutMs: intFromEnv('BACKUP_IN_PROGRESS_TIMEOUT_MS', '3600000'),
  // 崩溃循环熔断：滑动窗口（ms）内连续崩溃达阈值自动禁用 autoRestart
  crashLoop: {
    windowMs: intFromEnv('CRASH_LOOP_WINDOW_MS', '300000'),
    maxCrashes: intFromEnv('CRASH_LOOP_MAX_CRASHES', '5'),
  },
  // 磁盘使用率告警阈值（百分比）
  diskAlert: {
    warningPercent: intFromEnv('DISK_WARNING_PERCENT', '85'),
    errorPercent: intFromEnv('DISK_ERROR_PERCENT', '95'),
  },
  // 面板重启后自动恢复实例间隔（ms）
  autoStartDelayMs: intFromEnv('AUTO_START_DELAY_MS', '3000'),
  // npm 包名（更新检查用）
  npmPkgName: 'mc-commander-server',
};

// fail-fast：全部配置项求值后统一裁决，错误信息逐项给出变量名与实际读到的值，
// 一次修完所有笔误；未设置或留空不受影响（走默认值）
if (invalidNumberEnv.length > 0) {
  const lines = invalidNumberEnv.map((v) => `  - ${v.name}="${v.raw}"`).join('\n');
  throw new Error(
    `启动中止：${invalidNumberEnv.length} 个数值环境变量的值不是合法整数：\n${lines}\n` +
      '请修正环境变量或 .env 后重启；未设置或留空将使用默认值。'
  );
}

export default config;
