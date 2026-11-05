/**
 * 实例版本升级服务
 * 流程：前置校验 → 自动备份 → 下载新 JAR → 替换 → 首启校验 → 失败回滚
 *
 * 复用：utils/http-client + 既有 BackupService + server-jar.js 的下载 URL 解析
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { SERVER_TYPES } from '@mc-commander/schemas';
import { httpJson, httpStream } from '../utils/http-client.js';
import { BackupService, hasWorldData } from './backup.service.js';
import { resolveSafePath, PathTraversalError } from '../utils/fs-utils.js';
import { AppError, ErrorCodes } from '../utils/response.js';
import { assertAllowedDownloadHost, allowedDownloadHosts } from '../utils/jar-download-guard.js';
import {
  JAR_DOWNLOAD_MAX_BYTES,
  assertDownloadIntegrity,
  assertSizeWithinLimit,
} from '../utils/jar-download-guard.js';
import { logger } from '../utils/logger.js';
import { resolveVanillaDownload } from './vanilla-manifest.js';
import { syncInstanceJson } from './mc_server.js';
import {
  resolveFabricDownload,
  resolveForgeInstallerDownload,
  resolvePurpurDownload,
} from './loader-upstreams.js';
import {
  findJavaPathStrict,
  getRecommendedJavaVersion,
  isJavaSatisfied,
} from '../utils/java-detector.js';
import { ensureJavaRuntime } from './java-runtime.service.js';
import { readJarVersionInfo } from './mc-server/jar-version.js';
import { getServerVersion } from '../utils/version.js';
import { beginCancellableTask, TASK_KINDS, TaskCancelledError } from '../utils/cancellable-task.js';
import { killProcessTree } from '../utils/process-tree.js';

/// 升级支持的类型＝契约包的类型枚举。升级与部署必须同口径：两边各写一份时，
/// 新增类型会变成「能建不能升」——实例建得出来、永远升不了，报错却只有 Invalid type。
const VALID_TYPES = new Set(SERVER_TYPES);

/** DB `mod_loader` 列的取值形态（首字母大写，与部署写入一致） */
function typeLabel(type) {
  const t = String(type || 'vanilla').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/// mcVersion 白名单：1-3 位数字段、最多 4 段点分形态（1 / 1.21 /
/// 1.21.4 / 265）。从源头杜绝 '..'、'/'、'\\'、空白、控制字符与 URL 特殊
/// 字符进入文件名与上游 URL 路径；路由层先行校验，此处导出供其复用，
/// 避免两处正则口径分叉。
export const MC_VERSION_REGEX = /^\d{1,3}(\.\d{1,3}){0,3}$/;

/// 升级 JAR 入库文件名白名单：固定 server-<mcVersion>.jar 形态。mcVersion
/// 已过上方白名单，此层双保险防 jarFile 入库值被后续流程（回恢复/启动）
/// 当作穿越向量（「jarFile 入库值同样校验」）。
const SERVER_JAR_NAME_REGEX = /^server-\d{1,3}(\.\d{1,3}){0,3}\.jar$/;

/// 上游下载域白名单：**按本次升级的类型**取子集，不是全部类型的并集。
/// 上游响应里的 URL 字段（piston manifest 的 versionEntry.url /
/// downloads.server.url、paper v3 downloads）理论可携带任意 host，下载前统一断言。
/// 用并集等于让一次 vanilla 升级就能被污染响应导向 forge 的文件域 —— 白名单被悄悄放宽。
function allowedHostsFor(type) {
  return allowedDownloadHosts([String(type || 'vanilla').toLowerCase()]);
}

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
  // 补齐目标版本要求的 Java（面板自供 JRE）：与 download 分档，进度含义是「准备 Java」
  PREPARE_JAVA: 'prepare_java',
  // Forge 安装器在跑：它要下载 100MB+ 的 libraries 并打补丁，实测单次 2~5 分钟，
  // 混进 download 会让进度条长时间停在同一档、读起来像卡死
  FORGE_INSTALL: 'forge_install',
  REPLACE: 'replace',
  VERIFY: 'verify',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
  // 用户取消：与 failed/rolled_back 分档，detail 写明是否发生回滚
  CANCELLED: 'cancelled',
};

/// Forge 安装器超时。判据是实测耗时而不是拍一个整数：一次全新安装要下载 100MB+
/// 的 libraries，实测 1.21.4-54.1.22 约 5 分钟、1.20.1-47.4.28 约 2 分钟；
/// 同一版本重装（libraries 已在本地）只要 6 秒。耗时几乎全部是下行带宽，
/// 慢线路会成倍放大，故按实测最慢值留 3 倍余量取 15 分钟。
/// 部署侧的 120s 在真机上必然超时并杀掉安装器，此处不能再沿用那个值。
export const FORGE_INSTALL_TIMEOUT_MS = 900_000;

/// Forge 安装器在实例内的落地名。固定名而不是沿用 server-<ver>.jar：安装器产物
/// 识别靠「非本文件 + forge-*.jar」，且它必须能与任意版本的入口 jar 区分开。
const FORGE_INSTALLER_NAME = 'forge-installer.jar';

/// Forge 安装器内存上限：安装器只做下载与字节码补丁，实测 -Xmx512M 足够；
/// 它和实例本身的 -Xmx 是两个进程，不能按实例内存给。
const FORGE_INSTALL_XMX = '-Xmx512M';

/// Fabric/Forge 的首启校验窗口。这两类的启动 jar 自己就是个引导器：fabric 的
/// launcher 要先下原版服务端再 remap，forge 的 shim 要先解出嵌套依赖。
/// 实测 fabric 1.21.4 冷启动从进程启动到 Done 共 116s（Done 自身 24s），
/// 边缘只剩 4s ⇒ 照 120s 判会把正常启动判成超时并触发一次无谓回滚。
/// 取 300s：覆盖首启自带的世界生成（实测 26.3 首启 3.5s，1.21.4 约 24s）
/// 与引导器的一次性下载，仍远小于用户可感知的「卡死」阈值。
const MODDED_VERIFY_WINDOW_MS = 300_000;

// 版本号单一来源：package.json（见 utils/version.js）
const PAPER_USER_AGENT = `MC_Commander/${getServerVersion()} (https://github.com/wyyfzb/mc-commander)`;

export { UPGRADE_STAGES, VALID_TYPES };

/**
 * Forge 安装器产出的实例入口 jar 文件名。
 *
 * 判据不是「哪个 jar 看起来像服务端」，而是**本次安装到底留下了什么**：
 * - 实测 1.21.4-54.1.22 与 26.3-66.1.0 在实例根目录留下
 *   `forge-<mc>-<forge>-shim.jar`，`libraries/.../unix_args.txt` 的 `-jar` 指向它；
 * - 实测 1.20.1-47.4.28 的安装器根目录不产出任何 jar，`unix_args.txt` 写的是主类
 *   `cpw.mods.bootstraplauncher.BootstrapLauncher` 而非 `-jar`。
 *
 * ⚠️ 必须按**本次 mcVersion 前缀**过滤：安装器不清理别的版本产物，同一实例目录里
 * 可能同时躺着上一个版本的 jar（实测先装 1.21.4、再装 1.20.1 后，根目录只剩旧的
 * `forge-1.21.4-54.1.22-shim.jar`）。不带前缀过滤会把它当成本次产物，于是
 * 「升级到 1.20.1」实际启动的是 1.21.4 的 jar——升级假成功，比失败更糟。
 *
 * @param {string[]} entries 实例根目录的文件名
 * @param {string} installerName 本次下载的安装器文件名（它自己不是启动 jar）
 * @param {string} mcVersion 本次安装的目标 MC 版本
 * @returns {string|null}
 */
export function pickForgeLaunchJar(entries, installerName, mcVersion) {
  const prefix = `forge-${mcVersion}-`;
  const candidates = entries.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.jar') && f !== installerName,
  );
  const shim = candidates.find((f) => f.endsWith('-shim.jar'));
  if (shim) return shim;
  return candidates[0] ?? null;
}

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
   * 解析 JAR 下载地址与期望摘要（上游提供 sha 时返回 expectedHash，
   * 下载完成后由 _downloadJar 强制校验）。
   * 各上游摘要可用性：vanilla Piston detail.downloads.server.sha1（官方提供
   * sha1）；paper v3 downloadInfo.checksums.sha256；purpur /latest 的顶层 md5。
   * 无摘要时 expectedHash 为 null，_downloadJar 跳过完整性校验但仍执行体积上限。
   * @param {string} mcVersion
   * @param {string} type - SERVER_TYPES 之一
   * @param {string} [loaderVersion] fabric/forge 的 loader 版本；留空取上游最新稳定版
   * @returns {Promise<{ url: string, expectedHash: { algorithm: string, digest: string } | null }>}
   */
  async resolveDownload(mcVersion, type, loaderVersion) {
    if (type === 'vanilla') {
      // 与部署共用同一实现（services/vanilla-manifest.js）：同一个事实只留一种取法
      return resolveVanillaDownload(mcVersion);
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
      // 与部署共用同一实现（services/loader-upstreams.js）
      return resolvePurpurDownload(mcVersion);
    }

    if (type === 'fabric') {
      // 与部署共用同一实现：上游按 loader 版本拼固定路径、**不提供摘要**
      // ⇒ expectedHash 恒为 null（如实表达「上游没给」，不拿别的字段凑）
      return resolveFabricDownload(mcVersion, loaderVersion);
    }

    if (type === 'forge') {
      // 上游给的是**安装器**而非服务端 jar：下载完必须再跑 --installServer 生成入口 jar
      return resolveForgeInstallerDownload(mcVersion);
    }

    throw new Error(`Unsupported server type: ${type}`);
  }

  /**
   * 跑 Forge 安装器（`java -jar <installer> --installServer`）。
   *
   * 必须做这一步的原因：forge 上游只提供安装器，服务端入口 jar 与整个 libraries/
   * 依赖树都由它生成。只下载安装器改名当 jar 用，实例永远起不来。
   *
   * 超时与取消都用 killProcessTree 收尾：安装器在这一步同时持有下载连接与
   * 半写的 libraries/ 文件，只杀主进程会留下仍在写盘的子 JVM，下一次安装撞上
   * 半截文件会让失败延后到首启校验，用户看到的是「升完起不来」。
   *
   * @param {string} javaPath 与实例同档的 Java（安装器要加载目标版本的类做补丁）
   * @param {string} instancePath 实例目录（安装器以 cwd 为落点写 libraries/）
   * @param {string} installerName 安装器文件名（相对 instancePath）
   * @param {string} instanceId 仅用于日志
   * @param {string} mcVersion 本次安装的目标 MC 版本（用于认领本次产出的入口 jar）
   * @param {AbortSignal|null} signal 取消信号
   * @returns {Promise<string>} 生成的入口 jar 文件名
   */
  _runForgeInstaller(javaPath, instancePath, installerName, instanceId, mcVersion, signal = null) {
    if (signal?.aborted) return Promise.reject(new TaskCancelledError());
    return new Promise((resolve, reject) => {
      const proc = spawn(javaPath, [FORGE_INSTALL_XMX, '-jar', installerName, '--installServer'], {
        cwd: instancePath,
      });

      // 安装器输出只在失败时有用：成功路径下它会把整个补丁清单刷进日志
      let tail = '';
      const collect = (chunk) => {
        tail = (tail + chunk.toString()).slice(-4000);
      };
      proc.stdout?.on('data', collect);
      proc.stderr?.on('data', collect);

      let settled = false;
      /** 单次落定：超时、取消、退出可能同时到达，先到者胜 */
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onCancel);
        if (err) reject(err);
        else {
          // 退出码 0 不等于产物可用：入口 jar 名找不到就如实失败，
          // 猜一个会让实例在首启校验时才崩，用户拿到的是「升完起不来」。
          // 部分游戏版本的安装器只产出 libraries/ 与 argfile、根目录没有 jar，
          // 面板按 `-jar <入口 jar>` 启动承载不了这种形态。不点名具体版本：
          // 已知 1.20.1 如此，更高版本是否一律恢复没有实测支撑
          const jar = pickForgeLaunchJar(fs.readdirSync(instancePath), installerName, mcVersion);
          if (jar) resolve(jar);
          else
            reject(
              new Error(
                `${mcVersion} 的 Forge 安装器没有产出可启动的入口 jar；` +
                  '该版本的安装器产物形态面板暂不支持，请改用较新的游戏版本重试',
              ),
            );
        }
      };

      const timer = setTimeout(() => {
        killProcessTree(proc);
        settle(new Error(`Forge 安装器超时（${FORGE_INSTALL_TIMEOUT_MS / 60_000} 分钟）`));
      }, FORGE_INSTALL_TIMEOUT_MS);

      // 安装器是单进程 java 程序（未 detached），不做进程组终止
      const onCancel = () => {
        killProcessTree(proc);
        settle(new TaskCancelledError());
      };
      signal?.addEventListener('abort', onCancel, { once: true });

      proc.on('exit', (code) => {
        if (settled) return;
        if (code !== 0) {
          logger.warn(`[upgrade ${instanceId}] Forge 安装器退出码 ${code}: ${tail.slice(-800)}`);
          settle(new Error(`Forge 安装器失败（退出码 ${code}）`));
          return;
        }
        settle();
      });

      proc.on('error', (err) => {
        logger.warn(`[upgrade ${instanceId}] Forge 安装器启动失败:`, err.message);
        settle(err);
      });
    });
  }

  /**
   * 下载 JAR 文件到指定路径，带进度广播 + 体积上限 + 落地完整性校验
   * @param {string} url
   * @param {string} destPath
   * @param {string} instanceId
   * @param {{ algorithm: string, digest: string } | null} expectedHash - 上游摘要，null 跳过校验
   * @param {AbortSignal|null} [signal] 取消信号（用户中断升级时断流 + 清理半成品）
   */
  /**
   * 目标版本要求的 Java 主版本号（字符串）。
   * 优先级：新 jar 内 version.json 的 java_version → 与部署同一套推荐表 → null（不阻塞）。
   * @param {string} newJarPath 刚下载、尚未替换的新 jar 绝对路径
   * @param {string} mcVersion 目标 MC 版本
   * @returns {string|null}
   */
  _resolveRequiredJava(newJarPath, mcVersion) {
    // 动态 import 避免与 jar-version 域形成顶层循环依赖
    const info = readJarVersionInfo(newJarPath);
    if (info?.javaVersion) return String(info.javaVersion);
    const recommended = getRecommendedJavaVersion(mcVersion);
    return recommended || null;
  }

  _downloadJar(url, destPath, instanceId, expectedHash = null, signal = null, type = 'vanilla') {
    // 域白名单断言在下载流创建前（唯一下载入口，覆盖全部 resolveDownload 分支）。
    // 按类型取子集：见 allowedHostsFor
    assertAllowedDownloadHost(url, allowedHostsFor(type));
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
        // close 回调确保 fd 落盘后才校验摘要（fail-closed）
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
   * 首启校验：监听 instance:status 的 ready/crash 事件
   * （MCServerManager 事件模型：instance 'status' 转发为 instance:status，
   *   payload = { instanceId, event: 'ready'|'crash'|'stopped'|... }）
   * @param {string} instanceId
   * @param {{ signal?: AbortSignal|null, timeoutMs?: number }} [opts] signal：取消时停掉
   *   这台为校验而启动的实例（用户取消升级不该在后台留下一个他没启动过的服务器）；
   *   timeoutMs：校验窗口，默认 120s
   */
  _startAndVerify(instanceId, { signal = null, timeoutMs = 120_000 } = {}) {
    // AbortSignal 不重放（同 _downloadJar）：已中止时直接失败，别把取消吞掉
    if (signal?.aborted) return Promise.reject(new TaskCancelledError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Startup verification timed out (${timeoutMs / 1000}s)`));
      }, timeoutMs);

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
   * 回滚：恢复旧 JAR + DB/内存回写
   *
   * 回滚终态三者自洽：DB { jarFile: 旧名, mcVersion: 旧版本 } + 磁盘旧版本
   * jar 本体唯一（旧名内容=旧版本）+ 内存实例同步。阶段 3 已把 DB/内存
   * jarFile 切到新版本文件名，故旧 jar 文件名必须经参数传入（调用方在
   * 编排入口捕获的 oldJarFile），不可读 instance.jarFile（已是新名）。
   * @param {string} instanceId
   * @param {string|null} oldJarPath - 回滚源副本（阶段 3 备份的旧 jar）；
   *   null 或不存在时跳过恢复复制（阶段 3 前失败时无副本可恢复）
   * @param {string} [oldJarFile] - 升级前旧 jar 文件名；缺省时跳过恢复
   *   复制、错位副本清理与 DB/内存回写（仅剩临时副本清理兜底）
   */
  async _doRollback(instanceId, oldJarPath, oldJarFile) {
    try {
      const instance = this.serverManager.getInstance(instanceId);
      if (!instance) return;

      // 恢复旧 JAR：目标为旧 jar 本体路径。阶段 3 后 instance.jarFile 已是新版本
      // 文件名，以它为目标会把旧内容拷到新名上，产生「新名旧内容」jar，破坏
      // server-{mcVersion}.jar 命名约定。
      // 异步复制：50MB 级 JAR 同步 copyFileSync 会阻塞事件循环
      // 数百毫秒（期间 RCON/WS/全部请求延迟），与同链路其余异步 IO 风格对齐
      // 复制即判定：ENOENT ＝ 旧 jar 已被清理（无副本可恢复），跳过即可；
      // 不做存在性预检——预检与复制之间的窗口里旧 jar 被删会让整段回滚中断
      if (oldJarPath && oldJarFile) {
        const restoreTarget = assertSafeInstancePath(instance.serverPath, oldJarFile);
        await fs.promises.copyFile(oldJarPath, restoreTarget).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }

      // 错位副本清理：阶段 3 后磁盘上新版本文件名 jar（新版本内容，
      // 即首启失败的那个）不属于回滚终态，删除使旧版本 jar 本体唯一，
      // 后续备份快照不再冗余收录。同名守卫：阶段 3 前失败（jarFile 未切换）
      // 或同版本直调时二者同名，无错位副本可删。删除失败不阻塞回滚主流程。
      if (oldJarFile && instance.jarFile !== oldJarFile) {
        const misplacedJar = assertSafeInstancePath(instance.serverPath, instance.jarFile);
        await fs.promises.unlink(misplacedJar).catch(() => {});
      }

      // DB/内存回写旧版本：jarFile 一并回写——只回写 mcVersion 会让 DB jarFile
      // 保持阶段 3 写入的新版本文件名，与磁盘/内存三者错位，备份快照 --exclude
      // 随之失效（排除新名、收录残留旧本体）。
      // 内存同步：不同步回写 jarFile/mcVersion 时，错位副本已删的情况下再次
      // 启动将找不到 jar 文件
      if (oldJarFile && instance._originalMcVersion) {
        const { InstanceModel } = await import('../db/index.js');
        InstanceModel.update(instanceId, {
          jarFile: oldJarFile,
          mcVersion: instance._originalMcVersion,
          // 类型与磁盘上的 jar 必须同步回写：只在内存里还原会让 panel 记录的类型
          // 与真实 jar 各自停在升级前后两端
          modLoader: typeLabel(instance._originalModLoader),
        });
        instance.jarFile = oldJarFile;
        instance.mcVersion = instance._originalMcVersion;
        instance.modLoader = instance._originalModLoader;
        // 兜底文件同口径：DB 丢失后按 instance.json 恢复时，类型与版本必须与磁盘一致
        syncInstanceJson(instance);
      }
    } finally {
      // 清理临时旧 JAR（await：回滚完成（含清理）后才 resolve，
      // 调用方不会在临时备份仍在磁盘时提前推进 cleanup）
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
  async upgrade(instanceId, mcVersion, type, loaderVersion) {
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
    // 备份恢复失败的原因：非空时终态不能说「已回滚」
    let restoreFailure = null;

    // 保存原始版本与类型用于回滚：升级允许换服务端类型，回滚必须把类型一并还原：
    // 只还原版本会让实例记录与实际 jar 脱节
    instance._originalMcVersion = oldMcVersion;
    instance._originalModLoader = instance.modLoader;

    /// 升级终态要写进 DB/实例的 jar 文件名。非 Forge 恒为 server-<mcVersion>.jar；
    /// Forge 由安装器决定（不同版本安装器的产物名不同），在安装阶段回填
    let finalJarName = newJarName;
    // Forge 上游给的是安装器：它先落在固定名上，装完再由安装器产出入口 jar。
    // 这两个名字在 catch 里也要用（取消清理 / 回滚清理），故在 try 之前声明
    const isForge = type === 'forge';
    const downloadPath = assertSafeInstancePath(
      instance.serverPath,
      isForge ? FORGE_INSTALLER_NAME : newJarName,
    );

    // 可取消登记：取消端点据注册表定位本次升级（与部署共用同一注册表实现）。
    // 取消语义 = 以 TaskCancelledError 打断被 await 的步骤，收尾交给下面的 catch
    const task = beginCancellableTask(TASK_KINDS.UPGRADE, instanceId);

    try {
      // 阶段 1：自动备份
      // 从未启动过的实例没有世界数据，这份备份保护的是空集：升级只改 jar 与
      // DB 三列（各有独立回滚源），配置/名单/插件目录一概不碰，唯一的不可逆
      // 写入是新版本首启对世界数据的升级——而那个世界不存在。
      // 跳过必须明说：静默跳过会让用户以为还有一份安全网
      this._emitProgress(instanceId, UPGRADE_STAGES.BACKUP, 0, '正在创建备份...');
      if (hasWorldData(instance)) {
        backupId = await this._createBackupAndWait(instanceId, task.signal);
        this._emitProgress(instanceId, UPGRADE_STAGES.BACKUP, 100, '备份完成');
      } else {
        this._emitProgress(
          instanceId,
          UPGRADE_STAGES.BACKUP,
          100,
          '该实例尚无世界数据，已跳过备份',
        );
      }
      task.throwIfCancelled();

      // 阶段 2：下载新 JAR
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 0, '正在解析下载地址...');
      const { url: downloadUrl, expectedHash } = await this.resolveDownload(
        mcVersion,
        type,
        loaderVersion,
      );
      // 上游解析可能耗时数秒：此窗口内取消只能靠 await 边界拦住
      task.throwIfCancelled();
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 0, '正在下载...');
      await this._downloadJar(
        downloadUrl,
        downloadPath,
        instanceId,
        expectedHash,
        task.signal,
        type,
      );
      this._emitProgress(instanceId, UPGRADE_STAGES.DOWNLOAD, 100, '下载完成');
      task.throwIfCancelled();

      // 阶段 2.5：Java 校验。**必须落在替换之前**——替换一旦执行就已改掉 DB 与实例
      // jar，那是整条链路里最难回退的时点；而跨 Java 大版本升级（1.20.x 的 Java 17
      // → 26.3 的 Java 25）若不先校验就会一路改完后才在首启时崩，用户拿到的是「升完起不来」。
      // 权威来源是刚下载的新 jar 内 version.json 的 java_version（服务端自带），
      // 不手写版本矩阵；读不到就退回与部署同一套推荐表，再读不到则不阻塞（无法证明）。
      // Forge 读的是安装器（其中没有 version.json）⇒ 走推荐表，与部署同口径。
      const requiredJava = this._resolveRequiredJava(downloadPath, mcVersion);
      if (requiredJava) {
        const currentJava = instance.javaPath;
        if (!isJavaSatisfied(currentJava, requiredJava)) {
          // 缺目标 Java 时面板自己补齐（用户零操作）：下载期间推「正在准备 Java」进度，
          // 补齐失败会抛中文可操作错误，交给外层回滚（备份与旧 jar 都还在）
          const prepared = await ensureJavaRuntime(requiredJava, {
            mcVersion,
            signal: task.signal,
            onProgress: (percent) =>
              this._emitProgress(
                instanceId,
                UPGRADE_STAGES.PREPARE_JAVA,
                Math.round(percent * 100),
                `正在准备 Java ${requiredJava}...`,
              ),
          });
          logger.info(
            `[upgrade ${instanceId}] Java ${currentJava} 不满足 ${requiredJava}，已准备 ${prepared}`,
          );
          // 补齐后再走一次严格查找：本机 Java 集合可能在下载期间变化，且「落地成功」
          // 与「面板能选到」是两件事，选不到就仍按失败处理
          const replacement = findJavaPathStrict(requiredJava);
          if (!replacement) {
            // 找不到满足要求的 Java ⇒ 中止升级，交给外层回滚（备份与旧 jar 都还在）
            throw new AppError(
              ErrorCodes.VALIDATION_ERROR,
              `升级到 ${mcVersion} 需要 Java ${requiredJava}，本机未找到可用版本；` +
                `当前实例使用 ${currentJava || '(未设置)'}。请先安装 Java ${requiredJava} 再重试`,
            );
          }
          logger.info(
            `[upgrade ${instanceId}] Java ${currentJava} 不满足 ${requiredJava}，改为 ${replacement}`,
          );
          instance.javaPath = replacement;
          const { InstanceModel: Model } = await import('../db/index.js');
          Model.update(instanceId, { javaPath: replacement });
        }
      }
      task.throwIfCancelled();

      // 阶段 2.7：Forge 安装器。必须落在替换之前——它决定最终入口 jar 的文件名，
      // 而替换阶段要把这个文件名写进 DB 与内存实例。
      // 只换 jar 不跑安装器会得到一个起不来的实例：forge 上游给的是安装器，
      // 真入口 jar 与 libraries/ 依赖树都由这一步生成。
      if (isForge) {
        this._emitProgress(instanceId, UPGRADE_STAGES.FORGE_INSTALL, 0, '正在安装 Forge...');
        const launchJar = await this._runForgeInstaller(
          instance.javaPath,
          instance.serverPath,
          FORGE_INSTALLER_NAME,
          instanceId,
          mcVersion,
          task.signal,
        );
        finalJarName = launchJar;
        // 安装器自己不是启动产物，并且它叫 forge-* 会干扰下次升级的入口 jar 识别
        await fs.promises.unlink(downloadPath).catch(() => {});
        this._emitProgress(
          instanceId,
          UPGRADE_STAGES.FORGE_INSTALL,
          100,
          `Forge 安装完成（${launchJar}）`,
        );
        task.throwIfCancelled();
      }

      // 阶段 3：替换 JAR
      this._emitProgress(instanceId, UPGRADE_STAGES.REPLACE, 0, '正在替换 JAR...');
      // 备份旧 JAR（异步复制对齐同链路 IO 风格）。
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
      // 更新 DB：jarFile + mcVersion + 类型
      // 升级请求里的 type 是新 jar 的服务端类型，可能与原类型不同（Paper → Vanilla 这类
      // 转换）。类型不跟着写就会出现「面板标 Paper、磁盘装 Vanilla」——插件照装不加载，
      // 而界面没有任何异常。DB 的列沿用首字母大写的取值形态（部署写入即此形态）。
      const { InstanceModel } = await import('../db/index.js');
      InstanceModel.update(instanceId, {
        jarFile: finalJarName,
        mcVersion,
        modLoader: typeLabel(type),
      });
      instance.jarFile = finalJarName;
      instance.mcVersion = mcVersion;
      instance.modLoader = String(type || 'vanilla').toLowerCase();
      // 兜底文件同口径：DB 丢失后按 instance.json 恢复时，类型与版本必须与磁盘一致
      syncInstanceJson(instance);
      this._emitProgress(instanceId, UPGRADE_STAGES.REPLACE, 100, '替换完成');
      // 替换已落定但校验未开始的窗口：此处的取消必须走「替换后」的收尾（回滚），
      // 漏掉这一步会让取消被吞掉、最终以「升级失败」收场并触发一次世界恢复
      task.throwIfCancelled();

      // 阶段 4：首启校验
      // Fabric/Forge 首次启动不是「读到 jar 就完」：fabric 的 launcher jar 要先下载
      // 原版服务端并做 remap，forge 的 shim 要先经 ModLauncher 解出嵌套依赖。
      // 实测 fabric 冷启动从进程启动到 Done 共 116s（其中 Done 自身 24s），
      // 只用 120s 窗口会在正常路径上判超时并触发一次不必要的回滚。
      this._emitProgress(instanceId, UPGRADE_STAGES.VERIFY, 0, '正在启动验证...');
      await this._startAndVerify(instanceId, {
        signal: task.signal,
        timeoutMs: isForge || type === 'fabric' ? MODDED_VERIFY_WINDOW_MS : 120_000,
      });
      this._emitProgress(instanceId, UPGRADE_STAGES.COMPLETED, 100, '升级完成');

      // 清理：回滚源副本 + 被替换的旧版本 jar（升级成功后实例目录
      // 仅保留当前版本 jar，避免多次升级累积磁盘垃圾；失败/回滚路径不删，
      // 回滚源仍需可用。同路径守卫：路由层已拒同版本升级，直调服务层时
      // oldJarPath 可能与 newJarPath 相同，此时旧 jar 本体即新 jar，不可删）
      // Forge 的入口 jar 落在安装器产出的文件名上，newJarPath 那个位置没有文件
      fs.unlink(backupJarPath, () => {});
      if (
        oldJarPath !== newJarPath &&
        oldJarPath !== path.join(instance.serverPath, finalJarName)
      ) {
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
          await this._doRollback(instanceId, backupJarPath, oldJarFile);
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
          await this._doRollback(instanceId, backupJarPath, oldJarFile);
          // 回滚后尝试恢复备份。恢复失败不阻塞主流程，但绝不能静默：
          // 此时磁盘上的世界仍是「新版本首启失败」后的状态，与「已回滚」相反
          if (backupId) {
            try {
              await this.backupService.restoreBackup(backupId);
            } catch (restoreErr) {
              restoreFailure = restoreErr.message;
              logger.error(
                `[UpgradeService] 备份恢复失败（${backupId}），世界未回滚到升级前状态:`,
                restoreErr.message,
              );
            }
          }
        } else {
          // 替换前的取消：jarFile/DB/磁盘旧 jar 都没动过，回滚无事可做——只清理本次
          // 升级的磁盘产物：旧 jar 副本（含复制中途留下的 .part）与刚下载的产物。
          // 下载产物必须删：取消后实例目录里留着新版本 jar 既是垃圾，也与「实例保持旧版本」
          // 的终态文案不符（同路径守卫：旧 jar 本体即新 jar 时不可删）
          await fs.promises.unlink(backupJarPath).catch(() => {});
          await fs.promises.unlink(`${backupJarPath}.part`).catch(() => {});
          if (newJarPath !== oldJarPath) {
            await fs.promises.unlink(newJarPath).catch(() => {});
          }
          // 已生成的 libraries/ 刻意不动：安装器写的是与其他版本共享的依赖树，
          // 删它会把「实例保持旧版本」变成「旧版本也起不来」
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
        cancelled
          ? cancelDetail
          : restoreFailure
            ? `升级失败，回滚未完成：世界备份恢复失败（${restoreFailure}），请用备份 ${backupId} 手动恢复`
            : `升级失败并已回滚: ${err.message}`,
      );
      this._activeUpgrades.delete(instanceId);
      // 取消不是故障：终态已按 cancelled 发出，正常返回而不是抛错——抛出会让
      // 路由层的 catch 把它记成「Upgrade failed」错误日志（用户动作被写成故障）
      if (cancelled) return;
      throw err;
    } finally {
      // 成功/失败/取消都要注销：残留条目会让取消端点对着已结束的任务回「已取消」
      task.finish();
      // Forge 安装器不是启动产物，任何终态都不该留在实例目录里：它叫 forge-*，
      // 留着会成为下次升级认领入口 jar 时的噪声候选。成功路径已在安装阶段删过，
      // 这里是失败/取消路径的收口（删除失败不影响终态）
      if (isForge) {
        await fs.promises.unlink(downloadPath).catch(() => {});
      }
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
