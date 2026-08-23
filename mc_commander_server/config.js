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
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100')
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
  backupInProgressTimeoutMs: parseInt(process.env.BACKUP_IN_PROGRESS_TIMEOUT_MS || '3600000')
};
