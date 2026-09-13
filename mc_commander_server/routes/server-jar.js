import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import got from 'got';
import { MinecraftServerManager, NodeAdapter } from 'minecraft-core';
import config from '../config.js';
import { success, error, ErrorCodes } from '../utils/response.js';
import { getRecommendedJavaVersion, findJavaPath } from '../utils/java-detector.js';
import { InstanceModel } from '../db/index.js';
import { atomicWriteFile } from '../services/mc_server.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { deployRequestSchema } from '@mc-commander/schemas';
import { validateBody } from '../middleware/validate.js';
import {
  JAR_DOWNLOAD_MAX_BYTES,
  assertDownloadIntegrity,
  assertSizeWithinLimit,
} from '../utils/jar-download-guard.js';
import { logger } from '../utils/logger.js';
import { getServerVersion } from '../utils/version.js';

const mcCoreManager = new MinecraftServerManager(new NodeAdapter());

const PAPER_API_BASE = 'https://api.papermc.io/v3';
// 版本号单一来源：package.json（见 utils/version.js）
const PAPER_USER_AGENT = `MC_Commander/${getServerVersion()} (https://github.com/wyyfzb/mc-commander)`;

async function getPaperVersions() {
  const data = await got(`${PAPER_API_BASE}/projects/paper`, {
    headers: { 'User-Agent': PAPER_USER_AGENT },
    timeout: { request: 15000 },
    retry: { limit: 2 }
  }).json();
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
  const releases = flatVersions.filter(v => !v.includes('-'));
  return releases.slice(0, 30);
}

async function getPaperBuild(mcVersion) {
  const data = await got(`${PAPER_API_BASE}/projects/paper/versions/${mcVersion}/builds`, {
    headers: { 'User-Agent': PAPER_USER_AGENT },
    timeout: { request: 15000 },
    retry: { limit: 2 }
  }).json();
  // v3 响应直接是构建数组（非 {builds: [...]} 结构）
  const builds = Array.isArray(data) ? data : (data.builds || []);
  const stable = builds.filter(b => b.channel === 'STABLE' || b.channel === 'RECOMMENDED');
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
  if (downloadInfo && downloadInfo.url) {
    const expectedHash = downloadInfo.sha256
      ? { algorithm: 'sha256', digest: downloadInfo.sha256 }
      : null;
    return { url: downloadInfo.url, expectedHash };
  }
  // 回退到 v2 URL 格式（v3 用 id 字段；无上游摘要 → 跳过完整性校验）
  const buildNum = build.id || build.build;
  const fileName = downloadInfo?.name || `paper-${mcVersion}-${buildNum}.jar`;
  return {
    url: `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${buildNum}/downloads/${fileName}`,
    expectedHash: null,
  };
}

/**
 * 部署进度发射 + 进行中注册表同步（单一出口）：
 * - 事件 payload 附带实例归属（instanceId/instanceName 等），前端据此在刷新后
 *   恢复「部署中」显示（部署实例未入库，订阅过滤不适用，走全局广播）
 * - 注册表（serverManager.activeDeploys）供 websocket 连接建立时补发，
 *   仅承载进行中阶段：终态（complete/error）只推送不写回——否则 WS 连接
 *   建立时会对已结束的部署重复补发历史终态，且注册表随部署次数累积残留
 * @param {{ instanceId: string, instanceName: string, type: string, mcVersion: string }|null} meta
 */
const TERMINAL_DEPLOY_STAGES = new Set(['complete', 'error']);

function trackDeployProgress(serverManager, meta, payload) {
  if (meta) {
    if (!TERMINAL_DEPLOY_STAGES.has(payload.stage)) {
      serverManager.activeDeploys?.set(meta.instanceId, { ...meta, stage: payload.stage, percent: payload.percent });
    }
    serverManager.emit('deployProgress', { ...payload, ...meta });
  } else {
    serverManager.emit('deployProgress', payload);
  }
}

async function downloadWithProgress(url, destPath, serverManager, stage = 'download', { expectedHash = null, maxBytes = JAR_DOWNLOAD_MAX_BYTES, deployMeta = null } = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const stream = got.stream(url, {
      timeout: { request: 120000 },
      retry: { limit: 2 },
      headers: { 'User-Agent': PAPER_USER_AGENT }
    });

    /** 中止：清理半成品 + 断流 + reject（promise 已 settle 时 reject 为 no-op） */
    const abort = (err) => {
      fs.existsSync(destPath) && fs.unlinkSync(destPath);
      stream.destroy();
      file.destroy();
      reject(err);
    };

    // 下载进度节流：got 的 downloadProgress 每个 chunk 触发（大 jar 每秒可达多次），
    // 全部广播会对所有在线客户端高频轰炸。节流：百分比变化 ≥1% 才发射
    let lastPct = -1;
    stream.on('downloadProgress', ({ percent, transferred, total }) => {
      // 体积上限断言在前（S-P1-1）：超限即刻断流清理，不等下载自然结束
      try {
        assertSizeWithinLimit(transferred, maxBytes);
      } catch (err) {
        abort(err);
        return;
      }
      const pct = percent > 0 ? percent : (total > 0 ? transferred / total : 0);
      if (pct - lastPct < 0.01) return;
      lastPct = pct;
      trackDeployProgress(serverManager, deployMeta, {
        stage,
        percent: pct,
        transferred,
        total
      });
    });

    stream.pipe(file);

    file.on('finish', () => {
      // close 回调确保 fd 落盘后才校验摘要（issue 316：fail-closed）
      file.close(() => {
        assertDownloadIntegrity(destPath, expectedHash)
          .then(() => {
            trackDeployProgress(serverManager, deployMeta, {
              stage: 'download_complete',
              percent: 1.0,
              transferred: 0,
              total: 0
            });
            resolve(destPath);
          })
          .catch((err) => {
            // 校验失败：弃已下载部分（清理残留）并抛含期望/实际摘要的可读错误
            try { fs.unlinkSync(destPath); } catch { /* 已清理 */ }
            reject(err);
          });
      });
    });

    stream.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });

    file.on('error', (err) => {
      stream.destroy();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
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
rcon.port=${25575 + parseInt(instanceId.slice(-4), 16) % 100}
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
server-port=${25565 + parseInt(instanceId.slice(-4), 16) % 100}
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

async function runFirstLaunch(instancePath, javaPath, jarFile, maxMemory) {
  return new Promise((resolve, _reject) => {
    const logsDir = path.join(instancePath, 'logs');
    if (fs.existsSync(logsDir)) {
      return resolve();
    }

    const args = [
      `-Xmx${maxMemory}`,
      `-Xms${maxMemory}`,
      '-jar', jarFile,
      'nogui',
    ];

    const proc = spawn(javaPath, args, {
      cwd: instancePath,
      // 不用 spawn 的 timeout 选项：Node 内部超时仅杀主进程（Windows 上
      // TerminateProcess），且其内部定时器先于自定义定时器触发——根进程先死
      // 会让下方 taskkill /T 无法递归定位整棵树。超时终止统一由下方自定义
      // 定时器按进程树处理（策略同 services/mc_server.js kill()）。
      // Linux/macOS：以独立进程组启动（pid 即 PGID），超时后按进程组终止；
      // Windows 不设 detached（无进程组信号概念），进程树由 taskkill /T 终止。
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    let output = '';
    proc.stdout.on('data', (data) => output += data.toString());
    proc.stderr.on('data', (data) => output += data.toString());

    const timeout = setTimeout(() => {
      // 只杀主进程不够：MC 1.18+/26.x 官方 server.jar 为 Bundler 结构，
      // java 主进程（BundlerMain 引导器）经 ProcessBuilder 派生真正运行的
      // 服务器 JVM，仅杀主进程会遗留孤儿 JVM 继续运行（占端口/写世界数据）。
      // 与 services/mc_server.js kill() 相同的进程树终止策略：
      // Windows 用 taskkill /T 递归终止整棵树；Linux/macOS 因 spawn 带
      // detached:true（pid 即 PGID）用 kill(-pid) 终止整个进程组。
      // 旧版（1.17-）server.jar 直接运行服务器主类、无派生进程，进程树终止
      // 对其同样有效，保持新旧版本兼容。
      const pid = proc.pid;
      if (pid) {
        if (process.platform === 'win32') {
          try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {}
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch {}
        }
      }
      // 单进程 SIGKILL 兜底（进程树终止失败/pid 缺失时仍杀主进程本身）
      try { proc.kill('SIGKILL'); } catch {}
      logger.warn('First launch timed out (60s), but config may have been generated');
      resolve();
    }, 60000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (fs.existsSync(logsDir) || code === 0) {
        resolve();
      } else {
        logger.warn(`First launch exited with code ${code}. Output: ${output.substring(0, 500)}`);
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.warn('First launch error:', err.message);
      resolve();
    });
  });
}

export function createServerJarRoutes(serverManager) {
  const router = express.Router();

  router.get('/versions', async (req, res) => {
    const type = (req.query.type || 'vanilla').toLowerCase();
    try {
      if (type === 'paper') {
        const versions = await getPaperVersions();
        return res.json(success({ type: 'paper', versions }));
      }

      if (type === 'vanilla') {
        // Vanilla 使用 Mojang 官方 manifest 并过滤 release 版本（minecraft-core 返回包含 snapshot）
        const manifest = await got('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', {
          timeout: { request: 15000 },
          retry: { limit: 2 }
        }).json();
        const releases = manifest.versions
          .filter(v => v.type === 'release')
          .slice(0, 30)
          .map(v => v.id);
        return res.json(success({ type: 'vanilla', versions: releases }));
      }

      if (type === 'fabric') {
        const rawVersions = await mcCoreManager.getVersions('fabric');
        const versions = Array.isArray(rawVersions) ? rawVersions : (rawVersions.versions || Object.keys(rawVersions));
        let loaders = [];
        try {
          const loaderData = await got('https://meta.fabricmc.net/v2/versions/loader', {
            timeout: { request: 15000 },
            retry: { limit: 2 }
          }).json();
          loaders = loaderData.filter(v => v.stable).map(v => v.version).slice(0, 10);
        } catch {}
        return res.json(success({ type: 'fabric', versions: versions.slice(0, 30), loaders }));
      }

      if (type === 'forge') {
        const promotions = await got('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
          timeout: { request: 15000 },
          retry: { limit: 2 }
        }).json();
        const versions = [...new Set(
          Object.keys(promotions.promos || {})
            .map(v => v.replace(/-(latest|recommended)$/, ''))
        )].filter(v => v.startsWith('1.')).reverse().slice(0, 30);
        return res.json(success({ type: 'forge', versions }));
      }

      const rawVersions = await mcCoreManager.getVersions(type);
      const versions = Array.isArray(rawVersions) ? rawVersions : (rawVersions.versions || Object.keys(rawVersions));
      return res.json(success({ type, versions: versions.slice(0, 30) }));
    } catch (e) {
      logger.error(`Failed to fetch ${type} versions:`, e.message);
      return res.status(502).json(error(ErrorCodes.SERVER_ERROR, `Failed to fetch versions: ${e.message}`));
    }
  });

  // 部署实例（请求体 schema parse 校验：type 枚举/必填字段由 deployRequestSchema 单源定义）
  router.post('/instances/deploy', validateBody(deployRequestSchema), async (req, res) => {
    const { type, mcVersion, instanceName, maxMemory, loaderVersion, eula } = req.body;
    // EULA 只由用户显式同意决定：面板不得代替用户表达同意（未同意同样可完成部署，仅不写 true、不自动首启）
    const eulaAgreed = eula === true;

    const instanceId = `${type}-${crypto.randomBytes(4).toString('hex')}`;
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

    try {
      // 必须在 try 内：mkdirSync 抛错（ENOTDIR/EACCES/EPERM）时由 catch 统一返回 502 并清理，
      // 否则裸 async handler 的 rejection 不被 Express 4 捕获 → 请求挂起 + unhandledRejection
      fs.mkdirSync(instancePath, { recursive: true });
      logger.info(`Deploying ${type} ${mcVersion} as ${instanceId}...`);
      // 部署起始即入注册表（连接补发的最早可见点：下载阶段首事件前）
      trackDeployProgress(serverManager, deployMeta, { stage: 'download', percent: 0, transferred: 0, total: 0 });

      // 审计「受理」语义（与 INSTANCE_DELETE 对偶，回查实例何时被谁创建）：
      // schema 校验通过 + 实例目录已建 + 部署流程正式启动即记录，不等终态。
      // 失败路径刻意不记审计：部署中断时实例目录已被清理、DB 未入库，不存在
      // 可回查的实例实体，失败可见性由部署进度 error 事件（进度面板 + 通知）承担，
      // 避免审计页出现指向已清理目录的幽灵记录
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
          if (build && build.downloads && build.downloads.application && build.downloads.application.url) {
            downloadUrl = build.downloads.application.url;
          } else if (build && build.url) {
            downloadUrl = build.url;
          } else if (build && build.downloadUrl) {
            downloadUrl = build.downloadUrl;
          } else {
            const downloadInfo = await mcCoreManager.downloadServer({
              core: type.toLowerCase(),
              version: mcVersion,
              outputDir: instancePath
            });
            if (downloadInfo && (downloadInfo.path || downloadInfo.filePath)) {
              downloadUrl = null;
            } else if (downloadInfo && downloadInfo.url) {
              downloadUrl = downloadInfo.url;
            }
          }
          // minecraft-core 各核心返回结构不一，防御式取摘要字段：
          // v3 downloads.application.sha256 / 顶层 sha256 / 顶层 sha1（有则校验）
          const buildHash = build?.downloads?.application?.sha256 || build?.sha256 || build?.sha1;
          if (downloadUrl && buildHash) {
            expectedHash = {
              algorithm: build?.sha1 && !build?.sha256 && !build?.downloads?.application?.sha256 ? 'sha1' : 'sha256',
              digest: String(buildHash),
            };
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

      if (downloadUrl) {
        logger.info(`Download URL: ${downloadUrl}`);
        await downloadWithProgress(downloadUrl, jarPath, serverManager, 'download', { expectedHash, deployMeta });
      } else {
        const downloadedFile = fs.readdirSync(instancePath).find(f => f.endsWith('.jar'));
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
        trackDeployProgress(serverManager, deployMeta, { stage: 'forge_install', percent: 0, transferred: 0, total: 0 });
        const extractArgs = ['-Xmx512M', '-jar', downloadJarName, '--installServer'];
        const extractProc = spawn(javaPath, extractArgs, { cwd: instancePath });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            extractProc.kill();
            reject(new Error('Forge installer timed out (120s)'));
          }, 120000);
          extractProc.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) logger.warn(`Forge installer exited with code ${code}`);
            resolve();
          });
          extractProc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        const forgeJar = fs.readdirSync(instancePath).find(
          f => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('installer')
        );
        if (forgeJar) {
          jarFile = forgeJar;
        } else {
          throw new Error('Forge server jar not found after install');
        }
        fs.unlinkSync(jarPath);
      }

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

      atomicWriteFile(path.join(instancePath, 'instance.json'), JSON.stringify(instanceConfig, null, 2));
      fs.writeFileSync(path.join(instancePath, 'eula.txt'), eulaAgreed ? 'eula=true\n' : 'eula=false\n');
      fs.writeFileSync(path.join(instancePath, 'server.properties'), generateServerProperties(instanceId, mcVersion));

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
          port: 25565 + parseInt(instanceId.slice(-4), 16) % 100,
        });
        logger.info(`Instance ${instanceId} written to DB`);
      } catch (dbErr) {
        logger.warn(`Failed to write instance to DB:`, dbErr.message);
      }

      // 首启用于生成世界与校验 jar，而 MC 首启强制要求 eula=true；
      // 未同意时跳过，待用户在实例上确认 EULA 后首次启动自然完成，避免写入未获同意的 eula=true
      if (eulaAgreed) {
        trackDeployProgress(serverManager, deployMeta, { stage: 'first_launch', percent: 0, transferred: 0, total: 0 });
        try {
          logger.info('Running first launch to generate config...');
          await runFirstLaunch(instancePath, javaPath, jarFile, ramSize);
          logger.info('First launch completed');
        } catch (e) {
          logger.warn('First launch failed (may require manual setup):', e.message);
        }
      }

      serverManager.loadInstances();

      // 终态：先移除注册表（补发只针对进行中），payload 仍携带归属供通知文案
      serverManager.activeDeploys?.delete(instanceId);
      trackDeployProgress(serverManager, deployMeta, { stage: 'complete', percent: 1.0, transferred: 0, total: 0 });
      logger.info(`Instance ${instanceId} deployed successfully`);

      res.json(success({
        id: instanceId,
        name: instanceConfig.name,
        type: type.toLowerCase(),
        mcVersion,
        javaVersion,
        path: instancePath,
        maxMemory: ramSize,
      }, 'Instance deployed successfully'));
    } catch (e) {
      // 清理失败（Windows 上目录被进程占用——如孤儿 JVM 仍在写文件——或权限
      // 不足时 rmSync 抛 EPERM/EBUSY）必须兜住：异常从 catch 逃逸会变成 async
      // rejection，Express 4 不捕获 → 请求挂起 + unhandledRejection 崩溃
      // （与上方 L312-314 mkdirSync 同源问题）。清理失败仅记录日志，仍返回 502。
      try {
        fs.rmSync(instancePath, { recursive: true, force: true });
      } catch (cleanupErr) {
        logger.warn('Failed to clean up instance dir after failed deploy:', cleanupErr.message);
      }
      serverManager.activeDeploys?.delete(instanceId);
      trackDeployProgress(serverManager, deployMeta, { stage: 'error', percent: 0, transferred: 0, total: 0, error: e.message });
      logger.error(`Failed to deploy ${type} ${mcVersion}:`, e.message);
      return res.status(502).json(error(ErrorCodes.SERVER_ERROR, `Deployment failed: ${e.message}`));
    }
  });

  return router;
}
