/**
 * 实例版本升级服务
 * 流程：前置校验 → 自动备份 → 下载新 JAR → 替换 → 首启校验 → 失败回滚
 *
 * 复用：utils/http-client + 既有 BackupService + server-jar.js 的下载 URL 解析
 */
import fs from 'fs';
import path from 'path';
import { httpJson, httpStream } from '../utils/http-client.js';
import { BackupService } from './backup.service.js';
import { resolveSafePath, PathTraversalError } from '../utils/fs-utils.js';
import { AppError, ErrorCodes } from '../utils/response.js';
import { assertAllowedDownloadHost, allowedDownloadHosts } from '../utils/jar-download-guard.js';
import {
  JAR_DOWNLOAD_MAX_BYTES,
  assertDownloadIntegrity,
  assertSizeWithinLimit,
} from '../utils/jar-download-guard.js';
import { logger } from '../utils/logger.js';
import { getServerVersion } from '../utils/version.js';
import { beginCancellableTask, TASK_KINDS, TaskCancelledError } from '../utils/cancellable-task.js';

const VALID_TYPES = new Set(['vanilla', 'paper', 'purpur']);

/// mcVersion 白名单：1-3 位数字段、最多 4 段点分形态（1 / 1.21 /
/// 1.21.4 / 265）。从源头杜绝 '..'、'/'、'\\'、空白、控制字符与 URL 特殊
/// 字符进入文件名与上游 URL 路径；路由层先行校验，此处导出供其复用，
/// 避免两处正则口径分叉。
export const MC_VERSION_REGEX = /^\d{1,3}(\.\d{1,3}){0,3}$/;

/// 升级 JAR 入库文件名白名单：固定 server-<mcVersion>.jar 形态。mcVersion
/// 已过上方白名单，此层双保险防 jarFile 入库值被后续流程（回恢复/启动）
/// 当作穿越向量（「jarFile 入库值同样校验」）。
const SERVER_JAR_NAME_REGEX = /^server-\d{1,3}(\.\d{1,3}){0,3}\.jar$/;

/// 上游下载域白名单：按本服务支持的类型取子集（与 resolveDownloadUrl 三个分支
/// 实际产出的域一致）。上游 API 响应中的 URL 字段（piston manifest 的
/// versionEntry.url / downloads.server.url、paper v3 downloads）理论可携带任意
/// host，下载前统一断言，防污染响应把下载流导向任意主机。
/// 逐类型取子集而非共用并集：升级不支持 fabric/forge，给并集等于把白名单放宽到
/// 那些域，污染响应就能被放行。
const ALLOWED_DOWNLOAD_HOSTS = allowedDownloadHosts([...VALID_TYPES]);

/**
 * 实例内落地路径收口：resolveSafePath 四步防线（归一化/前缀边界/
 * 逐段 realpath/最终 lstat），保证 JAR 写入与回滚覆盖均不逃逸实例目录。
 * PathTraversalError 转 VALIDATION_ERROR 语义（与 plugin.service 同口径）；
 * 实例目录缺失（ENOENT）原样上抛——那是部署配置问题而非安全事件。
 */
function assertSafeInstancePath(serverPath, fileName) {
  try {
    return resolveSafePath(serverPath, fileName, { allowRoot: false });
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `Unsafe upgrade path for: ${fileName}`);
    }
    throw err;
  }
}

const UPGRADE_STAGES = {
  BACKUP: 'backup',
  DOWNLOAD: 'download',
  REPLACE: 'replace',
  VERIFY: 'verify',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
  // 用户取消：与 failed/rolled_back 分档，detail 写明是否发生回滚
  CANCELLED: 'cancelled',
};

// 版本号单一来源：package.json（见 utils/version.js）
const PAPER_USER_AGENT = `MC_Commander/${getServerVersion()} (https://github.com/wyyfzb/mc-commander)`;

export { UPGRADE_STAGES, VALID_TYPES };

export class UpgradeService {
  /**
   * @param {import('../services/mc_server.js').MCServerManager} serverManager
   */
  constructor(serverManager, options = {}) {
    this.serverManager = serverManager;
    this.backupService = new BackupService(serverManager);
    /** @type {Map<string, import('./upgrade.service.js').UpgradeProgress>} */
    // 共享注册表：MCServerManager 构造时创建（websocket.js 连接补发读取），
    // 测试桩无该字段时回退实例本地 Map 保持隔离（serverManager 缺省场景见 health 路由）
    this._activeUpgrades = serverManager?.activeUpgrades ?? new Map();
    // 下载体积上限可注入（测试用），默认 512MB
    this.maxJarDownloadBytes = options.maxJarDownloadBytes ?? JAR_DOWNLOAD_MAX_BYTES;
  }

  /**
   * 解析 JAR 下载地址与期望摘要（issue 316：上游提供 sha 时返回 expectedHash，
   * 下载完成后由 _downloadJar 强制校验）。
   * 各上游摘要可用性：vanilla Piston detail.downloads.server.sha1（官方提供
   * sha1）；paper v3 downloadInfo.checksums.sha256；purpur /latest 的顶层 md5。
   * 无摘要时 expectedHash 为 null，_downloadJar 跳过完整性校验但仍执行体积上限。
   * @param {string} mcVersion
   * @param {string} type - vanilla | paper | purpur
   * @returns {Promise<{ url: string, expectedHash: { algorithm: string, digest: string } | null }>}
   */
  async resolveDownload(mcVersion, type) {
    if (type === 'vanilla') {
      // Mojang Piston API
      const manifest = await httpJson(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        {
          timeoutMs: 15000,
          retryLimit: 2,
        },
      );
      const versionEntry = manifest.versions?.find(
        (v) => v.id === mcVersion && v.type === 'release',
      );
      if (!versionEntry?.url) throw new Error(`Vanilla version ${mcVersion} not found`);
      const versionDetail = await httpJson(versionEntry.url, {
        timeoutMs: 15000,
        retryLimit: 2,
      });
      const serverJar = versionDetail.downloads?.server;
      if (!serverJar?.url) throw new Error(`No server JAR download for ${mcVersion}`);
      const expectedHash = serverJar.sha1 ? { algorithm: 'sha1', digest: serverJar.sha1 } : null;
      return { url: serverJar.url, expectedHash };
    }

    if (type === 'paper') {
      // PaperMC downloads API（v3；主机为 fill.papermc.io——api.papermc.io 是旧域，
      // 其 /v3 路径返回 403、/v2 已 sunset 返回 410，两者都不可用）
      const buildsData = await httpJson(
        `https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`,
        {
          headers: { 'User-Agent': PAPER_USER_AGENT },
          timeoutMs: 15000,
          retryLimit: 2,
        },
      );
      const builds = Array.isArray(buildsData) ? buildsData : buildsData.builds || [];
      const stable = builds.filter((b) => b.channel === 'STABLE' || b.channel === 'RECOMMENDED');
      const candidates = stable.length > 0 ? stable : builds;
      if (candidates.length === 0) throw new Error(`No Paper build found for ${mcVersion}`);
      const latest = candidates.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
      const downloads = latest.downloads || {};
      const downloadInfo = downloads['server:default'] || downloads.application;
      // 摘要位置是 downloadInfo.checksums.sha256（v3 无顶层 sha256 字段）；
      // 读错字段会让 expectedHash 恒为 null 从而静默跳过完整性校验。
      if (!downloadInfo?.url) {
        throw new Error(`No Paper build download for ${mcVersion} (build ${latest.id})`);
      }
      const digest = downloadInfo.checksums?.sha256;
      const expectedHash = digest ? { algorithm: 'sha256', digest } : null;
      return { url: downloadInfo.url, expectedHash };
    }

    if (type === 'purpur') {
      // Purpur API：摘要只在 /latest 响应的顶层 md5 字段里（实测与真实 jar 字节一致），
      // 下载直链本身不带摘要 ⇒ 必须先查 /latest 才能校验。
      // 查不到（网络异常/md5 缺失）时降级为无摘要跳过，不阻断升级。
      const latest = await httpJson(`https://api.purpurmc.org/v2/purpur/${mcVersion}/latest`, {
        timeoutMs: 15000,
        retryLimit: 2,
      });
      const digest = latest.md5;
      // 用 latest.build 而非 /latest/download：否则查询到的摘要与下载的构建可能不是同一个
      // （中间有新构建发布时会错位，导致对正常文件报完整性失败）
      const url =
        latest.build != null
          ? `https://api.purpurmc.org/v2/purpur/${mcVersion}/${latest.build}/download`
          : `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`;
      return {
        url,
        expectedHash: digest ? { algorithm: 'md5', digest } : null,
      };
    }

    throw new Error(`Unsupported server type: ${type}`);
  }

  /**
   * 下载 JAR 文件到指定路径，带进度广播 + 体积上限 + 落地完整性校验（issue 316）
   * @param {string} url
   * @param {string} destPath
   * @param {string} instanceId
   * @param {{ algorithm: string, digest: string } | null} expectedHash - 上游摘要，null 跳过校验
   * @param {AbortSignal|null} [signal] 取消信号（用户中断升级时断流 + 清理半成品）
   */
  _downloadJar(url, destPath, instanceId, expectedHash = null, signal = null) {
    // 域白名单断言在下载流创建前（唯一下载入口，覆盖三个 resolveDownload 分支）
    assertAllowedDownloadHost(url, ALLOWED_DOWNLOAD_HOSTS);
    // AbortSignal 不重放：信号在挂监听前就已中止时，监听永远不会触发 —— 必须在这里
    // 立刻失败，否则调用方会照常走完（取消被吞）
    if (signal?.aborted) return Promise.reject(new TaskCancelledError());
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const stream = httpStream(url, {
        timeoutMs: 120000,
        retryLimit: 2,
        headers: { 'User-Agent': PAPER_USER_AGENT },
        // 必须把取消信号一并交给传输层：实测仅靠下面的 stream.destroy() 在
        // 「响应头尚未到达」时无法中止 fetch，慢上游会把 socket 挂到超时
        signal,
      });

      const detach = () => signal?.removeEventListener('abort', onCancel);
      let aborted = false;
      const onCancel = () => abort(new TaskCancelledError());

      /** 中止：终结写流，待其完全关闭（open 已终结，不会被后续反向创建）后清理半成品，再 reject */
      const abort = (err) => {
        if (aborted) return;
        aborted = true;
        detach();
        stream.destroy();
        file.destroy();
        file.once('close', () => {
          fs.unlink(destPath, () => reject(err));
        });
      };

      signal?.addEventListener('abort', onCancel, { once: true });

      let lastPct = -1;
      stream.on('downloadProgress', ({ percent, transferred }) => {
        // 体积上限断言在前：超限即刻断流清理，不等下载自然结束
        try {
          assertSizeWithinLimit(transferred, this.maxJarDownloadBytes);
        } catch (err) {
          abort(err);
          return;
        }
        // 直接采信客户端的 percent：httpStream 恒按 transferred/total 折算（total 未知时为 0）。
        // 不在此处就地重算——同一公式两处实现必然漂移
        const pct = percent;
        if (pct - lastPct < 0.01) return;
        lastPct = pct;
        this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, Math.round(pct * 100));
      });

      stream.pipe(file);

      file.on('finish', () => {
        // close 回调确保 fd 落盘后才校验摘要（issue 316：fail-closed）
        file.close(() => {
          if (aborted) return;
          assertDownloadIntegrity(destPath, expectedHash)
            .then(() => {
              // 摘要校验期间被取消：abort 已清理半成品并 reject
              if (aborted) return;
              detach();
              resolve();
            })
            .catch((err) => {
              if (aborted) return;
              detach();
              // 校验失败：弃已下载部分并返回含期望/实际摘要的可读错误。
              // 清理完成后才 reject：调用方收到失败错误时磁盘已无残留（fail-closed 完整语义）
              fs.unlink(destPath, () => reject(err));
            });
        });
      });

      // 写盘失败（目录不存在/磁盘满等）：写流 error 事件若无人监听会变成
      // uncaught exception 直接击穿进程，必须显式接管并清理半成品。
      file.on('error', (err) => {
        if (aborted) return;
        detach();
        stream.destroy();
        reject(err);
      });

      stream.on('error', (err) => {
        if (aborted) return;
        detach();
        // 同上：写流完全关闭后再清理，reject 时保证调用方磁盘无半成品残留
        stream.destroy();
        file.destroy();
        file.once('close', () => {
          fs.unlink(destPath, () => reject(err));
        });
      });
    });
  }

  /**
   * 等待备份完成（封装 BackupService 事件）
   * @param {string} instanceId
   * @param {AbortSignal|null} [signal] 取消信号：中断等待并让升级中止。
   *   升级侧取消不主动中断备份（用户可在备份面板单独取消，那会走
   *   backupCancelled）；本函数的 abort 只停止等待，备份照常跑完并留下
   *   一个正常备份——升级取消不需要删除它（那是用户的既有灾备副本）
   */
  _createBackupAndWait(instanceId, signal = null) {
    // AbortSignal 不重放（同 _downloadJar）：已中止时直接失败，别把取消吞掉
    if (signal?.aborted) return Promise.reject(new TaskCancelledError());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Backup timeout')), 300_000);

      const onBackupComplete = (data) => {
        if (data.instanceId === instanceId) {
          cleanup();
          resolve(data.backupId);
        }
      };
      const onBackupFailed = (data) => {
        if (data.instanceId === instanceId) {
          cleanup();
          reject(new Error(data.error || 'Backup failed'));
        }
      };
      // 用户在备份面板取消预备份：backupCancelled 是唯一终态信号（取消不发
      // backupFailed），漏听会让升级挂到 300s 超时才失败
      const onBackupCancelled = (data) => {
        if (data.instanceId === instanceId) {
          cleanup();
          reject(new Error('Backup cancelled'));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onCancel);
        this.serverManager.removeListener('instance:backupComplete', onBackupComplete);
        this.serverManager.removeListener('instance:backupFailed', onBackupFailed);
        this.serverManager.removeListener('instance:backupCancelled', onBackupCancelled);
      };

      const onCancel = () => {
        cleanup();
        reject(new TaskCancelledError());
      };
      signal?.addEventListener('abort', onCancel, { once: true });

      this.serverManager.on('instance:backupComplete', onBackupComplete);
      this.serverManager.on('instance:backupFailed', onBackupFailed);
      this.serverManager.on('instance:backupCancelled', onBackupCancelled);

      // 触发备份
      this.backupService.createBackup(instanceId).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /**
   * 首启校验：120s 窗口监听 instance:status 的 ready/crash 事件
   * （MCServerManager 事件模型：instance 'status' 转发为 instance:status，
   *   payload = { instanceId, event: 'ready'|'crash'|'stopped'|... }）
   * @param {string} instanceId
   * @param {{ signal?: AbortSignal|null }} [opts] signal：取消时停掉这台为校验而启动的
   *   实例（用户取消升级不该在后台留下一个他没启动过的服务器）
   */
  _startAndVerify(instanceId, { signal = null } = {}) {
    // AbortSignal 不重放（同 _downloadJar）：已中止时直接失败，别把取消吞掉
    if (signal?.aborted) return Promise.reject(new TaskCancelledError());
    return new Promise((resolve, reject) => {
      const VERIFY_WINDOW_MS = 120_000;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Startup verification timed out (120s)'));
      }, VERIFY_WINDOW_MS);

      const onStatus = (data) => {
        if (data.instanceId !== instanceId) return;
        if (data.event === 'ready') {
          cleanup();
          resolve();
        } else if (data.event === 'crash') {
          cleanup();
          reject(new Error('Server crashed during startup verification'));
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onCancel);
        this.serverManager.removeListener('instance:status', onStatus);
      };

      const onCancel = () => {
        cleanup();
        // 等停稳再 reject：替换后的取消要覆盖 JAR，而运行中的 JVM 在 Windows 上持有
        // 文件句柄（EBUSY 会让回滚失败、取消变成「回滚未完成」）。stopGracefully 等到
        // 进程退出（超时则强杀），因此 reject 必须放在它之后——提前 reject 会让回滚
        // 与进程退出赛跑，正是要避免的情形
        const instance = this.serverManager.getInstance(instanceId);
        Promise.resolve()
          .then(() => instance?.stopGracefully?.())
          .catch(() => {
            // 未在运行 / 已退出 / 发送失败：都不阻塞回滚
          })
          .finally(() => reject(new TaskCancelledError()));
      };
      signal?.addEventListener('abort', onCancel, { once: true });

      this.serverManager.on('instance:status', onStatus);

      // 启动实例：start 为同步方法（可能同步 throw，如 EULA 未同意）
      // 也兼容未来返回 promise 的情形
      const instance = this.serverManager.getInstance(instanceId);
      if (!instance) {
        cleanup();
        reject(new Error('Instance not found in memory'));
        return;
      }
      try {
        const result = instance.start();
        if (result && typeof result.catch === 'function') {
          result.catch((err) => {
            cleanup();
            reject(err);
          });
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  /**
   * 回滚：恢复旧 JAR + DB/内存回写（#539）
   *
   * 回滚终态三者自洽：DB { jarFile: 旧名, mcVersion: 旧版本 } + 磁盘旧版本
   * jar 本体唯一（旧名内容=旧版本）+ 内存实例同步。阶段 3 已把 DB/内存
   * jarFile 切到新版本文件名，故旧 jar 文件名必须经参数传入（调用方在
   * 编排入口捕获的 oldJarFile），不可读 instance.jarFile（已是新名）。
   * @param {string} instanceId
   * @param {string|null} oldJarPath - 回滚源副本（阶段 3 备份的旧 jar）；
   *   null 或不存在时跳过恢复复制（阶段 3 前失败时无副本可恢复）
   * @param {string|null} _backupId - 备份 ID（预留，当前未用）
   * @param {string} [oldJarFile] - 升级前旧 jar 文件名；缺省时跳过恢复
   *   复制、错位副本清理与 DB/内存回写（仅剩临时副本清理兜底）
   */
  async _doRollback(instanceId, oldJarPath, _backupId, oldJarFile) {
    try {
      const instance = this.serverManager.getInstance(instanceId);
      if (!instance) return;

      // 恢复旧 JAR：目标改为旧 jar 本体路径（#539）。修复前目标是
      // instance.jarFile——阶段 3 后已是新版本文件名，旧内容被拷到新名上
      // 产生「新名旧内容」jar，破坏 server-{mcVersion}.jar 命名约定。
      // 异步复制（#520）：50MB 级 JAR 同步 copyFileSync 会阻塞事件循环
      // 数百毫秒（期间 RCON/WS/全部请求延迟），与同链路其余异步 IO 风格对齐
      // 复制即判定：ENOENT ＝ 旧 jar 已被清理（无副本可恢复），跳过即可；
      // 不做存在性预检——预检与复制之间的窗口里旧 jar 被删会让整段回滚中断
      if (oldJarPath && oldJarFile) {
        const restoreTarget = assertSafeInstancePath(instance.serverPath, oldJarFile);
        await fs.promises.copyFile(oldJarPath, restoreTarget).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }

      // 错位副本清理（#539）：阶段 3 后磁盘上新版本文件名 jar（新版本内容，
      // 即首启失败的那个）不再属于回滚终态，删除使旧版本 jar 本体唯一，
      // 后续备份快照不再冗余收录。同名守卫：阶段 3 前失败（jarFile 未切换）
      // 或同版本直调时二者同名，无错位副本可删。删除失败不阻塞回滚主流程。
      if (oldJarFile && instance.jarFile !== oldJarFile) {
        const misplacedJar = assertSafeInstancePath(instance.serverPath, instance.jarFile);
        await fs.promises.unlink(misplacedJar).catch(() => {});
      }

      // DB/内存回写旧版本（#539）：jarFile 一并回写——修复前仅回写
      // mcVersion，DB jarFile 保持阶段 3 写入的新版本文件名，与磁盘/内存
      // 三者错位，备份快照 --exclude 随之失效（排除新名、收录残留旧本体）。
      // 内存同步：修复前回滚后内存 jarFile/mcVersion 仍指向新版本，错位
      // 副本已删时再次启动将找不到 jar 文件
      if (oldJarFile && instance._originalMcVersion) {
        const { InstanceModel } = await import('../db/index.js');
        InstanceModel.update(instanceId, {
          jarFile: oldJarFile,
          mcVersion: instance._originalMcVersion,
        });
        instance.jarFile = oldJarFile;
        instance.mcVersion = instance._originalMcVersion;
      }
    } finally {
      // 清理临时旧 JAR（await：回滚完成（含清理）后才 resolve，
      // 调用方不会在临时备份仍在磁盘时提前推进 cleanup，#520）
      if (oldJarPath) await fs.promises.unlink(oldJarPath).catch(() => {});
    }
  }

  /**
   * 发射升级进度事件
   */
  _emitProgress(instanceId, stage, percent = 0, detail = '') {
    const progress = { instanceId, stage, percent, detail, timestamp: Date.now() };
    this._activeUpgrades.set(instanceId, progress);
    this.serverManager.emit('instance:upgradeProgress', progress);
  }

  /**
   * 获取升级进度
   */
  getUpgradeProgress(instanceId) {
    return this._activeUpgrades.get(instanceId) || null;
  }

  /**
   * 检查实例是否正在升级
   */
  isUpgrading(instanceId) {
    return this._activeUpgrades.has(instanceId);
  }

  /**
   * 执行升级（异步，调用方不需要 await 完整流程）
   * @returns {Promise<void>}
   */
  async upgrade(instanceId, mcVersion, type) {
    const instance = this.serverManager.getInstance(instanceId);
    if (!instance) throw new Error('Instance not found');

    const oldJarFile = instance.jarFile;
    const oldMcVersion = instance.mcVersion;
    const oldJarPath = path.join(instance.serverPath, oldJarFile);

    // ── 路由白名单被绕过时（直调服务层/未来调用方）的
    // 最后一道防线。fail-fast 于任何副作用（备份/下载）之前。
    // ① jarFile 入库值白名单（固定 server-<version>.jar 形态）
    const newJarName = `server-${mcVersion}.jar`;
    if (!SERVER_JAR_NAME_REGEX.test(newJarName)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `Unsafe JAR file name: ${newJarName}`);
    }
    // ② JAR 落地/备份路径收口：resolveSafePath 保证不逃逸实例目录
    const newJarPath = assertSafeInstancePath(instance.serverPath, newJarName);
    const backupJarPath = assertSafeInstancePath(
      instance.serverPath,
      `._upgrade_backup_${oldJarFile}`,
    );

    let backupId = null;

    // 保存原始版本用于回滚
    instance._originalMcVersion = oldMcVersion;

    // 可取消登记：取消端点据注册表定位本次升级（与部署共用同一注册表实现）。
    // 取消语义 = 以 TaskCancelledError 打断被 await 的步骤，收尾交给下面的 catch
    const task = beginCancellableTask(TASK_KINDS.UPGRADE, instanceId);

    try {
      // 阶段 1：自动备份
      this._emitProgress(instanceId, UPGRADE_STAGES.BACKUP, 0, '正在创建备份...');
      backupId = await this._createBackupAndWait(instanceId, task.signal);
      this._emitProgress(instanceId, UPGRADE_STAGES.BACKUP, 100, '备份完成');
      task.throwIfCancelled();

      // 阶段 2：下载新 JAR
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 0, '正在解析下载地址...');
      const { url: downloadUrl, expectedHash } = await this.resolveDownload(mcVersion, type);
      // 上游解析可能耗时数秒：此窗口内取消只能靠 await 边界拦住
      task.throwIfCancelled();
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 0, '正在下载...');
      await this._downloadJar(downloadUrl, newJarPath, instanceId, expectedHash, task.signal);
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 100, '下载完成');
      task.throwIfCancelled();

      // 阶段 3：替换 JAR
      this._emitProgress(instanceId, UPGRADE_STAGES.REPLACE, 0, '正在替换 JAR...');
      // 备份旧 JAR（异步复制对齐同链路 IO 风格，#520）。
      // 先写 .part 再改名：复制中途失败/被取消时 rollback 源要么不存在、要么完整，
      // 不会把半截文件当成「旧 JAR 副本」覆盖到实例目录（复制不可中断，取消落在
      // 复制中只能等它结束，故副本完整性必须靠原子改名保证）
      // 旧 JAR 已被清理（ENOENT）＝ 没有可备份的副本，跳过；不做存在性预检——
      // 预检与复制之间的窗口里旧 jar 被删会以裸 ENOENT 中断整个升级
      const backupTmpPath = `${backupJarPath}.part`;
      let jarCopied = false;
      try {
        await fs.promises.copyFile(oldJarPath, backupTmpPath);
        jarCopied = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (jarCopied) await fs.promises.rename(backupTmpPath, backupJarPath);
      task.throwIfCancelled();
      // 更新 DB：jarFile + mcVersion
      const { InstanceModel } = await import('../db/index.js');
      InstanceModel.update(instanceId, { jarFile: newJarName, mcVersion });
      instance.jarFile = newJarName;
      instance.mcVersion = mcVersion;
      this._emitProgress(instanceId, UPGRADE_STAGES.REPLACE, 100, '替换完成');
      // 替换已落定但校验未开始的窗口：此处的取消必须走「替换后」的收尾（回滚），
      // 漏掉这一步会让取消被吞掉、最终以「升级失败」收场并触发一次世界恢复
      task.throwIfCancelled();

      // 阶段 4：首启校验
      this._emitProgress(instanceId, UPGRADE_STAGES.VERIFY, 0, '正在启动验证...');
      await this._startAndVerify(instanceId, { signal: task.signal });
      this._emitProgress(instanceId, UPGRADE_STAGES.COMPLETED, 100, '升级完成');

      // 清理：回滚源副本 + 被替换的旧版本 jar（#520：升级成功后实例目录
      // 仅保留当前版本 jar，避免多次升级累积磁盘垃圾；失败/回滚路径不删，
      // 回滚源仍需可用。同路径守卫：路由层已拒同版本升级，直调服务层时
      // oldJarPath 可能与 newJarPath 相同，此时旧 jar 本体即新 jar，不可删）
      fs.unlink(backupJarPath, () => {});
      if (oldJarPath !== newJarPath) {
        fs.unlink(oldJarPath, () => {});
      }
      this._activeUpgrades.delete(instanceId);
    } catch (err) {
      const cancelled = err?.cancelled === true;
      // 替换是否已落定（判定必须在回滚之前：_doRollback 会把 jarFile 写回旧名）。
      // 它是取消口径的分水岭：未替换 ⇒ 实例仍处于升级前状态，无需回滚
      const replaced = instance.jarFile !== oldJarFile;
      /** 取消终态文案：据实说明是否发生回滚 */
      let cancelDetail = `已取消，实例保持 ${oldMcVersion}`;

      try {
        if (cancelled && replaced) {
          // 取消不另发中间进度档：rolled_back 在 WS 层是「升级失败」并落库（通知中心
          // 严重档），复用它会把自己主动取消显示成故障。回滚只花一次文件复制 + 一次
          // DB 写，用户在弹窗里已有「正在取消…」的在途反馈，无需再造一档进度
          await this._doRollback(instanceId, backupJarPath, backupId, oldJarFile);
          cancelDetail = `已取消，已回滚到 ${oldMcVersion}`;
          // 刻意不自动恢复升级前备份（失败路径会恢复）：取消是用户主动中止，
          // 顺带触发一次分钟级世界恢复会把「取消」变成看不见的长任务；
          // 备份仍留在备份列表里，需要时由用户手动恢复
          if (backupId)
            logger.info(
              `[UpgradeService] Upgrade ${instanceId} cancelled; backup ${backupId} kept`,
            );
        } else if (!cancelled) {
          this._emitProgress(
            instanceId,
            UPGRADE_STAGES.ROLLED_BACK,
            0,
            `升级失败: ${err.message}，正在回滚...`,
          );
          await this._doRollback(instanceId, backupJarPath, backupId, oldJarFile);
          // 回滚后尝试恢复备份
          if (backupId) {
            try {
              await this.backupService.restoreBackup(backupId);
            } catch {
              // 恢复备份失败不阻塞主流程
            }
          }
        } else {
          // 替换前的取消：jarFile/DB/磁盘旧 jar 都没动过，回滚无事可做——只清理本次
          // 升级的磁盘产物：旧 jar 副本（含复制中途留下的 .part）与已下载的新 jar。
          // 新 jar 必须删：取消后实例目录里留着新版本 jar 既是垃圾，也与「实例保持旧版本」
          // 的终态文案不符（同路径守卫：旧 jar 本体即新 jar 时不可删）
          await fs.promises.unlink(backupJarPath).catch(() => {});
          await fs.promises.unlink(`${backupJarPath}.part`).catch(() => {});
          if (newJarPath !== oldJarPath) {
            await fs.promises.unlink(newJarPath).catch(() => {});
          }
        }
      } catch (rollbackErr) {
        logger.error(`[UpgradeService] Rollback failed for ${instanceId}:`, rollbackErr);
        // 回滚失败不能报「已回滚」（固定文案会谎报，与部署取消文案同源要求）：
        // 终态据实说明；上抛的仍是触发本次回滚的错误（既有契约，见
        // upgrade.failurepaths.test.js「原错误仍上抛」），取消场景下则为回滚
        // 自身的错误——那里它才是真正的故障
        this._emitProgress(
          instanceId,
          UPGRADE_STAGES.FAILED,
          0,
          `升级失败，回滚未完成: ${rollbackErr.message}`,
        );
        this._activeUpgrades.delete(instanceId);
        throw cancelled ? rollbackErr : err;
      }

      // 终态（注销必须在最后一次 emit 之后：_emitProgress 会把进度重新写回注册表，
      // 先删后发会让终态后仍显示「升级中」）
      this._emitProgress(
        instanceId,
        cancelled ? UPGRADE_STAGES.CANCELLED : UPGRADE_STAGES.FAILED,
        0,
        cancelled ? cancelDetail : `升级失败并已回滚: ${err.message}`,
      );
      this._activeUpgrades.delete(instanceId);
      // 取消不是故障：终态已按 cancelled 发出，正常返回而不是抛错——抛出会让
      // 路由层的 catch 把它记成「Upgrade failed」错误日志（用户动作被写成故障）
      if (cancelled) return;
      throw err;
    } finally {
      // 成功/失败/取消都要注销：残留条目会让取消端点对着已结束的任务回「已取消」
      task.finish();
    }
  }
}

/**
 * @typedef {Object} UpgradeProgress
 * @property {string} instanceId
 * @property {string} stage
 * @property {number} percent
 * @property {string} detail
 * @property {number} timestamp
 */
