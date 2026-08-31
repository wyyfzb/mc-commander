import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import config from '../config.js';
import { BackupModel } from '../db/backup.model.js';
import { ScheduledTaskModel } from '../db/scheduled_task.model.js';
import { AppError, ErrorCodes } from '../utils/response.js';

// 世界目录名白名单（find-004）：与路由层 server.properties level-name 校验
// 一致（^[A-Za-z0-9_-]+$），单段字符集禁止 / \ . 等路径分隔/穿越字符。
// MC 26.x 新旧版本的 level-name 均符合此字符集。
const WORLD_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

// 实例级备份排除清单：可重建/无备份价值的运行时产物（按目录名）。
// 世界（level-name 目录，含 26.1+ world/dimensions 新布局与旧版 Bukkit
// 顶层 world_nether/world_the_end）、plugins、mods、config、datapacks、
// server.properties、whitelist.json、ops.json、banned-*.json 全部纳入备份。
// libraries/versions 为加载器依赖（可重新下载）、logs/crash-reports 为日志
// （运行时持续增长）、cache 为缓存——全部排除。
const EXCLUDED_DIRS = new Set([
  'logs',
  'crash-reports',
  'libraries',
  'versions',
  'cache',
  'backups',
]);

// 路径包含校验（find-004）：将 target 解析后必须严格位于 baseDir 内。
// ①path.resolve 归一化 ②严格前缀校验（相等排除 + 目录分隔符边界，
// 避免 /base-evil 之类前缀陷阱）③已存在路径做 realpath 复检，
// 防止 worldDir 是 symlink（指向实例目录外）时压缩跟随链接泄露外部数据、
// 恢复时 rename/rmSync 伤及外部。模式与 utils/fs-utils.js 的 resolveSafePath
// 一致，本文件内自实现以避免跨文件顺序依赖（并行开发约束）。
export function resolveContained(baseDir, target) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError(ErrorCodes.PATH_TRAVERSAL_DETECTED, `Path traversal detected: ${target}`);
  }
  // 已存在路径：realpath 复检确认最终落点仍在 baseDir 内（防 symlink 逃逸）
  let baseReal = base;
  try {
    baseReal = fs.realpathSync(base);
  } catch {
    // baseDir 不存在时无法形成 symlink 链，前缀校验已足够
  }
  let real = null;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // 目标不存在：非 symlink，前缀校验已足够
    return resolved;
  }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
    throw new AppError(ErrorCodes.PATH_TRAVERSAL_DETECTED, `Symlink escape detected: ${target}`);
  }
  return resolved;
}

// ── 快照工具命令构造 ──────────────────────────────────────────────
// 快照方案：备份 = 完整目录快照 + 增量传输（Linux rsync --link-dest 硬链接
// / Windows robocopy 全量镜像，rsync 不可用时自动降级）。恢复 = 目录复制
// （禁止 mv——mv 会把共享 inode 移交实例目录，服务器运行后的 in-place
// 写入会污染所有仍硬链接同一 inode 的旧快照）。压缩与解压链路整体移除。

// 构造 Linux rsync 快照命令参数（实例级目录快照）：
// cwd=serversDir 下源为相对路径 <instanceId>/（尾带 / 复制目录内容，
// 目标快照目录直接成为实例目录的镜像），排除规则按目录名任意层级匹配
// （--exclude=logs/ 匹配任何层级的 logs 目录）。--link-dest 为增量基线
// （最近一次快照，绝对路径最稳妥——相对路径按【目标目录】解析，易踩坑）：
// 未变化文件以硬链接共享 inode（零拷贝），变化文件整文件复制新 inode。
// 快照模式不加 --delete（目标恒为新建空目录，--delete 无作用且源文件
// 临时消失时可能误删链中唯一引用）；--delete 仅用于恢复覆盖场景。
// 首次快照不传 --link-dest（指向不存在目录只会发误导性警告）。
export function buildRsyncArgs(instanceId, snapshotDir, { linkDest = null, jarFile = null } = {}) {
  const args = ['-a'];
  if (linkDest) {
    args.push(`--link-dest=${linkDest}`);
  }
  for (const dir of EXCLUDED_DIRS) {
    args.push(`--exclude=${dir}/`);
  }
  if (jarFile) args.push(`--exclude=${jarFile}`);
  // hs_err_pid*.log：JVM 崩溃日志（可重建运行时产物，命名固定为
  // hs_err_pid<pid>.log，与 *.pid/*.lock 同类排除）
  args.push('--exclude=*.pid', '--exclude=*.lock', '--exclude=hs_err_pid*.log');
  args.push(`${instanceId}/`, snapshotDir);
  return args;
}

// 构造 Windows robocopy 全量镜像命令参数（rsync 不可用时的降级路径）：
// 源/目标均为绝对路径（robocopy 无 cwd 概念）。/MIR 镜像（= /E + /PURGE，
// 删除目标中源已不存在的文件）；/MT:16 多线程；/R:2 /W:5 显式收紧重试
// （robocopy 默认 /R:1000000 /W:30，坏文件会卡数天）；/NFL /NDL /NP
// 抑制噪音输出。排除：/XD 目录名（任意层级）、/XF 文件名模式。
// 退出码为位标志累加：0-7 全部算成功（1=有文件复制、2=有多余文件被清、
// 4=存在不匹配），8+ 才算失败——Node 侧绝不能按 code===0 判定。
// robocopy 无 --link-dest 等价物（已核实：/H 是复制既有硬链接，不是创建），
// 每次为全量文件级复制；快照目录内不含硬链接，删除任意快照无断链风险。
export function buildRobocopyArgs(instanceId, snapshotDir, { jarFile = null } = {}) {
  const args = [
    path.join(config.serversDir, instanceId),
    snapshotDir,
    '/E',
    '/MIR',
    '/MT:16',
    '/R:2',
    '/W:5',
    '/NFL',
    '/NDL',
    '/NP',
    '/XD',
    ...EXCLUDED_DIRS,
    '/XF',
    ...(jarFile ? [jarFile] : []),
    '*.pid',
    '*.lock',
    'hs_err_pid*.log',
  ];
  return args;
}

// 备份文件名清洗：替换 Windows 非法文件名字符（含控制字符），
// 保留中文/Unicode。控制字符按码点过滤（正则字符类含控制字符会触发
// no-control-regex lint）。路径安全由调用方 resolveContained 兜底
export function sanitizeFileName(name) {
  const replaced = String(name).replace(/[<>:"/\\|?*]/g, '_');
  let result = '';
  for (const ch of replaced) {
    result += ch.codePointAt(0) < 0x20 ? '_' : ch;
  }
  return result;
}

// 递归统计目录总大小（字节，异步不阻塞事件循环），跳过排除清单——
// 用于磁盘空间预检、快照大小统计与恢复子进程超时估算。旧实现同步
// readdirSync+statSync 全量遍历，十万级文件的大世界在 HTTP 同步段阻塞
// 事件循环 1-3 秒（期间 RCON/WS/其余请求全部延迟）——改为异步遍历，
// 每次 await 让出事件循环。实例运行中（save-off 后）世界文件短暂静态，
// 预检为近似值即可，不追求统计期间完全一致。
export async function estimateDirSize(dir, { jarFile = null } = {}) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // 目录不存在/无权限：按 0 处理，由后续备份/恢复路径报错
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      total += await estimateDirSize(path.join(dir, entry.name), { jarFile });
    } else if (entry.isFile()) {
      if (jarFile && entry.name === jarFile) continue;
      // JVM 崩溃日志（hs_err_pid<pid>.log）与 pid/lock 同类：可重建运行时产物
      if (entry.name.endsWith('.pid') || entry.name.endsWith('.lock')) continue;
      if (entry.name.startsWith('hs_err_pid') && entry.name.endsWith('.log')) continue;
      try {
        const st = await fs.promises.stat(path.join(dir, entry.name));
        total += st.size;
      } catch {
        // 文件在统计间隙被删除（运行中实例）：跳过，不影响预检精度
      }
    }
  }
  return total;
}

// 磁盘剩余空间预检：备份目标盘可用空间不足预估大小 1.5 倍时拒绝。
// 磁盘满时 save 写入截断是世界损坏第一大诱因（业界共识），预检提前
// 失败比压缩中失败（zip 截断 + save-on 前中断）安全得多。
function checkDiskSpace(backupsDir, estimateBytes) {
  try {
    const statfs = fs.statfsSync(backupsDir);
    const freeBytes = statfs.bavail * statfs.bsize;
    const required = Math.round(estimateBytes * 1.5);
    if (freeBytes < required) {
      throw new AppError(
        ErrorCodes.BACKUP_FAILED,
        `磁盘剩余空间不足（需约 ${(required / 1024 / 1024).toFixed(0)} MB，实际剩余 ${(freeBytes / 1024 / 1024).toFixed(0)} MB），请清理后重试`
      );
    }
  } catch (err) {
    // statfs 不可用（罕见平台差异）：跳过预检，不阻断备份
    if (err instanceof AppError) throw err;
  }
}

export class BackupService {
  constructor(serverManager = null) {
    this.backupsDir = config.backupsDir;
    this.serverManager = serverManager;
    this.ensureBackupsDir();
  }

  ensureBackupsDir() {
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }
  }

  getInstanceBackupDir(instanceId) {
    const dir = path.join(this.backupsDir, instanceId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // 创建备份
  async createBackup(instanceId, options = {}) {
    const { name, description, type = 'manual', createdBy, taskId } = options;

    // 卡死恢复 + 互斥检查（服务层兜底，与 routes/backups.js 的
    // BACKUP_IN_PROGRESS(40901) 检查一致）：同一实例已有进行中操作
    // （status IN creating/restoring）时拒绝创建。下沉到服务层可同时覆盖
    // HTTP 路由、定时任务调度器两条入口，防止手动备份与定时备份并发执行
    // （save-off/save-all flush/save-on 序列交错 → 备份捕获不一致世界状态，
    // Windows 下还因文件占用压缩失败）。检查与 BackupModel.create 之间无
    // await（better-sqlite3 同步调用），Node 单线程下天然原子，同时消除
    // 路由层前置检查与创建间的 TOCTOU 窗口。
    BackupModel.resetStaleInProgress({ maxAgeMs: config.backupInProgressTimeoutMs, instanceId });
    const busyCount =
      BackupModel.findAll({ instanceId, status: 'creating' }).total +
      BackupModel.findAll({ instanceId, status: 'restoring' }).total;
    if (busyCount > 0) {
      throw new AppError(ErrorCodes.BACKUP_IN_PROGRESS);
    }

    const instance = this.serverManager?.getInstance(instanceId);

    // 运行中实例的在线备份依赖 RCON（save-off→save-all flush→save-on 原子
    // 序列）：RCON 不可用（原版默认 enable-rcon=false）时静默直压运行中
    // 世界会产出不一致包，Windows 下还因文件占用失败——显式拒绝并提示
    // 用户（停止服务器 或 启用 RCON），而非旧实现的静默降级。
    if (instance?.isRunning && !instance.isRconConnected) {
      throw new AppError(ErrorCodes.BACKUP_RCON_UNAVAILABLE);
    }

    // 世界目录名：优先显式传入，否则从实例 server.properties 读取 level-name，
    // 兼容自定义世界目录名的实例（手动与定时备份均不显式传 worldName）。
    // 仅用于存在性校验与记录（实例级备份压缩整个实例目录）
    let worldName = options.worldName;
    if (!worldName) {
      worldName = instance?.properties?.['level-name'] || 'world';
    }

    // find-004：worldName 白名单校验——level-name 未经校验时 ../ 可指向
    // 任意目录被压缩（任意文件泄露）。显式传入的 worldName 同样校验。
    if (typeof worldName !== 'string' || !WORLD_NAME_REGEX.test(worldName)) {
      const err = new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid world name: ${worldName}`);
      this._failSetup(instanceId, err);
      throw err;
    }

    const instanceDir = path.join(config.serversDir, instanceId);
    // find-004：resolveContained 兜底保证世界目录必须位于实例目录内
    // （严格前缀 + 分隔符边界，相等排除；已存在路径 realpath 复检防 symlink）
    const worldDir = resolveContained(instanceDir, path.join(instanceDir, worldName));

    // 检查世界目录是否存在。
    // 同步抛错路径（此时无 backupId，未创建记录）也要发 backupFailed 事件：
    // 旧实现此处仅被定时调度器 .catch 记日志，用户对唯一灾备手段失效完全无感知
    if (!fs.existsSync(worldDir)) {
      const err = new Error(`World directory not found: ${worldDir}`);
      this._failSetup(instanceId, err);
      throw err;
    }

    // 磁盘空间预检：预估实例目录大小（排除清单外）→ 校验备份盘剩余空间。
    // 大世界压缩耗时长，磁盘满时中途失败（zip 截断）远比提前拒绝难处理
    const estimateBytes = await estimateDirSize(instanceDir, { jarFile: instance?.jarFile || null });
    checkDiskSpace(this.backupsDir, estimateBytes);

    // 生成快照目录名（清洗 name 防止路径遍历）。
    // 只替换 Windows 非法文件名字符，保留中文/Unicode：旧实现用
    // [^\w.-] 清洗（\w 为 ASCII）会把中文名（如定时任务"每日备份"）
    // 全部替换为下划线，目录名失去可读性。路径安全由下方
    // resolvedBackupPath 前缀校验兜底。快照 = 完整目录树（无 .zip 扩展名），
    // 命名 <safeName>-<时间戳> 保证唯一（定时任务名可能重复触发）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = name
      ? sanitizeFileName(path.basename(name))
      : `backup_${timestamp}`;
    const snapshotName = `${safeName}-${timestamp}`;
    const backupDir = this.getInstanceBackupDir(instanceId);
    const snapshotDir = path.join(backupDir, snapshotName);

    // 二次校验：确保快照路径在备份目录内
    const resolvedBackupPath = path.resolve(snapshotDir);
    const resolvedBackupDir = path.resolve(backupDir);
    if (!resolvedBackupPath.startsWith(resolvedBackupDir + path.sep)) {
      throw new Error('Invalid backup name: path traversal detected');
    }

    // 创建备份记录
    const backupRecord = BackupModel.create({
      instanceId,
      name: name || `Backup ${timestamp}`,
      description: description || '',
      type,
      status: 'creating',
      filePath: snapshotDir,
      worldName,
      createdBy,
      format: 'snapshot'
    });

    // 异步执行备份（fire-and-forget：互斥由 status='creating' 记录承担，
    // 进程崩溃时该记录由 resetStaleInProgress 按超时重置）
    this.executeBackup(instanceId, backupRecord.id, snapshotDir, {
      estimateBytes,
      jarFile: instance?.jarFile || null,
      taskId,
    }).catch(err => {
      console.error('Backup failed:', err);
      try {
        BackupModel.update(backupRecord.id, { status: 'failed' });
      } catch (e) {
        console.error('Failed to update backup status:', e);
      }
    });

    return backupRecord;
  }

  // 同步抛错路径（setup 阶段，无 backupId）统一发 backupFailed 事件：
  // 旧实现此处仅被定时调度器 .catch 记日志，用户对唯一灾备手段失效完全无感知。
  // content 携带失败原因（磁盘满/世界缺失等对用户可见），三来源结构统一
  // { instanceId, backupId?, error, phase, content }
  _failSetup(instanceId, err) {
    if (this.serverManager) {
      this.serverManager.emit('instance:backupFailed', {
        instanceId,
        error: err.message,
        phase: 'setup',
        content: `备份失败: ${err.message}`,
      });
    }
  }

  // 执行备份（异步）：实例级备份——目录快照整个实例（排除运行时产物，
  // Linux rsync --link-dest 硬链接增量 / Windows robocopy 全量镜像降级）
  async executeBackup(instanceId, backupId, snapshotDir, { estimateBytes = 0, jarFile = null, taskId = null } = {}) {
    try {
      // 触发备份开始事件
      if (this.serverManager) {
        this.serverManager.emit('instance:backupStart', {
          instanceId,
          backupId,
          content: '备份已开始',
        });
      }

      // 安全备份流程：通过 RCON 暂停自动保存，确保数据一致性。
      // 运行中+RCON 不可用已在 createBackup 拒绝；此处保留守卫（防御
      // 实例在创建与执行之间启停的竞态，RCON 掉线时 save 序列失败不致命，
      // 压缩继续进行——save-off 未生效过则无需 save-on）
      if (this.serverManager) {
        const instance = this.serverManager.getInstance(instanceId);
        if (instance && instance.isRconConnected) {
          try {
            console.log(`[Backup] Sending save-off for ${instanceId}...`);
            await instance.sendCommandWithResponse('save-off', { timeout: 3000 });
            console.log(`[Backup] Sending save-all flush for ${instanceId}...`);
            await instance.sendCommandWithResponse('save-all flush', { timeout: 5000 });
            // 等待磁盘写入完成
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (rconErr) {
            console.warn(`[Backup] RCON save commands failed (non-fatal): ${rconErr.message}`);
          }
        }
      }

      // 快照子进程超时按预估规模动态计算（每 MB 约 4s，下限 5min，
      // 上限配置值）：固定 300s 会误杀 GB 级世界的定时备份。
      // 快照（rsync 增量/robocopy 复制）远快于 zip 压缩，此估算偏保守
      // 但不会误杀（timeout 是上限而非目标）
      const timeout = Math.min(
        config.backupSpawnTimeoutMs,
        Math.max(300000, Math.round((estimateBytes / 1024 / 1024) * 4000))
      );

      // 创建快照：Windows 优先 rsync（MSYS2，硬链接增量，与 Linux 参数
      // 完全同构），未安装时自动降级为系统自带 robocopy 全量镜像；
      // Linux 固定 rsync。返回实际使用的工具（robocopy 降级时记录日志）
      await this._createSnapshot(instanceId, snapshotDir, { jarFile, timeout });

      // 快照完整性校验：快照 = 实例目录镜像，必须有世界数据（level.dat 位于
      // level-name 目录直接层）且非空。rsync 退出 0/24 已保证文件完整，
      // 此处拦截"空快照/无世界"的无效备份（与旧 zip 的 CRC 校验等价：
      // 半成品快照目录在失败路径统一清理）
      await this._verifySnapshot(snapshotDir);

      // 获取快照大小：递归统计目录总字节（= 单快照逻辑大小，恢复该快照
      // 所需的容量；硬链接共享 inode 在单目录统计时天然全部计入，与
      // du -sb <快照>/ 语义一致）。跨平台免 du 命令依赖
      const size = await estimateDirSize(snapshotDir, { jarFile: null });

      // 更新备份记录
      BackupModel.update(backupId, {
        status: 'completed',
        size
      });

      // 定时备份任务的结果回写：真实成功（快照完成+校验通过）而非 createBackup
      // 触发即成功（createBackup fire-and-forget，resolve 早于快照完成）
      if (taskId != null) {
        ScheduledTaskModel.updateLastRunStatus(taskId, 'success');
      }

      console.log(`Backup completed: ${snapshotDir}`);

      // 自动清理旧备份（备份成功路径接线：清理超出保留策略的旧备份）
      try {
        const deleted = await this.cleanupOldBackups(instanceId, config.backupRetention);
        if (deleted > 0) {
          console.log(`[Backup] Cleaned up ${deleted} old backup(s) for instance ${instanceId}`);
        }
      } catch (cleanupErr) {
        console.error(`[Backup] Cleanup failed for instance ${instanceId}:`, cleanupErr.message);
      }

      // 触发 WebSocket 事件（content 携带名称与大小，前端不再回退默认文案）
      if (this.serverManager) {
        const sizeMb = (size / 1024 / 1024).toFixed(1);
        const backupName = path.basename(snapshotDir);
        this.serverManager.emit('instance:backupComplete', {
          instanceId,
          backupId,
          name: backupName,
          size,
          content: `备份完成: ${backupName}（${sizeMb} MB）`,
        });
      }

    } catch (err) {
      console.error('Backup execution failed:', err);

      // 触发备份失败事件（content 携带失败原因，磁盘满/压缩超时等对用户可见）
      if (this.serverManager) {
        this.serverManager.emit('instance:backupFailed', {
          instanceId,
          backupId,
          error: err.message,
          phase: 'execution',
          content: `备份失败: ${err.message}`,
        });
      }

      // 更新备份状态为失败
      try {
        BackupModel.update(backupId, { status: 'failed' });
      } catch (e) {
        console.error('Failed to update backup status:', e);
      }

      // 定时备份任务的结果回写：执行阶段真实失败（快照/校验/压缩）
      if (taskId != null) {
        ScheduledTaskModel.updateLastRunStatus(taskId, 'failed', err?.message ?? String(err));
      }

      // 清理失败的半成品快照目录（rsync/robocopy 失败可能残留部分文件）
      if (fs.existsSync(snapshotDir)) {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }

      throw err;
    } finally {
      // 恢复自动保存：save-off 与 save-on 必须成对。
      // 无论压缩/统计成功与否都补发 save-on，否则 zip 失败等异常路径会
      // 让 MC 服务器永久停留在自动保存关闭状态，崩溃/断电时世界数据回退。
      await this._restoreSaveOn(instanceId);
    }
  }

  // 创建快照：Windows 优先 rsync（MSYS2），ENOENT 自动降级 robocopy；
  // Linux 固定 rsync。返回实际使用的工具名（'rsync' / 'robocopy'）
  async _createSnapshot(instanceId, snapshotDir, { jarFile = null, timeout = 300000 } = {}) {
    if (process.platform === 'win32') {
      try {
        await this._rsyncSnapshot(instanceId, snapshotDir, { jarFile, timeout });
        return 'rsync';
      } catch (err) {
        // rsync 缺失（未安装 MSYS2/不在 PATH）：降级 robocopy 全量镜像。
        // 其余错误（命令执行失败）原样上抛——降级只针对工具缺失
        if (err.code !== 'ENOENT') throw err;
        console.warn(`[Backup] rsync 不可用，降级为 robocopy 全量快照: ${err.message}`);
        await this._robocopySnapshot(instanceId, snapshotDir, { jarFile, timeout });
        return 'robocopy';
      }
    }
    await this._rsyncSnapshot(instanceId, snapshotDir, { jarFile, timeout });
    return 'rsync';
  }

  // rsync 快照（Linux 主路径 / Windows MSYS2 主路径）：
  // --link-dest 指向该实例最近一次快照。基线选择按目录 mtime 取最新
  // （目录名前缀是用户可变的备份名，中英文混排时整串字典序≠时间序，
  // 曾导致 linkDest 指向数周前旧快照、增量失效退化为大范围全量复制）；
  // 快照创建后不被改写，mtime 即创建时间，排序可靠。未变化文件硬链接
  // 共享 inode 零拷贝。首次无历史快照不传 --link-dest（全量复制；
  // 指向不存在目录只会发误导性警告）。
  // 退出码：0=成功；24=源文件在传输中消失（容忍，记警告）；其余失败
  async _rsyncSnapshot(instanceId, snapshotDir, { jarFile = null, timeout = 300000 } = {}) {
    const instanceBackupDir = this.getInstanceBackupDir(instanceId);
    let linkDest = null;
    try {
      const snapshots = fs.readdirSync(instanceBackupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => {
          try {
            return (
              fs.statSync(path.join(instanceBackupDir, a)).mtimeMs -
              fs.statSync(path.join(instanceBackupDir, b)).mtimeMs
            );
          } catch {
            return 0;
          }
        });
      if (snapshots.length > 0) {
        linkDest = path.join(instanceBackupDir, snapshots[snapshots.length - 1]);
      }
    } catch {
      // 备份目录不可读：按无历史快照处理（全量复制），不阻断备份
    }
    const args = buildRsyncArgs(instanceId, snapshotDir, { linkDest, jarFile });
    const code = await spawnProcess('rsync', args, {
      cwd: config.serversDir,
      timeout,
      okCodes: [0, 24],
    });
    if (code === 24) {
      console.warn('[Backup] rsync: 部分源文件在传输中消失（exit 24），快照已容忍处理');
    }
  }

  // robocopy 全量镜像快照（Windows 降级路径，rsync 缺失时）：
  // 文件级全量复制（robocopy 无硬链接增量能力），排除清单同 rsync。
  // 退出码位标志 0-7 全部为成功（1=有复制、2=清理多余、4=不匹配），
  // 8+ 才为失败——由 _spawn okCodes 承接
  async _robocopySnapshot(instanceId, snapshotDir, { jarFile = null, timeout = 300000 } = {}) {
    const args = buildRobocopyArgs(instanceId, snapshotDir, { jarFile });
    await spawnProcess('robocopy', args, {
      timeout,
      okCodes: [0, 1, 2, 3, 4, 5, 6, 7],
    });
  }

  // 快照完整性校验：快照 = 实例目录镜像（level-name 目录直接层有 level.dat
  // 且目录非空）。空快照/无世界快照的恢复会毁掉原世界（与旧 zip CRC 校验
  // 等价的作用），创建时即拦截，失败路径由调用方清理半成品。
  //
  // 设计约定：快照目录由服务进程独占生成、无外部输入入口，恢复不做 symlink
  // 条目拒绝（若未来开放"导入备份"或接入共享存储，须在此补充恢复前 symlink 扫描）。
  async _verifySnapshot(snapshotDir) {
    if (!fs.existsSync(snapshotDir)) {
      throw new Error('Snapshot directory not found');
    }
    const entries = fs.readdirSync(snapshotDir);
    if (entries.length === 0) {
      throw new Error('Snapshot is empty');
    }
    if (!this._hasLevelData(snapshotDir)) {
      throw new Error('Snapshot has no level.dat (backup may be corrupted)');
    }
  }

  // 恢复自动保存（save-off 的对称操作）。
  // save-on 失败时通过 backupFailed 事件暴露（phase='save-on'）——旧实现
  // 仅 console.warn 静默跳过，若 save-off 已生效后 RCON 断连，MC 服务器
  // 会永久停留在自动保存关闭状态，崩溃/断电时世界数据回退且无人知晓。
  async _restoreSaveOn(instanceId) {
    if (!this.serverManager) return;
    const instance = this.serverManager.getInstance(instanceId);
    if (!instance || !instance.isRconConnected) return;
    try {
      console.log(`[Backup] Sending save-on for ${instanceId}...`);
      await instance.sendCommandWithResponse('save-on', { timeout: 3000 });
    } catch (rconErr) {
      console.warn(`[Backup] RCON save-on failed (non-fatal): ${rconErr.message}`);
      this.serverManager.emit('instance:backupFailed', {
        instanceId,
        error: rconErr.message,
        phase: 'save-on',
        content: '备份已完成，但恢复自动保存失败（服务器可能停留在自动保存关闭状态，请手动执行 save-on）',
      });
    }
  }

  // 恢复备份（异步：同步段完成校验与互斥锁置位后立即返回，恢复实际执行放
  // 后台）。三入口（创建/恢复/删除）统一 status='restoring' 状态机互斥，
  // 路由快速 202 返回，进度经 restoreStart/restoreComplete/restoreFailed 事件推送。
  async restoreBackup(backupId) {
    // find-021：file_path 仅服务层内部使用，走专用查询获取完整行
    const backup = BackupModel.findByIdWithPath(backupId);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }

    if (backup.status !== 'completed') {
      throw new Error('Only completed backups can be restored');
    }

    // 旧格式（zip 压缩包）备份禁止恢复：恢复链路为目录复制
    // （rsync -a/robocopy /MIR），zip 无解压路径，仅保留可删
    if (backup.format === 'zip') {
      throw new AppError(ErrorCodes.BACKUP_FORMAT_UNSUPPORTED);
    }

    const instanceId = backup.instance_id;

    // 互斥（restoring 状态机）：同实例任何进行中操作
    // （creating=备份中 / restoring=恢复中）都拒绝新的恢复。
    // 卡死恢复先行：进程崩溃残留的 restoring 记录超时重置回 completed
    BackupModel.resetStaleInProgress({ maxAgeMs: config.backupInProgressTimeoutMs, instanceId });
    const busyCount =
      BackupModel.findAll({ instanceId, status: 'creating' }).total +
      BackupModel.findAll({ instanceId, status: 'restoring' }).total;
    if (busyCount > 0) {
      throw new AppError(ErrorCodes.RESTORE_IN_PROGRESS);
    }

    // 实例必须处于停止状态：恢复会整体替换实例目录，运行中重命名/删除
    // 被 MC 占用的文件（Windows 下 EPERM）或覆盖正在写入的世界
    const instance = this.serverManager?.getInstance(instanceId);
    if (instance?.isRunning) {
      throw new AppError(ErrorCodes.INSTANCE_RUNNING, '实例正在运行，请先停止服务器再恢复备份');
    }

    const instanceDir = resolveContained(config.serversDir, path.join(config.serversDir, instanceId));
    if (!fs.existsSync(instanceDir)) {
      throw new Error(`Instance directory not found: ${instanceDir}`);
    }

    const snapshotDir = backup.file_path;
    // find-004 兜底：快照目录路径必须位于备份目录内（防 DB 被篡改后
    // 删除/复制任意路径目录）
    if (snapshotDir) {
      resolveContained(this.backupsDir, snapshotDir);
    }

    if (!fs.existsSync(snapshotDir)) {
      throw new Error('Snapshot directory not found');
    }
    // 快照必须是目录（file_path 指向文件的记录为异常数据/旧格式错标）
    if (!fs.statSync(snapshotDir).isDirectory()) {
      throw new Error('Snapshot path is not a directory');
    }

    // 置 restoring 状态（互斥锁）：此后的创建/恢复/删除入口全部命中
    // 互斥检查。备份文件本身完好，恢复失败/完成后再置回 completed
    BackupModel.update(backupId, { status: 'restoring' });

    // 后台执行恢复（fire-and-forget）
    this.executeRestore(backupId, backup, instanceDir, snapshotDir, {
      jarFile: instance?.jarFile || null,
    }).catch(err => {
      console.error('Restore failed:', err);
      // 恢复失败：备份文件未动，重置为 completed 供重试（释放互斥锁）
      try {
        BackupModel.update(backupId, { status: 'completed' });
      } catch (e) {
        console.error('Failed to reset backup status after failed restore:', e);
      }
    });

    return true;
  }

  // 执行恢复（后台）：整体替换实例目录——快照完整性预检（在触碰原实例
  // 目录之前，失败无需回滚）→ 整个实例目录 rename 为 pre_restore →
  // 复制快照到实例目录（rsync -a --delete / robocopy /MIR，禁止 mv——
  // mv 会移交共享 inode 污染快照链）→ 复制回 jar 文件 → level.dat 校验 →
  // 成功删 pre_restore / 失败回滚。实例级快照（含配置/插件/白名单）
  // 随之整体还原。
  async executeRestore(backupId, backup, instanceDir, snapshotDir, { jarFile = null } = {}) {
    const instanceId = backup.instance_id;
    const backupName = backup.name || `备份 #${backupId}`;
    // 本次恢复的 pre_restore 目录（try 内赋值、catch 精确回滚——旧实现
    // 在 catch 里按前缀 find 扫描 serversDir，多个残留 pre_restore 目录
    // 时可能把上次崩溃遗留的旧版本 rename 回实例目录，本次真实原数据
    // 被遗弃为孤儿目录）
    let preRestoreDir = null;
    try {
      // 触发恢复开始事件
      if (this.serverManager) {
        this.serverManager.emit('instance:restoreStart', {
          instanceId,
          backupId,
          content: `开始恢复备份 "${backupName}"`,
        });
      }

      // ① 快照完整性预检（rename 之前执行：快照损坏时直接失败，
      // 原实例目录未被触碰，无需回滚——比 zip 时代"解压后才发现坏包"
      // 更安全）。restoreBackup 同步段已校验存在性/目录类型，此处校验
      // 内容（level.dat + 非空），双保险防快照被外部改动
      await this._verifySnapshot(snapshotDir);

      // ①.5 后台执行期间再次确认实例未运行：restoreBackup 同步段的
      // isRunning 检查只覆盖 202 返回前，用户可能在此后启动服务器——
      // Linux 上 rename/删除被 MC 打开文件的目录会静默成功，MC 继续向
      // 已删除 inode 写入，停服时世界数据丢失；Windows 则 rename EPERM
      // 失败。运行中直接放弃本次恢复（preRestoreDir 未创建，回滚无操作）
      const running = this.serverManager?.getInstance(instanceId);
      if (running?.isRunning) {
        throw new Error('实例正在运行，请先停止服务器再恢复备份');
      }

      // ② 整个实例目录 rename 为 pre_restore（恢复成功前原数据完好保留）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      preRestoreDir = path.join(config.serversDir, `${instanceId}_pre_restore_${timestamp}`);
      fs.renameSync(instanceDir, preRestoreDir);

      // ③ 复制快照 → 实例目录（复制而非移动；--delete 仅恢复场景使用，
      // 清理实例目录中快照已不存在的文件）。子进程超时按快照规模动态
      // 计算（快照逻辑大小，估算方法与备份一致）
      const timeout = Math.min(
        config.backupSpawnTimeoutMs,
        Math.max(300000, Math.round(((await estimateDirSize(snapshotDir)) / 1024 / 1024) * 4000))
      );
      await this._restoreFromSnapshot(snapshotDir, instanceDir, { timeout });

      // ④ 复制回启动 jar：快照排除 jar（可重建），恢复后需从
      // pre_restore 取回（jarFile 配置优先，缺省扫描根目录 *.jar）
      this._copyBackJarFiles(preRestoreDir, instanceDir, jarFile);

      // ⑤ 恢复结果校验：复制后实例目录必须包含世界数据（level.dat 位于
      // level-name 目录直接层）。空快照/复制失败 exit 0 但无数据——此检查
      // 拦截后走回滚，原世界不丢
      if (!this._hasLevelData(instanceDir)) {
        throw new Error('Restored instance has no level.dat (backup may be corrupted)');
      }

      // ⑥ 成功：删除 pre_restore，状态置回 completed（快照可继续用于
      // 未来恢复），发送恢复完成事件（提示启动服务器使新世界生效）
      if (fs.existsSync(preRestoreDir)) {
        fs.rmSync(preRestoreDir, { recursive: true, force: true });
      }
      BackupModel.update(backupId, { status: 'completed' });

      console.log(`Backup restored: ${snapshotDir}`);
      if (this.serverManager) {
        this.serverManager.emit('instance:restoreComplete', {
          instanceId,
          backupId,
          content: `备份 "${backupName}" 已恢复，请启动服务器生效`,
        });
      }
      return true;

    } catch (err) {
      console.error('Restore failed:', err);

      // 失败回滚：删除半解压的新实例目录，rename 本次 pre_restore 回来。
      // 精确匹配本次目录名（preRestoreDir 局部变量）而非前缀扫描——
      // 失败点可能在校验/复制之前（preRestoreDir 未创建时无需回滚）
      if (preRestoreDir && fs.existsSync(preRestoreDir)) {
        if (fs.existsSync(instanceDir)) {
          fs.rmSync(instanceDir, { recursive: true, force: true });
        }
        fs.renameSync(preRestoreDir, instanceDir);
      }
      // 状态置回 completed（备份文件完好，可重试恢复），发送失败事件
      try {
        BackupModel.update(backupId, { status: 'completed' });
      } catch (e) {
        console.error('Failed to reset backup status after failed restore:', e);
      }
      if (this.serverManager) {
        this.serverManager.emit('instance:restoreFailed', {
          instanceId,
          backupId,
          error: err.message,
          content: `恢复失败: ${err.message}`,
        });
      }
      throw err;
    }
  }

  // 从快照复制到实例目录（恢复核心：复制而非移动）：
  // mv 会把共享 inode 移交实例目录——服务器运行后的 in-place 写入会污染
  // 所有仍硬链接同一 inode 的旧快照（快照链不可逆损坏）；复制则实例目录
  // 获得全新 inode，与快照链彻底解耦。rsync -a 保留 mtime，恢复后下次
  // 备份仍可与链尾快照继续硬链接增量。
  // Linux 主路径 / Windows MSYS2 主路径：rsync -a --delete <快照>/ <实例目录>/
  // （源尾 / 复制目录内容；--delete 清理实例目录中快照已不存在的文件——
  // 仅恢复场景使用，快照创建场景严禁 --delete）
  // Windows 降级：robocopy /MIR（镜像语义，等价 --delete）
  async _restoreFromSnapshot(snapshotDir, instanceDir, { timeout = 300000 } = {}) {
    if (process.platform === 'win32') {
      try {
        await spawnProcess('rsync', ['-a', '--delete', `${snapshotDir}/`, `${instanceDir}/`], {
          timeout,
          okCodes: [0, 24],
        });
        return;
      } catch (err) {
        // rsync 缺失（未安装 MSYS2/不在 PATH）：降级 robocopy；其余错误上抛
        if (err.code !== 'ENOENT') throw err;
        console.warn(`[Backup] rsync 不可用，恢复降级为 robocopy: ${err.message}`);
      }
    } else {
      await spawnProcess('rsync', ['-a', '--delete', `${snapshotDir}/`, `${instanceDir}/`], {
        timeout,
        okCodes: [0, 24],
      });
      return;
    }
    // Windows robocopy 降级：/MIR 镜像快照到实例目录
    await spawnProcess('robocopy', [
      snapshotDir,
      instanceDir,
      '/E',
      '/MIR',
      '/MT:16',
      '/R:2',
      '/W:5',
      '/NFL',
      '/NDL',
      '/NP',
    ], {
      timeout,
      okCodes: [0, 1, 2, 3, 4, 5, 6, 7],
    });
  }

  // 从 pre_restore 目录复制回启动 jar（备份排除 jar，恢复后需还原）：
  // 优先按实例配置的 jarFile，缺省扫描根目录所有 *.jar
  _copyBackJarFiles(preRestoreDir, newInstanceDir, preferredJarFile) {
    const jarNames = new Set();
    if (preferredJarFile) jarNames.add(preferredJarFile);
    try {
      for (const entry of fs.readdirSync(preRestoreDir)) {
        if (entry.toLowerCase().endsWith('.jar')) jarNames.add(entry);
      }
    } catch {
      // pre_restore 不可读（不应发生）：按配置的 jarFile 尝试
    }
    for (const name of jarNames) {
      const src = path.join(preRestoreDir, name);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(newInstanceDir, name));
        } catch (e) {
          console.warn(`[Backup] Failed to copy back jar ${name}:`, e.message);
        }
      }
    }
  }

  // 恢复结果校验：实例目录直接层（level-name 目录）内存在 level.dat。
  // 兼容自定义 level-name 与 26.1 新布局（level.dat 均在 world 直接层）
  _hasLevelData(instanceDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(instanceDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(instanceDir, entry.name, 'level.dat'))) {
        return true;
      }
    }
    return false;
  }

  // 删除备份（异步：rm 大目录不阻塞事件循环）。快照为目录树：递归删除
  // （rm -rf 语义）。硬链接引用计数保证删除任意
  // 快照（含中间快照）不影响其他快照——只有某文件在所有快照中最后一次
  // 出现（引用计数归零）才真正释放磁盘
  async deleteBackup(backupId) {
    // find-021：file_path 仅服务层内部使用，走专用查询获取完整行
    const backup = BackupModel.findByIdWithPath(backupId);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }

    // 恢复中的备份不可删除（restoring 状态机互斥：删除会与恢复并发
    // 竞争快照目录，恢复可能已开始读取）
    if (backup.status === 'restoring' || backup.status === 'creating') {
      throw new AppError(ErrorCodes.BACKUP_IN_PROGRESS);
    }

    // find-004 兜底：快照目录路径必须位于备份目录内（防 DB 被篡改后
    // rmSync 递归删除任意目录）
    if (backup.file_path) {
      resolveContained(this.backupsDir, backup.file_path);
    }
    // 删除快照目录（zip 旧格式为文件，rm force 兼容两者）
    if (backup.file_path && fs.existsSync(backup.file_path)) {
      await fs.promises.rm(backup.file_path, { recursive: true, force: true });
    }

    // 删除数据库记录
    return BackupModel.delete(backupId);
  }

  // 自动清理旧备份（createBackup 成功路径接线）：保留策略 = 数量上限 +
  // 时间上限（默认 10 个 / 30 天，config.backupRetention 可配置）。
  // deleteBackup 为异步，逐条 await 保证删除计数与实际删除一致
  async cleanupOldBackups(instanceId, options = {}) {
    const { maxBackups = 10, maxAgeDays = 30 } = options;

    const result = BackupModel.findAll({
      instanceId,
      status: 'completed',
      pageSize: 1000
    });

    const backups = result.backups;

    // 按时间排序，旧的在前
    backups.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    let deletedCount = 0;

    // 删除超过数量限制的备份
    if (backups.length > maxBackups) {
      const toDelete = backups.slice(0, backups.length - maxBackups);
      for (const backup of toDelete) {
        try {
          await this.deleteBackup(backup.id);
          deletedCount++;
        } catch (e) {
          console.error('Failed to delete old backup:', e);
        }
      }
    }

    // 删除超过时间限制的备份
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    const remainingBackups = backups.slice(backups.length - maxBackups);
    for (const backup of remainingBackups) {
      if (new Date(backup.createdAt) < cutoffDate) {
        try {
          await this.deleteBackup(backup.id);
          deletedCount++;
        } catch (e) {
          console.error('Failed to delete old backup:', e);
        }
      }
    }

    return deletedCount;
  }

  // 启动检测：扫描 serversDir 下残留的 pre_restore 目录（进程崩溃在
  // 恢复中段时遗留），告警提示人工确认——不自动处理（无法判断用户意图）
  detectOrphanedPreRestoreDirs() {
    try {
      const orphans = fs.readdirSync(config.serversDir)
        .filter((name) => /_pre_restore_\d{4}-\d{2}-\d{2}T/.test(name) && !EXCLUDED_DIRS.has(name))
        .map((name) => path.join(config.serversDir, name));
      for (const dir of orphans) {
        console.warn(
          `[Backup] 检测到残留的恢复暂存目录（进程可能在上次恢复中崩溃）: ${dir}。` +
          `请人工确认后处理（数据恢复完成可删除；如需回滚请用其中内容覆盖实例目录）`
        );
      }
      return orphans.length;
    } catch {
      return 0;
    }
  }
}

// 安全的 spawn 封装：支持 cwd（rsync 快照需相对 serversDir 归档）、
// 动态超时（大世界备份按预估规模放大，固定 300s 会误杀）与 okCodes
// （退出码白名单——rsync 24=源文件消失需容忍；robocopy 位标志 0-7 全为
// 成功，绝不能按 code===0 判定）。resolve 返回实际退出码供调用方分支。
function spawnProcess(cmd, args, options = {}) {
  const { cwd, timeout = 300000, okCodes = [0] } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', timeout, cwd });
    proc.on('close', (code) => {
      if (okCodes.includes(code)) {
        resolve(code);
      } else {
        reject(new Error(`Exit code ${code}`));
      }
    });
    proc.on('error', (err) => {
      // 命令缺失时给出明确错误并保留 code='ENOENT'（Windows 分支据此
      // 降级 robocopy）：'spawn rsync ENOENT' 无法让用户理解，转译为
      // 可操作提示
      reject(
        err && err.code === 'ENOENT'
          ? Object.assign(
              new Error(`Command not found: ${cmd}（请安装 ${cmd}，如 apt-get install -y ${cmd}）`),
              { code: 'ENOENT' }
            )
          : err
      );
    });
  });
}

// 单例
let instance = null;
export function getBackupService() {
  if (!instance) {
    instance = new BackupService();
  }
  return instance;
}

export default BackupService;
