import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { httpJson, httpStream } from '../utils/http-client.js';
import { MinecraftServerManager, NodeAdapter } from 'minecraft-core';
import config from '../config.js';
import { success, error, ErrorCodes } from '../utils/response.js';
import { getRecommendedJavaVersion, findJavaPath } from '../utils/java-detector.js';
import { InstanceModel } from '../db/index.js';
import { atomicWriteFile } from '../services/mc_server.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import {
  deployRequestSchema,
  deployCancelRequestSchema,
  deployCancelResponseSchema,
  deployStatusResponseSchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  JAR_DOWNLOAD_MAX_BYTES,
  JAR_HASH_ALGORITHMS,
  assertDownloadIntegrity,
  assertSizeWithinLimit,
} from '../utils/jar-download-guard.js';
import { assertAllowedDownloadHost, allowedDownloadHosts } from '../utils/jar-download-guard.js';
import { logger } from '../utils/logger.js';
import { getServerVersion } from '../utils/version.js';
import { isDeployInFlight, latestInFlightDeploy } from '../utils/deploy-inflight.js';
import { generateInstanceId } from '../utils/instance-id.js';
import { killProcessTree } from '../utils/process-tree.js';
import {
  beginCancellableTask,
  cancelTask,
  TASK_KINDS,
  TaskCancelledError,
} from '../utils/cancellable-task.js';

const mcCoreManager = new MinecraftServerManager(new NodeAdapter());

const PAPER_API_BASE = 'https://fill.papermc.io/v3';
// 版本号单一来源：package.json（见 utils/version.js）
const PAPER_USER_AGENT = `MC_Commander/${getServerVersion()} (https://github.com/wyyfzb/mc-commander)`;

async function getPaperVersions() {
  const data = await httpJson(`${PAPER_API_BASE}/projects/paper`, {
    headers: { 'User-Agent': PAPER_USER_AGENT },
    timeoutMs: 15000,
    retryLimit: 2,
  });
  // v3 响应格式：{ project: 'paper', versions: { '1.21': ['1.21.4', '1.21.3', ...], '1.20': [...], ... } }
  // versions 是对象，键是版本组，值是该组下的具体版本号数组
  const versionsObj = data.versions;
  let flatVersions = [];
  if (versionsObj && typeof versionsObj === 'object' && !Array.isArray(versionsObj)) {
    // 展开所有版本组为扁平数组
    for (const groupVersions of Object.values(versionsObj)) {
      if (Array.isArray(groupVersions)) {
        flatVersions.push(...groupVersions);
      }
    }
  } else if (Array.isArray(versionsObj)) {
    flatVersions = versionsObj;
  }
  // 过滤掉 rc/snapshot 等预发布版本，只保留正式版本（不含 '-'）
  const releases = flatVersions.filter((v) => !v.includes('-'));
  return releases.slice(0, 30);
}

async function getPaperBuild(mcVersion) {
  const data = await httpJson(`${PAPER_API_BASE}/projects/paper/versions/${mcVersion}/builds`, {
    headers: { 'User-Agent': PAPER_USER_AGENT },
    timeoutMs: 15000,
    retryLimit: 2,
  });
  // v3 响应直接是构建数组（非 {builds: [...]} 结构）
  const builds = Array.isArray(data) ? data : data.builds || [];
  const stable = builds.filter((b) => b.channel === 'STABLE' || b.channel === 'RECOMMENDED');
  const candidates = stable.length > 0 ? stable : builds;
  if (candidates.length === 0) return null;
  // 按 id 降序取最新（v3 用 id 字段，非 build）
  const latest = candidates.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  return latest;
}

async function getPaperDownload(mcVersion) {
  const build = await getPaperBuild(mcVersion);
  if (!build) throw new Error(`No Paper build found for ${mcVersion}`);
  const downloads = build.downloads || {};
  const downloadInfo = downloads['server:default'] || downloads.application;
  if (!downloadInfo?.url) {
    throw new Error(`No Paper build download for ${mcVersion} (build ${build.id})`);
  }
  // 摘要位置是 downloadInfo.checksums.sha256（v3 无顶层 sha256 字段）
  const digest = downloadInfo.checksums?.sha256;
  const expectedHash = digest ? { algorithm: 'sha256', digest } : null;
  return { url: downloadInfo.url, expectedHash };
}

/**
 * 部署进度发射 + 进行中注册表同步（单一出口）：
 * - 事件 payload 附带实例归属（instanceId/instanceName 等），前端据此在刷新后
 *   恢复「部署中」显示（部署实例未入库，订阅过滤不适用，走全局广播）
 * - 注册表（serverManager.activeDeploys）供 websocket 连接建立时补发，
 *   仅承载进行中阶段：终态（complete/error）只推送不写回——否则 WS 连接
 *   建立时会对已结束的部署重复补发历史终态，且注册表随部署次数累积残留
 * - 注册表同时是 GET /instances/deploy/status 的进度兜底数据源（WS 断线时
 *   前端仍能查询服务端真值），故每阶段快照需自包含（含字节数与写入时刻）；
 *   读取判据统一走 utils/deploy-inflight.js（含死快照时限）
 * @param {{ instanceId: string, instanceName: string, type: string, mcVersion: string }|null} meta
 */
const TERMINAL_DEPLOY_STAGES = new Set(['complete', 'error', 'cancelled']);

function trackDeployProgress(serverManager, meta, payload) {
  if (meta) {
    if (!TERMINAL_DEPLOY_STAGES.has(payload.stage)) {
      serverManager.activeDeploys?.set(meta.instanceId, {
        ...meta,
        stage: payload.stage,
        percent: payload.percent,
        transferred: payload.transferred,
        total: payload.total,
        updatedAt: Date.now(),
      });
    }
    serverManager.emit('deployProgress', { ...payload, ...meta });
  } else {
    serverManager.emit('deployProgress', payload);
  }
}

/**
 * 删除下载半成品：失败不抛。清理动作不该顶掉失败回执——取消路径是在
 * `controller.abort()` 内同步执行的，抛出会穿透到取消端点变成 500；
 * 事件回调里抛出更是未捕获异常。残留半成品由部署失败路径的整目录清理兜底。
 */
function removePartialFile(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    /* 不存在或仍被占用，交由整目录清理兜底 */
  }
}

async function downloadWithProgress(
  url,
  destPath,
  serverManager,
  stage = 'download',
  { expectedHash = null, maxBytes = JAR_DOWNLOAD_MAX_BYTES, deployMeta = null, signal = null } = {},
) {
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

    // 取消（用户中断部署）与自身失败共用同一收尾：清理半成品 + 断流 + reject
    const detach = () => signal?.removeEventListener('abort', onCancel);
    const onCancel = () => abort(new TaskCancelledError());
    let aborted = false;

    /** 中止：清理半成品 + 断流 + reject（promise 已 settle 时 reject 为 no-op） */
    const abort = (err) => {
      if (aborted) return;
      aborted = true;
      detach();
      removePartialFile(destPath);
      stream.destroy();
      file.destroy();
      reject(err);
    };

    signal?.addEventListener('abort', onCancel, { once: true });

    // 下载进度节流：httpStream 的 downloadProgress 每个 chunk 触发（大 jar 每秒可达多次），
    // 全部广播会对所有在线客户端高频轰炸。节流：百分比变化 ≥1% 才发射
    let lastPct = -1;
    stream.on('downloadProgress', ({ percent, transferred, total }) => {
      // 体积上限断言在前：超限即刻断流清理，不等下载自然结束
      try {
        assertSizeWithinLimit(transferred, maxBytes);
      } catch (err) {
        abort(err);
        return;
      }
      // 直接采信客户端的 percent：httpStream 恒按 transferred/total 折算（total 未知时为 0）。
      // 不在此处就地重算——同一公式两处实现必然漂移
      const pct = percent;
      if (pct - lastPct < 0.01) return;
      lastPct = pct;
      trackDeployProgress(serverManager, deployMeta, {
        stage,
        percent: pct,
        transferred,
        total,
      });
    });

    stream.pipe(file);

    file.on('finish', () => {
      // close 回调确保 fd 落盘后才校验摘要（issue 316：fail-closed）
      file.close(() => {
        if (aborted) return;
        assertDownloadIntegrity(destPath, expectedHash)
          .then(() => {
            // 摘要校验期间被取消：abort 已清理半成品并 reject，此处不得再报「下载完成」
            if (aborted) return;
            detach();
            trackDeployProgress(serverManager, deployMeta, {
              stage: 'download_complete',
              percent: 1.0,
              transferred: 0,
              total: 0,
            });
            resolve(destPath);
          })
          .catch((err) => {
            if (aborted) return;
            detach();
            // 校验失败：弃已下载部分（清理残留）并抛含期望/实际摘要的可读错误
            removePartialFile(destPath);
            reject(err);
          });
      });
    });

    stream.on('error', (err) => {
      if (aborted) return;
      detach();
      file.close();
      removePartialFile(destPath);
      reject(err);
    });

    file.on('error', (err) => {
      if (aborted) return;
      detach();
      stream.destroy();
      removePartialFile(destPath);
      reject(err);
    });
  });
}

function generateServerProperties(instanceId, _mcVersion) {
  // 生成随机 RCON 密码（16 位十六进制），确保 RCON 默认可用
  // RCON 是 MC Commander 获取玩家坐标/血量、世界时间等数据的核心通道
  const rconPassword = crypto.randomBytes(8).toString('hex');
  return `# Minecraft server properties
# Generated by MC_Commander
enable-jmx-monitoring=false
rcon.port=${25575 + (parseInt(instanceId.slice(-4), 16) % 100)}
level-seed=
gamemode=survival
enable-command-block=false
enable-query=false
generator-settings=
enforce-secure-profile=true
level-name=world
motd=A Minecraft Server managed by MC_Commander
query.port=25565
pvp=true
generate-structures=true
max-chained-neighbor-updates=1000000
difficulty=easy
network-compression-threshold=256
max-tick-time=60000
require-resource-pack=false
use-native-transport=true
max-players=20
online-mode=true
enable-status=true
allow-flight=false
initial-disabled-packs=
broadcast-rcon-to-ops=true
view-distance=10
server-ip=
resource-pack-prompt=
allow-nether=true
server-port=${25565 + (parseInt(instanceId.slice(-4), 16) % 100)}
enable-rcon=true
sync-chunk-writes=true
op-permission-level=4
prevent-proxy-connections=false
hide-online-players=false
resource-pack=
entity-broadcast-range-percentage=100
simulation-distance=10
rcon.password=${rconPassword}
player-idle-timeout=0
force-gamemode=false
rate-limit=0
hardcore=false
white-list=false
broadcast-console-to-ops=true
spawn-npcs=true
spawn-animals=true
function-permission-level=2
initial-enabled-packs=vanilla
texture-pack=
spawn-monsters=true
enforce-whitelist=false
spawn-protection=16
resource-pack-sha1=
max-world-size=29999984
`;
}

/**
 * 首启生成世界与配置（60s 上限）。
 * 取消（用户中断部署）与超时不共用回声：超时按「配置可能已生成」放行（首启只求
 * 生成配置，失败不阻塞部署），取消则必须以错误结束整个部署。
 * @param {{ signal?: AbortSignal|null }} [opts]
 */
async function runFirstLaunch(instancePath, javaPath, jarFile, maxMemory, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const logsDir = path.join(instancePath, 'logs');
    if (fs.existsSync(logsDir)) {
      return resolve();
    }

    const args = [`-Xmx${maxMemory}`, `-Xms${maxMemory}`, '-jar', jarFile, 'nogui'];

    const proc = spawn(javaPath, args, {
      cwd: instancePath,
      // 不用 spawn 的 timeout 选项：Node 内部超时仅杀主进程（Windows 上
      // TerminateProcess），且其内部定时器先于自定义定时器触发——根进程先死
      // 反而让后来者无法递归定位整棵树。超时与取消统一由下方自定义定时器
      // 走 killProcessTree（见 utils/process-tree.js）。
      // Linux/macOS：以独立进程组启动（pid 即 PGID），终止时按进程组处理；
      // Windows 不设 detached（无进程组信号概念），进程树由 taskkill /T 终止。
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    let output = '';
    proc.stdout.on('data', (data) => (output += data.toString()));
    proc.stderr.on('data', (data) => (output += data.toString()));

    // 超时与取消可能同时到达（取消恰好落在 60s 边界）：单次落定，先到者胜
    let settled = false;
    function settle(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onCancel);
      if (err) reject(err);
      else resolve();
    }

    const timeout = setTimeout(() => {
      // 进程树终止：MC 1.18+/26.x 的 server.jar 会派生真正运行的 JVM，
      // 只杀主进程会留下孤儿继续占端口/写世界数据（见 utils/process-tree.js）
      killProcessTree(proc, { detached: true });
      logger.warn('First launch timed out (60s), but config may have been generated');
      settle();
    }, 60000);

    // 取消（用户中断部署）：与超时同样是进程树终止，但以取消错误结束——超时按
    // 「配置可能已生成」放行，取消必须打断整个部署（不能留下半成品实例）
    const onCancel = () => {
      killProcessTree(proc, { detached: true });
      settle(new TaskCancelledError());
    };
    signal?.addEventListener('abort', onCancel, { once: true });

    proc.on('exit', (code) => {
      if (settled) return;
      if (fs.existsSync(logsDir) || code === 0) {
        settle();
      } else {
        logger.warn(`First launch exited with code ${code}. Output: ${output.substring(0, 500)}`);
        settle();
      }
    });

    proc.on('error', (err) => {
      logger.warn('First launch error:', err.message);
      settle();
    });
  });
}

export function createServerJarRoutes(serverManager) {
  const router = express.Router();

  // 上游版本源不可达属可预期失败：catch 统一降级 502（非 500），asyncHandler 作逃逸兜底
  router.get(
    '/versions',
    asyncHandler(async (req, res) => {
      const type = (req.query.type || 'vanilla').toLowerCase();
      try {
        if (type === 'paper') {
          const versions = await getPaperVersions();
          return res.json(success({ type: 'paper', versions }));
        }

        if (type === 'vanilla') {
          // Vanilla 使用 Mojang 官方 manifest 并过滤 release 版本（minecraft-core 返回包含 snapshot）
          const manifest = await httpJson(
            'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
            {
              timeoutMs: 15000,
              retryLimit: 2,
            },
          );
          const releases = manifest.versions
            .filter((v) => v.type === 'release')
            .slice(0, 30)
            .map((v) => v.id);
          return res.json(success({ type: 'vanilla', versions: releases }));
        }

        if (type === 'fabric') {
          const rawVersions = await mcCoreManager.getVersions('fabric');
          const versions = Array.isArray(rawVersions)
            ? rawVersions
            : rawVersions.versions || Object.keys(rawVersions);
          let loaders = [];
          try {
            const loaderData = await httpJson('https://meta.fabricmc.net/v2/versions/loader', {
              timeoutMs: 15000,
              retryLimit: 2,
            });
            loaders = loaderData
              .filter((v) => v.stable)
              .map((v) => v.version)
              .slice(0, 10);
          } catch {}
          return res.json(success({ type: 'fabric', versions: versions.slice(0, 30), loaders }));
        }

        if (type === 'forge') {
          const promotions = await httpJson(
            'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
            {
              timeoutMs: 15000,
              retryLimit: 2,
            },
          );
          const versions = [
            ...new Set(
              Object.keys(promotions.promos || {}).map((v) =>
                v.replace(/-(latest|recommended)$/, ''),
              ),
            ),
          ]
            .filter((v) => v.startsWith('1.'))
            .reverse()
            .slice(0, 30);
          return res.json(success({ type: 'forge', versions }));
        }

        const rawVersions = await mcCoreManager.getVersions(type);
        const versions = Array.isArray(rawVersions)
          ? rawVersions
          : rawVersions.versions || Object.keys(rawVersions);
        return res.json(success({ type, versions: versions.slice(0, 30) }));
      } catch (e) {
        logger.error(`Failed to fetch ${type} versions:`, e.message);
        return res
          .status(502)
          .json(error(ErrorCodes.SERVER_ERROR, `Failed to fetch versions: ${e.message}`));
      }
    }),
  );

  // 部署进度兜底查询（WS 断线/刷新页面时前端仍能取到服务端真值并恢复「部署中」，
  // 据此禁止重复发起部署）。无部署 / 已终态 / 快照超时一律返回空态 { deploying: false }，
  // 不用 404（调用方是恢复逻辑，空态才是正常语义）
  router.get('/instances/deploy/status', (req, res) => {
    const snapshot = latestInFlightDeploy(serverManager);
    if (!snapshot) {
      return res.json(validatedSuccess(deployStatusResponseSchema, { deploying: false }));
    }
    return res.json(
      validatedSuccess(deployStatusResponseSchema, {
        deploying: true,
        instanceId: snapshot.instanceId,
        instanceName: snapshot.instanceName,
        type: snapshot.type,
        mcVersion: snapshot.mcVersion,
        stage: snapshot.stage,
        percent: snapshot.percent,
        transferred: snapshot.transferred ?? 0,
        total: snapshot.total ?? 0,
        updatedAt: snapshot.updatedAt,
      }),
    );
  });

  // 部署实例（请求体 schema parse 校验：type 枚举/必填字段由 deployRequestSchema 单源定义）
  // 失败路径（下载/写盘/磁盘清理）catch 统一降级 502 并清理，asyncHandler 作逃逸兜底
  router.post(
    '/instances/deploy',
    validateBody(deployRequestSchema),
    asyncHandler(async (req, res) => {
      const { type, mcVersion, instanceName, maxMemory, loaderVersion, eula } = req.body;

      // 重复部署门控（路由层纵深防御）：页面残留的「部署中」进度、重连补发或断线期间的
      // 兜底查询都可能让客户端误判服务端空闲；此处以服务端注册表为准拒绝并发部署
      if (isDeployInFlight(serverManager)) {
        return res
          .status(409)
          .json(error(ErrorCodes.DEPLOY_IN_PROGRESS, 'A deployment is already in progress'));
      }

      // EULA 只由用户显式同意决定：面板不得代替用户表达同意（未同意同样可完成部署，仅不写 true、不自动首启）
      const eulaAgreed = eula === true;

      const instanceId = generateInstanceId(type);
      const instancePath = path.join(config.serversDir, instanceId);

      // 部署归属元数据：进度事件 payload 与进行中注册表共用（展示名与
      // instanceConfig.name 同一口径，含默认名规则）
      const deployMeta = {
        instanceId,
        instanceName: instanceName || `${type.charAt(0).toUpperCase() + type.slice(1)} Server`,
        type: type.toLowerCase(),
        mcVersion,
      };

      const isForge = type.toLowerCase() === 'forge';
      const downloadJarName = isForge ? 'forge-installer.jar' : 'server.jar';
      const jarPath = path.join(instancePath, downloadJarName);

      // 可取消登记：取消端点据注册表定位本次部署。登记必须先于第一个 await——
      // 上游版本查询可能耗时数秒，此窗口内的取消请求同样要被受理
      const task = beginCancellableTask(TASK_KINDS.DEPLOY, instanceId);
      // 首启前才写 DB，但写入后仍可能被取消（首启最长 60s）：清理必须一并回滚这一行，
      // 否则留下指向已删除目录的幽灵实例
      let instanceCreatedInDb = false;

      try {
        // 必须在 try 内：mkdirSync 抛错（ENOTDIR/EACCES/EPERM）时由 catch 统一返回 502 并清理，
        // 否则裸 async handler 的 rejection 不被 Express 4 捕获 → 请求挂起 + unhandledRejection
        fs.mkdirSync(instancePath, { recursive: true });
        logger.info(`Deploying ${type} ${mcVersion} as ${instanceId}...`);
        // 部署起始即入注册表（连接补发的最早可见点：下载阶段首事件前）
        trackDeployProgress(serverManager, deployMeta, {
          stage: 'download',
          percent: 0,
          transferred: 0,
          total: 0,
        });

        // 审计「受理」语义（与 INSTANCE_DELETE 对偶，回查实例何时被谁创建）：
        // schema 校验通过 + 实例目录已建 + 部署流程正式启动即记录，不等终态。
        // 终态（成功/失败/被取消）不另记一条、也不回滚本条：它记的是「谁在何时发起过
        // 这次部署」——失败与取消的可见性由进度事件（进度面板 + 通知）承担；
        // 代价是失败/取消会留下一条指向已清理目录的受理记录，属既定契约
        // （见 __tests__/server-jar.deploy.audit.test.js）
        recordAudit({
          instanceId,
          action: AuditActions.INSTANCE_CREATE,
          targetType: 'instance',
          targetId: instanceId,
          detail: { instanceName: deployMeta.instanceName, mcVersion, type: deployMeta.type },
        });

        let downloadUrl;
        let expectedHash = null; // 上游摘要（issue 316）：有则强校验，无则仅限流
        if (type.toLowerCase() === 'paper') {
          ({ url: downloadUrl, expectedHash } = await getPaperDownload(mcVersion));
        } else {
          try {
            const build = await mcCoreManager.getLatestBuild(type.toLowerCase(), mcVersion);
            // 真实形状：minecraft-core 的 UnifiedBuild 只有 downloads.application 一层
            // （实测 vanilla=sha1 / purpur=md5 / mohist=sha256，fabric 与 forge 无 hash）。
            // 下面对顶层 url/downloadUrl/sha256/sha1 的取值**纯属防御**：这些字段在
            // UnifiedBuild 里并不存在，读它们的旧代码会让 expectedHash 恒 null、
            // 静默跳过完整性校验（issue #545）。
            const artifact = build?.downloads?.application;
            if (artifact?.url) {
              downloadUrl = artifact.url;
            } else if (build && build.url) {
              downloadUrl = build.url;
            } else if (build && build.downloadUrl) {
              downloadUrl = build.downloadUrl;
            } else {
              // 由依赖包自行下载并落盘。此路下**面板侧的体积上限与下载域白名单都不生效**，
              // 完整性校验也交给包内实现（它对 binary 产物会比对 artifact.hash 并在不匹配时
              // 删除文件）。域白名单只在 URL 经过本文件时才有机会断言——库内自取的那一步
              // 面板看不见，这是该防线的已知边界。
              const downloadInfo = await mcCoreManager.downloadServer({
                core: type.toLowerCase(),
                version: mcVersion,
                outputDir: instancePath,
              });
              if (downloadInfo && (downloadInfo.path || downloadInfo.filePath)) {
                downloadUrl = null;
              } else if (downloadInfo && downloadInfo.url) {
                downloadUrl = downloadInfo.url;
              }
            }
            const buildHash = artifact?.hash || build?.sha256 || build?.sha1;
            // hashType 决定算法：认不出就整体放弃校验（宁可跳过，也不能拿 md5 当 sha256 比，
            // 那会把正常下载误判成损坏并对用户报 502）
            const hashType =
              artifact?.hashType || (build?.sha256 ? 'sha256' : build?.sha1 ? 'sha1' : null);
            if (downloadUrl && buildHash && JAR_HASH_ALGORITHMS.has(hashType)) {
              expectedHash = { algorithm: hashType, digest: String(buildHash) };
            }
          } catch (mcErr) {
            logger.error(`minecraft-core failed for ${type}:`, mcErr.message);
            if (type.toLowerCase() === 'fabric') {
              const loader = loaderVersion || '0.16.10';
              downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader}/1.0.1/server/jar`;
            } else if (type.toLowerCase() === 'purpur') {
              downloadUrl = `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`;
            } else {
              throw mcErr;
            }
          }
        }

        // 版本查询是第一个 await 边界：取消落在下载开始前时这里就要拦住，
        // 否则会先下一段 jar 再发现已被取消
        task.throwIfCancelled();

        if (downloadUrl) {
          // 下载 URL 全部来自上游响应（minecraft-core 的 UnifiedBuild、paper v3、
          // 以及本文件的 fabric/purpur 兜底），上游被污染即可指向任意主机。升级路径
          // 一直有此断言，部署路径此前缺——同一个入参面不该只有一条路守。
          assertAllowedDownloadHost(downloadUrl, allowedDownloadHosts([type.toLowerCase()]));
          logger.info(`Download URL: ${downloadUrl}`);
          await downloadWithProgress(downloadUrl, jarPath, serverManager, 'download', {
            expectedHash,
            deployMeta,
            signal: task.signal,
          });
        } else {
          const downloadedFile = fs.readdirSync(instancePath).find((f) => f.endsWith('.jar'));
          if (downloadedFile && downloadedFile !== downloadJarName) {
            fs.renameSync(path.join(instancePath, downloadedFile), jarPath);
          }
        }

        const ramSize = maxMemory || '2G';
        const javaVersion = getRecommendedJavaVersion(mcVersion);
        const javaPath = findJavaPath(javaVersion);

        let jarFile = 'server.jar';

        if (isForge) {
          logger.info('Forge detected, extracting server files...');
          trackDeployProgress(serverManager, deployMeta, {
            stage: 'forge_install',
            percent: 0,
            transferred: 0,
            total: 0,
          });
          const extractArgs = ['-Xmx512M', '-jar', downloadJarName, '--installServer'];
          const extractProc = spawn(javaPath, extractArgs, { cwd: instancePath });
          await new Promise((resolve, reject) => {
            // 超时与取消单次落定：取消（abort）先到则 exit 事件的 resolve 已是空操作
            let settled = false;
            function settle(err) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              task.signal.removeEventListener('abort', onCancel);
              if (err) reject(err);
              else resolve();
            }
            const timer = setTimeout(() => {
              killProcessTree(extractProc);
              settle(new Error('Forge installer timed out (120s)'));
            }, 120000);
            // Forge 安装器是单进程 java 程序（未 detached），故不做进程组终止
            const onCancel = () => {
              killProcessTree(extractProc);
              settle(new TaskCancelledError());
            };
            task.signal.addEventListener('abort', onCancel, { once: true });
            extractProc.on('exit', (code) => {
              if (settled) return;
              if (code !== 0) logger.warn(`Forge installer exited with code ${code}`);
              settle();
            });
            extractProc.on('error', (err) => {
              settle(err);
            });
          });

          const forgeJar = fs
            .readdirSync(instancePath)
            .find((f) => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('installer'));
          if (forgeJar) {
            jarFile = forgeJar;
          } else {
            throw new Error('Forge server jar not found after install');
          }
          fs.unlinkSync(jarPath);
        }

        // 写盘与入库之前再判一次：Forge 安装阶段被取消时不该留下 instance.json/DB 行
        task.throwIfCancelled();

        const instanceConfig = {
          id: instanceId,
          name: deployMeta.instanceName,
          type: type.toLowerCase(),
          jarFile,
          maxMemory: ramSize,
          minMemory: Math.max(Math.floor(ramSize.replace('G', '')) / 2, 1) + 'G',
          mcVersion,
          loaderVersion: loaderVersion || undefined,
          javaVersion,
          javaPath,
        };

        atomicWriteFile(
          path.join(instancePath, 'instance.json'),
          JSON.stringify(instanceConfig, null, 2),
        );
        fs.writeFileSync(
          path.join(instancePath, 'eula.txt'),
          eulaAgreed ? 'eula=true\n' : 'eula=false\n',
        );
        fs.writeFileSync(
          path.join(instancePath, 'server.properties'),
          generateServerProperties(instanceId, mcVersion),
        );

        try {
          InstanceModel.create({
            id: instanceId,
            name: instanceConfig.name,
            type: type.toLowerCase(),
            jarFile,
            javaPath,
            maxMemory: ramSize,
            minMemory: instanceConfig.minMemory,
            serverPath: instancePath,
            mcVersion,
            port: 25565 + (parseInt(instanceId.slice(-4), 16) % 100),
          });
          logger.info(`Instance ${instanceId} written to DB`);
          instanceCreatedInDb = true;
        } catch (dbErr) {
          logger.warn(`Failed to write instance to DB:`, dbErr.message);
        }

        // 首启用于生成世界与校验 jar，而 MC 首启强制要求 eula=true；
        // 未同意时跳过，待用户在实例上确认 EULA 后首次启动自然完成，避免写入未获同意的 eula=true
        if (eulaAgreed) {
          trackDeployProgress(serverManager, deployMeta, {
            stage: 'first_launch',
            percent: 0,
            transferred: 0,
            total: 0,
          });
          try {
            logger.info('Running first launch to generate config...');
            await runFirstLaunch(instancePath, javaPath, jarFile, ramSize, { signal: task.signal });
            logger.info('First launch completed');
          } catch (e) {
            // 首启失败可以放行（配置多半已生成），但取消必须打断整个部署：
            // 否则「取消」会走到下面的 complete 分支，用户看到的是部署成功
            if (e.cancelled) throw e;
            logger.warn('First launch failed (may require manual setup):', e.message);
          }
        }

        serverManager.loadInstances();

        // 终态：先移除注册表（补发只针对进行中），payload 仍携带归属供通知文案
        serverManager.activeDeploys?.delete(instanceId);
        trackDeployProgress(serverManager, deployMeta, {
          stage: 'complete',
          percent: 1.0,
          transferred: 0,
          total: 0,
        });
        logger.info(`Instance ${instanceId} deployed successfully`);

        res.json(
          success(
            {
              id: instanceId,
              name: instanceConfig.name,
              type: type.toLowerCase(),
              mcVersion,
              javaVersion,
              path: instancePath,
              maxMemory: ramSize,
            },
            'Instance deployed successfully',
          ),
        );
      } catch (e) {
        // 取消与执行失败共用同一清理（磁盘目录 + 注册表 + DB 行），只在终态事件与
        // HTTP 回声上分叉——用户取消不是故障，报 error 会让通知中心与审计页失真
        const cancelled = e?.cancelled === true;
        // 收尾失败（Windows 上目录被进程占用——如孤儿 JVM 仍在写文件——或权限不足时
        // rmSync 抛 EPERM/EBUSY；DB 行删除同理）必须兜住：异常从 catch 逃逸会变成
        // async rejection，Express 4 不捕获 → 请求挂起 + unhandledRejection 崩溃。
        // 但也不能吞掉：取消的终态会向用户声称「已清理」，收尾没做成时必须据实回报
        const cleanupProblems = [];
        try {
          fs.rmSync(instancePath, { recursive: true, force: true });
        } catch (cleanupErr) {
          cleanupProblems.push(`实例目录未能删除（${cleanupErr.message}）`);
          logger.warn('Failed to clean up instance dir after failed deploy:', cleanupErr.message);
        }
        // 首启前已入库的行必须回滚（取消可落在首启窗口内）：否则留下指向已删目录的
        // 幽灵实例，列表里可见、点进去全是 404
        if (instanceCreatedInDb) {
          try {
            InstanceModel.delete(instanceId);
          } catch (delErr) {
            cleanupProblems.push(`实例记录未能移除（${delErr.message}）`);
            logger.warn(
              `Failed to remove DB row after ${cancelled ? 'cancelled' : 'failed'} deploy:`,
              delErr.message,
            );
          }
        }
        serverManager.activeDeploys?.delete(instanceId);
        if (cancelled) {
          trackDeployProgress(serverManager, deployMeta, {
            stage: 'cancelled',
            percent: 0,
            transferred: 0,
            total: 0,
            ...(cleanupProblems.length ? { error: cleanupProblems.join('；') } : {}),
          });
          logger.info(`Instance ${instanceId} deployment cancelled by user`);
          // 收尾明细同时放进响应 details：WS 断线时前端只能靠这次回声，缺了它会
          // 把「收尾未完成」显示成「已清理」（文案谎报既成事实）
          return res
            .status(ErrorCodes.TASK_CANCELLED.status)
            .json(
              error(
                ErrorCodes.TASK_CANCELLED,
                undefined,
                cleanupProblems.length ? { cleanup: cleanupProblems.join('；') } : null,
              ),
            );
        }
        trackDeployProgress(serverManager, deployMeta, {
          stage: 'error',
          percent: 0,
          transferred: 0,
          total: 0,
          error: e.message,
        });
        logger.error(`Failed to deploy ${type} ${mcVersion}:`, e.message);
        return res
          .status(502)
          .json(error(ErrorCodes.SERVER_ERROR, `Deployment failed: ${e.message}`));
      } finally {
        // 成功/失败/取消都要注销：残留条目会让取消端点对着已结束的任务回「已取消」
        task.finish();
      }
    }),
  );

  /**
   * 取消在途部署（用户中断）：中断下载/Forge 安装/首启，并清理未完成的实例目录。
   * 归属校验用 body 的 instanceId：部署实例在完成前未入库，注册表是唯一可信来源，
   * 且必须**按 id 精确匹配**——若改成「取消当前在途的那一个」，一个滞后一个部署
   * 周期的取消请求会误杀随后发起的新部署。
   * 响应只表示「已受理中断」：实际收尾（清理磁盘、发 cancelled 终态事件）由部署
   * 自身的失败路径继续完成，客户端据终态事件判定结果。
   */
  router.post('/instances/deploy/cancel', validateBody(deployCancelRequestSchema), (req, res) => {
    const { instanceId } = req.body;
    if (!cancelTask(TASK_KINDS.DEPLOY, instanceId)) {
      return res
        .status(ErrorCodes.DEPLOY_NOT_IN_FLIGHT.status)
        .json(
          error(
            ErrorCodes.DEPLOY_NOT_IN_FLIGHT,
            `No deployment in progress for instance ${instanceId}`,
          ),
        );
    }
    logger.info(`Deployment ${instanceId} cancellation requested`);
    return res.json(validatedSuccess(deployCancelResponseSchema, { instanceId, cancelled: true }));
  });

  return router;
}
