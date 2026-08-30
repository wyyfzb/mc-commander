import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

export default {
  apiKey: process.env.API_KEY || '',
  port: parseInt(process.env.PORT || '25566'),
  serversDir: path.resolve(process.env.SERVERS_DIR || './servers'),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  backupsDir: path.resolve(process.env.BACKUPS_DIR || './backups'),
  // 前端静态产物随包分发（release 打包复制到服务端 public/），锚定服务端目录
  // 而非 cwd——服务器从任意工作目录启动都不影响托管（运行时数据目录仍保持 cwd 相对）
  publicDir: path.resolve(__dirname, process.env.PUBLIC_DIR || './public'),
  logLevel: process.env.LOG_LEVEL || 'info',
  // 管理员密码登录（安全主线）：Bearer 会话滑动续期；登录失败锁定为
  // 按账号/来源 IP 的内存级限制（重启即清零，配合全局速率限流足够
  // 单管理员自托管场景；TOTP 挂靠点见 admin_account.totp_secret）
  adminSession: {
    // 会话有效期（滑动）：默认 7 天，每次认证触达续期
    ttlMs: parseInt(process.env.ADMIN_SESSION_TTL_HOURS || '168') * 3600_000,
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
  // 备份/恢复子进程超时上限（毫秒）：大世界压缩可能远超默认 5 分钟，
  // 实际超时按预估规模动态计算（每 MB 4s，下限 5min，上限本值）
  backupSpawnTimeoutMs: parseInt(process.env.BACKUP_SPAWN_TIMEOUT_MS || '3600000'),
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
