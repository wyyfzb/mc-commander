/**
 * 实例版本升级服务（P0-4）
 * 流程：前置校验 → 自动备份 → 下载新 JAR → 替换 → 首启校验 → 失败回滚
 *
 * 复用：got（已在依赖中）+ 既有 BackupService + server-jar.js 的下载 URL 解析
 */
import fs from 'fs';
import path from 'path';
import got from 'got';
import { BackupService } from './backup.service.js';
import { resolveSafePath, PathTraversalError } from '../utils/fs-utils.js';
import { AppError, ErrorCodes } from '../utils/response.js';
import {
  JAR_DOWNLOAD_MAX_BYTES,
  assertDownloadIntegrity,
  assertSizeWithinLimit,
} from '../utils/jar-download-guard.js';
import { logger } from '../utils/logger.js';

const VALID_TYPES = new Set(['vanilla', 'paper', 'purpur']);

/// mcVersion 白名单（S-P0-2）：1-3 位数字段、最多 4 段点分形态（1 / 1.21 /
/// 1.21.4 / 265）。从源头杜绝 '..'、'/'、'\\'、空白、控制字符与 URL 特殊
/// 字符进入文件名与上游 URL 路径；路由层先行校验，此处导出供其复用，
/// 避免两处正则口径分叉。
export const MC_VERSION_REGEX = /^\d{1,3}(\.\d{1,3}){0,3}$/;

/// 升级 JAR 入库文件名白名单：固定 server-<mcVersion>.jar 形态。mcVersion
/// 已过上方白名单，此层双保险防 jarFile 入库值被后续流程（回恢复/启动）
/// 当作穿越向量（S-P0-2「jarFile 入库值同样校验」）。
const SERVER_JAR_NAME_REGEX = /^server-\d{1,3}(\.\d{1,3}){0,3}\.jar$/;

/// 上游下载域白名单：与 resolveDownloadUrl 三个分支实际产出的域一致。
/// 上游 API 响应中的 URL 字段（piston manifest 的 versionEntry.url /
/// downloads.server.url、paper v3 downloads）理论可携带任意 host，下载前
/// 统一断言，防污染响应把下载流导向任意主机。
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'piston-meta.mojang.com',   // vanilla manifest / version detail
  'piston-data.mojang.com',   // vanilla server jar 实际文件域
  'api.papermc.io',           // paper v2/v3 API + v2 回退拼接
  'fill-data.papermc.io',     // paper v3 downloads 实际文件域
  'api.purpurmc.org',         // purpur latest/download
]);

/**
 * 断言下载 URL 的 host 在白名单内（S-P0-2 纵深防御，_downloadJar 唯一入口）。
 * 非白名单域或畸形 URL 一律以 VALIDATION_ERROR 语义拒绝。
 */
function assertAllowedDownloadHost(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid download URL: ${rawUrl}`);
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Download host not allowed: ${host}`);
  }
}

/**
 * 实例内落地路径收口（S-P0-2）：resolveSafePath 四步防线（归一化/前缀边界/
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
};

const PAPER_USER_AGENT = 'MC_Commander/0.1.0 (https://github.com/wyyfzb/mc-commander)';

export { UPGRADE_STAGES, VALID_TYPES };

export class UpgradeService {
  /**
   * @param {import('../services/mc_server.js').MCServerManager} serverManager
   */
  constructor(serverManager, options = {}) {
    this.serverManager = serverManager;
    this.backupService = new BackupService(serverManager);
    /** @type {Map<string, import('./upgrade.service.js').UpgradeProgress>} */
    this._activeUpgrades = new Map();
    // 下载体积上限可注入（测试用），默认 512MB（S-P1-1）
    this.maxJarDownloadBytes = options.maxJarDownloadBytes ?? JAR_DOWNLOAD_MAX_BYTES;
  }

  /**
   * 解析 JAR 下载地址与期望摘要（issue 316：上游提供 sha 时返回 expectedHash，
   * 下载完成后由 _downloadJar 强制校验）。
   * 各上游摘要可用性：vanilla Piston detail.downloads.server.sha1（官方提供
   * sha1）；paper v3 downloadInfo.sha256（v2 回退拼接路径无摘要可用）；
   * purpur latest/download 无摘要。无摘要时 expectedHash 为 null，
   * _downloadJar 跳过完整性校验但仍执行体积上限。
   * @param {string} mcVersion
   * @param {string} type - vanilla | paper | purpur
   * @returns {Promise<{ url: string, expectedHash: { algorithm: string, digest: string } | null }>}
   */
  async resolveDownload(mcVersion, type) {
    if (type === 'vanilla') {
      // Mojang Piston API
      const manifest = await got('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
        timeout: { request: 15000 },
        retry: { limit: 2 },
      }).json();
      const versionEntry = manifest.versions?.find(v => v.id === mcVersion && v.type === 'release');
      if (!versionEntry?.url) throw new Error(`Vanilla version ${mcVersion} not found`);
      const versionDetail = await got(versionEntry.url, {
        timeout: { request: 15000 },
        retry: { limit: 2 },
      }).json();
      const serverJar = versionDetail.downloads?.server;
      if (!serverJar?.url) throw new Error(`No server JAR download for ${mcVersion}`);
      const expectedHash = serverJar.sha1
        ? { algorithm: 'sha1', digest: serverJar.sha1 }
        : null;
      return { url: serverJar.url, expectedHash };
    }

    if (type === 'paper') {
      // PaperMC v3 API
      const buildsData = await got(`https://api.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`, {
        headers: { 'User-Agent': PAPER_USER_AGENT },
        timeout: { request: 15000 },
        retry: { limit: 2 },
      }).json();
      const builds = Array.isArray(buildsData) ? buildsData : (buildsData.builds || []);
      const stable = builds.filter(b => b.channel === 'STABLE' || b.channel === 'RECOMMENDED');
      const candidates = stable.length > 0 ? stable : builds;
      if (candidates.length === 0) throw new Error(`No Paper build found for ${mcVersion}`);
      const latest = candidates.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
      const downloads = latest.downloads || {};
      const downloadInfo = downloads['server:default'] || downloads.application;
      if (downloadInfo?.url) {
        const expectedHash = downloadInfo.sha256
          ? { algorithm: 'sha256', digest: downloadInfo.sha256 }
          : null;
        return { url: downloadInfo.url, expectedHash };
      }
      // v2 回退拼接路径无上游响应，拿不到摘要 → 跳过完整性校验
      const buildNum = latest.id || latest.build;
      const fileName = downloadInfo?.name || `paper-${mcVersion}-${buildNum}.jar`;
      return {
        url: `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${buildNum}/downloads/${fileName}`,
        expectedHash: null,
      };
    }

    if (type === 'purpur') {
      // Purpur API（上游不提供摘要 → 跳过完整性校验，仍执行体积上限）
      return { url: `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`, expectedHash: null };
    }

    throw new Error(`Unsupported server type: ${type}`);
  }

  /**
   * 下载 JAR 文件到指定路径，带进度广播 + 体积上限 + 落地完整性校验（issue 316）
   * @param {string} url
   * @param {string} destPath
   * @param {string} instanceId
   * @param {{ algorithm: string, digest: string } | null} expectedHash - 上游摘要，null 跳过校验
   */
  _downloadJar(url, destPath, instanceId, expectedHash = null) {
    // 域白名单断言在下载流创建前（唯一下载入口，覆盖三个 resolveDownload 分支）
    assertAllowedDownloadHost(url);
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const stream = got.stream(url, {
        timeout: { request: 120000 },
        retry: { limit: 2 },
        headers: { 'User-Agent': PAPER_USER_AGENT },
      });

      /** 中止：清理半成品 + 断流 + reject（promise 已 settle 时 reject 为 no-op） */
      const abort = (err) => {
        fs.unlink(destPath, () => {});
        stream.destroy();
        file.destroy();
        reject(err);
      };

      let lastPct = -1;
      stream.on('downloadProgress', ({ percent, transferred, total }) => {
        // 体积上限断言在前（S-P1-1）：超限即刻断流清理，不等下载自然结束
        try {
          assertSizeWithinLimit(transferred, this.maxJarDownloadBytes);
        } catch (err) {
          abort(err);
          return;
        }
        const pct = percent > 0 ? percent : (total > 0 ? transferred / total : 0);
        if (pct - lastPct < 0.01) return;
        lastPct = pct;
        this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, Math.round(pct * 100));
      });

      stream.pipe(file);

      file.on('finish', () => {
        // close 回调确保 fd 落盘后才校验摘要（issue 316：fail-closed）
        file.close(() => {
          assertDownloadIntegrity(destPath, expectedHash)
            .then(() => resolve())
            .catch((err) => {
              // 校验失败：弃已下载部分（清理残留）并返回含期望/实际摘要的可读错误
              fs.unlink(destPath, () => {});
              reject(err);
            });
        });
      });

      // 写盘失败（目录不存在/磁盘满等）：写流 error 事件若无人监听会变成
      // uncaught exception 直接击穿进程，必须显式接管并清理半成品。
      file.on('error', (err) => {
        stream.destroy();
        reject(err);
      });

      stream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * 等待备份完成（封装 BackupService 事件）
   */
  _createBackupAndWait(instanceId) {
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

      const cleanup = () => {
        clearTimeout(timeout);
        this.serverManager.removeListener('instance:backupComplete', onBackupComplete);
        this.serverManager.removeListener('instance:backupFailed', onBackupFailed);
      };

      this.serverManager.on('instance:backupComplete', onBackupComplete);
      this.serverManager.on('instance:backupFailed', onBackupFailed);

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
   */
  _startAndVerify(instanceId) {
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
        this.serverManager.removeListener('instance:status', onStatus);
      };

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
   * 回滚：恢复旧 JAR + DB 回写
   */
  async _doRollback(instanceId, oldJarPath, _backupId) {
    try {
      const instance = this.serverManager.getInstance(instanceId);
      if (!instance) return;

      // 恢复旧 JAR（jarFile 为 DB 值，路径同样收口，防回滚覆盖逃逸实例目录）
      if (oldJarPath && fs.existsSync(oldJarPath)) {
        const currentJar = assertSafeInstancePath(instance.serverPath, instance.jarFile);
        fs.copyFileSync(oldJarPath, currentJar);
      }

      // DB 回写旧版本
      if (instance._originalMcVersion) {
        const { InstanceModel } = await import('../db/index.js');
        InstanceModel.update(instanceId, { mcVersion: instance._originalMcVersion });
      }
    } finally {
      // 清理临时旧 JAR
      if (oldJarPath) fs.unlink(oldJarPath, () => {});
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

    // ── S-P0-2 纵深防御：路由白名单被绕过时（直调服务层/未来调用方）的
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
      `._upgrade_backup_${oldJarFile}`
    );

    let backupId = null;

    // 保存原始版本用于回滚
    instance._originalMcVersion = oldMcVersion;

    try {
      // 阶段 1：自动备份
      this._emitProgress(instanceId, UPGRADE_STAGES.BACKUP, 0, '正在创建备份...');
      backupId = await this._createBackupAndWait(instanceId);
      this._emitProgress(instanceId, UPGRADE_STAGES.BACKUP, 100, '备份完成');

      // 阶段 2：下载新 JAR
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 0, '正在解析下载地址...');
      const { url: downloadUrl, expectedHash } = await this.resolveDownload(mcVersion, type);
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 0, '正在下载...');
      await this._downloadJar(downloadUrl, newJarPath, instanceId, expectedHash);
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 100, '下载完成');

      // 阶段 3：替换 JAR
      this._emitProgress(instanceId, UPGRADE_STAGES.REPLACE, 0, '正在替换 JAR...');
      // 备份旧 JAR
      if (fs.existsSync(oldJarPath)) {
        fs.copyFileSync(oldJarPath, backupJarPath);
      }
      // 更新 DB：jarFile + mcVersion
      const { InstanceModel } = await import('../db/index.js');
      InstanceModel.update(instanceId, { jarFile: newJarName, mcVersion });
      instance.jarFile = newJarName;
      instance.mcVersion = mcVersion;
      this._emitProgress(instanceId, UPGRADE_STAGES.REPLACE, 100, '替换完成');

      // 阶段 4：首启校验
      this._emitProgress(instanceId, UPGRADE_STAGES.VERIFY, 0, '正在启动验证...');
      await this._startAndVerify(instanceId);
      this._emitProgress(instanceId, UPGRADE_STAGES.COMPLETED, 100, '升级完成');

      // 清理
      fs.unlink(backupJarPath, () => {});
      this._activeUpgrades.delete(instanceId);
    } catch (err) {
      // 回滚
      this._emitProgress(instanceId, UPGRADE_STAGES.ROLLED_BACK, 0, `升级失败: ${err.message}，正在回滚...`);
      try {
        await this._doRollback(instanceId, backupJarPath, backupId);
        // 回滚后尝试恢复备份
        if (backupId) {
          try {
            await this.backupService.restoreBackup(backupId);
          } catch {
            // 恢复备份失败不阻塞主流程
          }
        }
      } catch (rollbackErr) {
        logger.error(`[UpgradeService] Rollback failed for ${instanceId}:`, rollbackErr);
      }

      this._emitProgress(instanceId, UPGRADE_STAGES.FAILED, 0, `升级失败并已回滚: ${err.message}`);
      this._activeUpgrades.delete(instanceId);
      throw err;
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
