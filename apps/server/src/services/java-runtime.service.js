/**
 * 面板自供的 Java 运行时（Mojang java-runtime）解析与落地。
 *
 * 上游形态（对照真实响应核实，非推测）：
 * - 清单 all.json：`{ "<platform>": { "<component>": [ { manifest: { url, sha1, size }, version } ] } }`。
 *   platform 取值 gamecore / linux / linux-i386 / mac-os / mac-os-arm64 / windows-x64 /
 *   windows-x86 / windows-arm64 —— **没有 linux-arm64**，该平台无法自动供给。
 * - 清单 URL 里的 `2ec0cc96…` 是官方启动器硬编码的路径段，不是内容寻址：去掉它返回 404，
 *   也不等于 all.json 自身的 sha1，故只能作常量维护。
 * - 每组件每平台一份 runtime manifest（piston-meta 的 `/v1/packages/<sha1>/manifest.json`），
 *   内容是**逐文件清单而非压缩包**：`{ files: { "<相对路径>": { type, executable?,
 *   downloads: { raw: { url, sha1, size } } } } }`，文件域是 piston-data.mojang.com。
 *   实测 linux + java-runtime-delta：136 个文件 / 104MB（lib/modules 62MB、libjvm 26MB），
 *   每个文件各带 sha1。
 * - 组件与主版本的对应（取样 1.16.5 / 1.17.1 / 1.18.2 / 1.20.1 / 1.20.4 / 1.20.5 /
 *   1.20.6 / 1.21.1 / 1.21.4 / 1.21.8 / 1.21.11 / 26.1 / 26.1.2 / 26.3 的 version JSON）：
 *   8→jre-legacy、16→java-runtime-alpha、17→java-runtime-beta|gamma（两者同为 17.0.15）、
 *   21→java-runtime-delta、25→java-runtime-epsilon。
 *
 * 上游既没有压缩包，防线就不在「解压」而在文件键与逐文件摘要：文件键拒绝绝对路径、
 * `..` 段与反斜杠，文件全部落 staging 目录、逐个校验 sha1，最后整体 rename 到位。
 * 清单里还有大量 link 条目（linux/mac 的 java-runtime-epsilon 实测各 205 条，目标只有
 * `../java.base/<许可证文件>` 等 4 种包内相对路径），必须按符号链接原样复刻：目标是
 * 相对字符串、解析后必须仍在安装根内，绝对目标或任何越界解析一律中止安装。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { httpJson, httpStream } from '../utils/http-client.js';
import {
  RUNTIME_DOWNLOAD_HOSTS,
  assertAllowedDownloadHost,
  hashFile,
} from '../utils/jar-download-guard.js';
import { AppError, ErrorCodes } from '../utils/response.js';
import { TaskCancelledError } from '../utils/cancellable-task.js';
import {
  findJavaPathStrict,
  getJavaVersionFromPath,
  getPanelJreDir,
  isJavaSatisfied,
} from '../utils/java-detector.js';
import { isPathContained } from '../utils/fs-utils.js';
import { logger } from '../utils/logger.js';
import { getServerVersion } from '../utils/version.js';
import { resolveVanillaJavaRuntime } from './vanilla-manifest.js';

/** 运行时清单（官方启动器的取值；路径段是硬编码常量，见文件头） */
export const JAVA_RUNTIME_MANIFEST_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime' +
  '/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

/**
 * 组件与主版本的对应表：只在版本元数据拿不到权威组件时兜底（快照/上游字段变更）。
 * 依据是各 MC 版本 version JSON 的 `javaVersion` 实测值（见文件头）。
 */
const COMPONENT_BY_MAJOR = {
  8: 'jre-legacy',
  16: 'java-runtime-alpha',
  17: 'java-runtime-gamma',
  21: 'java-runtime-delta',
  25: 'java-runtime-epsilon',
};

/// 实测最大单文件 lib/modules 62MB，留四倍余量
const MAX_RUNTIME_FILE_BYTES = 256 * 1024 * 1024;
/// 实测整包 104MB，留五倍余量（约一个完整 JRE 的量级）
const MAX_RUNTIME_TOTAL_BYTES = 512 * 1024 * 1024;
/// 逐文件并发：小文件多、大文件少，4 路足以把请求往返与带宽重叠
const RUNTIME_DOWNLOAD_CONCURRENCY = 4;
const RUNTIME_FILE_TIMEOUT_MS = 120_000;
const RUNTIME_JSON_TIMEOUT_MS = 30_000;

const USER_AGENT = `MC_Commander/${getServerVersion()} (https://github.com/wyyfzb/mc-commander)`;
const JAVA_BINARY = os.platform() === 'win32' ? 'java.exe' : 'java';

/** 同一主版本的安装进程内去重：两个并发部署不该各下一份 100MB */
const installsInFlight = new Map();

/**
 * 当前平台在官方清单里的 key；没有对应产物（如 linux/arm64）返回 null。
 * @param {string} [platform] os.platform()
 * @param {string} [arch] os.arch()
 * @returns {string|null}
 */
export function runtimePlatformKey(platform = os.platform(), arch = os.arch()) {
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux';
    if (arch === 'ia32') return 'linux-i386';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'windows-x64';
    if (arch === 'ia32') return 'windows-x86';
    if (arch === 'arm64') return 'windows-arm64';
    return null;
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return null;
}

/**
 * 主版本 → 运行时组件（兜底表）。未收录返回 null。
 * @param {number|string} majorVersion
 * @returns {string|null}
 */
export function javaComponentForMajor(majorVersion) {
  const major = parseInt(majorVersion, 10);
  return Number.isInteger(major) ? (COMPONENT_BY_MAJOR[major] ?? null) : null;
}

/** 上游地址断言：白名单外的域一律中止，错误信息给用户可读的中文结论 */
function assertRuntimeHost(rawUrl) {
  try {
    assertAllowedDownloadHost(rawUrl, RUNTIME_DOWNLOAD_HOSTS);
  } catch {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      'Mojang Java 运行时的下载域不在白名单内，已中止下载',
    );
  }
}

/** 运行时清单里的文件键必须落在 staging 目录内 */
function assertSafeRuntimeKey(key) {
  const unsafe =
    typeof key !== 'string' ||
    key === '' ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.startsWith('/') ||
    /^[a-zA-Z]:/.test(key) ||
    key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (unsafe) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Mojang 运行时清单含不安全路径（${key}），已中止安装`,
    );
  }
}

/** 组件选择：版本元数据的 javaVersion 是权威值，取不到才查主版本表 */
async function resolveRuntimeComponent(major, mcVersion) {
  if (mcVersion) {
    try {
      const meta = await resolveVanillaJavaRuntime(mcVersion);
      if (meta && meta.majorVersion === major) return meta.component;
    } catch (err) {
      logger.warn(
        `[java-runtime] 读取 ${mcVersion} 的 Java 组件失败，改按主版本查表：${err.message}`,
      );
    }
  }
  return javaComponentForMajor(major);
}

/** 取该组件在该平台的 runtime manifest 地址（不存在时给出可操作错误） */
async function resolveRuntimeManifestUrl(major, component, platformKey) {
  assertRuntimeHost(JAVA_RUNTIME_MANIFEST_URL);
  const all = await httpJson(JAVA_RUNTIME_MANIFEST_URL, {
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: RUNTIME_JSON_TIMEOUT_MS,
    retryLimit: 2,
  });
  const candidates = all?.[platformKey]?.[component];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Mojang 运行时清单里没有 ${platformKey} 平台的 ${component}（Java ${major}），` +
        `请手动安装 Java ${major} 后重试`,
    );
  }
  const manifestUrl = candidates[0]?.manifest?.url;
  if (typeof manifestUrl !== 'string') {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Mojang Java ${major} 运行时清单缺少 manifest 地址，请手动安装 Java ${major} 后重试`,
    );
  }
  assertRuntimeHost(manifestUrl);
  return manifestUrl;
}

/** 解析 runtime manifest → 待安装条目（directory/file/link 三类；文件键、摘要、link 目标先行校验） */
async function fetchRuntimeFileEntries(manifestUrl, major) {
  assertRuntimeHost(manifestUrl);
  const manifest = await httpJson(manifestUrl, {
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: RUNTIME_JSON_TIMEOUT_MS,
    retryLimit: 2,
  });
  const files = manifest?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Mojang Java ${major} 运行时清单缺少 files 字段，无法自动准备，请手动安装 Java ${major}`,
    );
  }
  const entries = [];
  for (const [key, item] of Object.entries(files)) {
    assertSafeRuntimeKey(key);
    if (item?.type === 'directory') {
      entries.push({ key, kind: 'directory' });
      continue;
    }
    if (item?.type === 'link') {
      // 合法性依赖 staging 根（目标相对链接所在目录解析），此处只收目标、落盘前再判
      if (typeof item.target !== 'string' || item.target === '' || item.target.includes('\0')) {
        throw new AppError(
          ErrorCodes.SERVER_ERROR,
          `Mojang Java ${major} 运行时清单的符号链接 ${key} 缺少目标，` +
            `无法自动准备，请手动安装 Java ${major} 后重试`,
        );
      }
      entries.push({ key, kind: 'link', target: item.target });
      continue;
    }
    if (item?.type !== 'file') {
      throw new AppError(
        ErrorCodes.SERVER_ERROR,
        `Mojang Java ${major} 运行时清单含不支持的条目（${key}: ${item?.type}），` +
          `请手动安装 Java ${major} 后重试`,
      );
    }
    const raw = item.downloads?.raw;
    if (
      typeof raw?.url !== 'string' ||
      typeof raw?.sha1 !== 'string' ||
      !Number.isFinite(raw?.size)
    ) {
      throw new AppError(
        ErrorCodes.SERVER_ERROR,
        `Mojang Java ${major} 运行时清单的 ${key} 缺少下载地址/摘要/体积，` +
          `请手动安装 Java ${major} 后重试`,
      );
    }
    assertRuntimeHost(raw.url);
    entries.push({
      key,
      kind: 'file',
      url: raw.url,
      sha1: raw.sha1,
      size: raw.size,
      executable: item.executable === true,
    });
  }
  if (!entries.some((entry) => entry.kind === 'file')) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Mojang Java ${major} 运行时清单为空，无法自动准备，请手动安装 Java ${major}`,
    );
  }
  return entries;
}

/** 下载单个文件到 destPath；onBytes 报告本次新增字节数 */
function downloadToFile(url, destPath, { signal, onBytes }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    const stream = httpStream(url, {
      timeoutMs: RUNTIME_FILE_TIMEOUT_MS,
      retryLimit: 2,
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    const file = fs.createWriteStream(destPath);
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (!err) {
        resolve();
        return;
      }
      stream.destroy();
      file.destroy();
      reject(err);
    };
    const onAbort = () => settle(new TaskCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    let received = 0;
    stream.on('downloadProgress', ({ transferred }) => {
      if (transferred > MAX_RUNTIME_FILE_BYTES) {
        settle(
          new AppError(
            ErrorCodes.SERVER_ERROR,
            `Java 运行时单文件超过 ${MAX_RUNTIME_FILE_BYTES} 字节上限，已中止下载`,
          ),
        );
        return;
      }
      // 单文件重试会从 0 重新计数，倒退即视为新一轮
      const delta = transferred > received ? transferred - received : 0;
      received = transferred;
      onBytes?.(delta);
    });
    stream.pipe(file);
    // 先 close 再判定完成：close 回调之后 fd 才真正落盘，随后才能读文件算摘要
    file.on('finish', () => file.close(() => settle()));
    file.on('error', (err) => settle(err));
    stream.on('error', (err) => settle(err));
  });
}

/** 下载失败的中文化（上游 HTTP 码/网络错误都给出可操作结论） */
function toDownloadError(err) {
  if (err instanceof AppError) return err;
  if (err?.statusCode) {
    return new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java 运行时下载失败（上游返回 HTTP ${err.statusCode}），请检查网络后重试`,
    );
  }
  return new AppError(
    ErrorCodes.SERVER_ERROR,
    `Java 运行时下载失败（${err?.message || '网络错误'}），请检查网络后重试`,
  );
}

/** 下载 + sha1 校验 + 落位 + 按 manifest 的 executable 位设权限 */
async function downloadRuntimeFile(entry, stagingDir, { major, signal, onBytes }) {
  const dest = path.join(stagingDir, ...entry.key.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmpPath = `${dest}.part`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await downloadToFile(entry.url, tmpPath, { signal, onBytes });
      break;
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      if (err?.cancelled === true || signal?.aborted) throw new TaskCancelledError();
      // 整包 136 个文件：单个响应体中断就重下 100MB 代价过大，故逐文件再试一次
      if (attempt >= 2) throw toDownloadError(err);
    }
  }
  const actual = await hashFile(tmpPath, 'sha1');
  if (actual.toLowerCase() !== entry.sha1.toLowerCase()) {
    fs.rmSync(tmpPath, { force: true });
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java ${major} 运行时文件校验失败（${entry.key}），下载可能已损坏，请重试`,
    );
  }
  fs.renameSync(tmpPath, dest);
  fs.chmodSync(dest, entry.executable ? 0o755 : 0o644);
}

/**
 * 建符号链接：目标按**原样的相对字符串**写入（解析成绝对路径再写，同一份 JRE 换个目录
 * 就失效），但创建前必须证明它解析后仍在安装根内——越界目标等于把读取引到运行时目录之外。
 */
function createRuntimeLink(entry, stagingDir, major) {
  const dest = path.join(stagingDir, ...entry.key.split('/'));
  const relativeFromRoot = path.join(path.dirname(entry.key), entry.target);
  if (
    path.isAbsolute(entry.target) ||
    entry.target.includes('\0') ||
    !isPathContained(stagingDir, relativeFromRoot)
  ) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Mojang Java ${major} 运行时清单的符号链接 ${entry.key} 指向安装目录之外，已中止安装`,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.symlinkSync(entry.target, dest);
  } catch (err) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java ${major} 运行时安装失败：无法创建符号链接 ${entry.key}（${err?.code || '未知错误'}），` +
        `请重试或手动安装 Java ${major}`,
    );
  }
}

/**
 * 装完按真实解析结果复核链接：悬空链接读不到根外内容，跳过；能解析且落在安装根外的中止。
 * 前缀比对用 staging 根的 realpath，避免宿主的 /tmp → /private/tmp 这类链接造成误判。
 */
function verifyRuntimeLinks(entries, stagingDir, major) {
  const root = fs.realpathSync(stagingDir);
  for (const entry of entries) {
    if (entry.kind !== 'link') continue;
    const dest = path.join(stagingDir, ...entry.key.split('/'));
    let resolved;
    try {
      resolved = fs.realpathSync(dest);
    } catch {
      continue;
    }
    if (!isPathContained(root, resolved)) {
      throw new AppError(
        ErrorCodes.SERVER_ERROR,
        `Mojang Java ${major} 运行时的符号链接 ${entry.key} 解析后落在安装目录之外，已中止安装`,
      );
    }
  }
}

/** 建目录 → 并发下载文件（按字节聚合 0~1 进度）→ 复刻链接 → 复核链接 */
async function installRuntimeFiles(entries, stagingDir, { major, signal, onProgress }) {
  // 目录条目先建：有的目录只装链接（legal/<pkg>/ 全是许可证链接），靠文件的父目录建不出来
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue;
    fs.mkdirSync(path.join(stagingDir, ...entry.key.split('/')), { recursive: true });
  }
  const files = entries.filter((entry) => entry.kind === 'file');
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  let transferred = 0;
  let lastPercent = -1;
  const report = () => {
    if (!onProgress) return;
    const percent = totalBytes > 0 ? Math.min(transferred / totalBytes, 1) : 0;
    // 与既有下载进度同口径：1% 一档，避免逐文件每次分片都推一次 WS
    if (percent - lastPercent < 0.01 && percent < 1) return;
    lastPercent = percent;
    onProgress(percent);
  };
  onProgress?.(0);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      if (signal?.aborted) throw new TaskCancelledError();
      await downloadRuntimeFile(files[index], stagingDir, {
        major,
        signal,
        onBytes: (delta) => {
          transferred += delta;
          report();
        },
      });
      if (transferred > MAX_RUNTIME_TOTAL_BYTES) {
        throw new AppError(
          ErrorCodes.SERVER_ERROR,
          `Java ${major} 运行时体积超过 ${MAX_RUNTIME_TOTAL_BYTES} 字节上限，已中止安装`,
        );
      }
    }
  };
  const workerCount = Math.min(RUNTIME_DOWNLOAD_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (signal?.aborted) throw new TaskCancelledError();
  for (const entry of entries) {
    if (entry.kind === 'link') createRuntimeLink(entry, stagingDir, major);
  }
  verifyRuntimeLinks(entries, stagingDir, major);
  onProgress?.(1);
}

/** 装完自证：文件在、可执行、`java -version` 报的正是目标主版本 */
function assertJavaRuns(javaPath, major) {
  if (!fs.existsSync(javaPath)) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java ${major} 安装不完整（缺少 bin/java），请重试`,
    );
  }
  if (os.platform() !== 'win32') {
    try {
      fs.accessSync(javaPath, fs.constants.X_OK);
    } catch {
      throw new AppError(
        ErrorCodes.SERVER_ERROR,
        `Java ${major} 安装后缺少可执行权限（${javaPath}），请重试`,
      );
    }
  }
  const version = getJavaVersionFromPath(javaPath);
  if (version === null) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java ${major} 下载完成但无法运行（本机可能缺少运行库），请手动安装 Java ${major} 后重试`,
    );
  }
  if (parseInt(version, 10) !== major) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java ${major} 运行时版本校验失败（实际 ${version}），请重试`,
    );
  }
}

/** 真正执行一次安装：staging 内下齐 → 自证 → 整体 rename；失败清 staging */
async function installJavaRuntime(major, { mcVersion, signal, onProgress }) {
  const component = await resolveRuntimeComponent(major, mcVersion);
  if (!component) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `面板未收录 Java ${major} 对应的 Mojang 运行时组件，请手动安装 Java ${major} 后重试`,
    );
  }
  const platformKey = runtimePlatformKey();
  const manifestUrl = await resolveRuntimeManifestUrl(major, component, platformKey);
  const entries = await fetchRuntimeFileEntries(manifestUrl, major);
  if (signal?.aborted) throw new TaskCancelledError();

  const jreDir = getPanelJreDir();
  if (!jreDir) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      '面板未配置 Java 运行时目录（config.jreDir），无法落地 Java，请检查配置后重试',
    );
  }
  fs.mkdirSync(jreDir, { recursive: true });
  const finalDir = path.join(jreDir, String(major));
  const stagingDir = path.join(jreDir, `.staging-${major}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    await installRuntimeFiles(entries, stagingDir, { major, signal, onProgress });
    assertJavaRuns(path.join(stagingDir, 'bin', JAVA_BINARY), major);
    // 走到这里说明盘上没有可用安装，同名目录只可能是上次中断的半成品
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, finalDir);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  const installedPath = path.join(finalDir, 'bin', JAVA_BINARY);
  // 面板自己的扫描必须能看见并认可它：否则「下齐了但选不到」会成为新的静默失效
  if (!isJavaSatisfied(installedPath, major)) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `Java ${major} 已下载但面板未能识别（${installedPath}），请重试或手动安装 Java ${major}`,
    );
  }
  logger.info(`[java-runtime] Java ${major} 已就绪：${installedPath}`);
  return installedPath;
}

/** 安装链失败的中文化：AppError 已是可读结论，其余补上「可做什么」 */
function toProvisionError(major, err) {
  if (err?.cancelled === true || err instanceof AppError) return err;
  if (err?.statusCode) {
    return new AppError(
      ErrorCodes.SERVER_ERROR,
      `自动准备 Java ${major} 失败（上游返回 HTTP ${err.statusCode}），` +
        `请检查网络后重试或手动安装 Java ${major}`,
    );
  }
  return new AppError(
    ErrorCodes.SERVER_ERROR,
    `自动准备 Java ${major} 失败（${err?.message || '未知错误'}），` +
      `请检查网络后重试或手动安装 Java ${major}`,
  );
}

/**
 * 确保本机有满足要求的 Java 并返回其路径：先扫已有 Java，缺了才下载 Mojang 运行时。
 *
 * 满足判据与 `isJavaSatisfied` 一致（主版本不低于要求即满足），因此已有 21 的机器
 * 不会为 1.20.4 再下一份 17；只有「一个都不能用」时才产生下载。
 *
 * @param {string|number} requiredVersion 需要的 Java 主版本号
 * @param {{ mcVersion?: string|null, signal?: AbortSignal|null,
 *           onProgress?: ((percent: number) => void)|null }} [options]
 *        onProgress 只在真的要下载时被调用（0 起步，1% 一档）
 * @returns {Promise<string>} 满足要求的 java 可执行文件路径
 */
export async function ensureJavaRuntime(
  requiredVersion,
  { mcVersion = null, signal = null, onProgress = null } = {},
) {
  const major = parseInt(requiredVersion, 10);
  if (!Number.isInteger(major) || major <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `无效的 Java 主版本：${requiredVersion}`);
  }
  const installed = findJavaPathStrict(major);
  if (installed) return installed;

  if (!runtimePlatformKey()) {
    throw new AppError(
      ErrorCodes.SERVER_ERROR,
      `无法自动准备 Java ${major}：Mojang 未提供 ${os.platform()}/${os.arch()} 平台的官方运行时，` +
        `本平台需自行安装 Java ${major} 后重试`,
    );
  }

  const pending = installsInFlight.get(major);
  if (pending) return pending;

  const job = installJavaRuntime(major, { mcVersion, signal, onProgress }).catch((err) => {
    logger.warn(`[java-runtime] Java ${major} 自动准备失败：${err?.message || err}`);
    throw toProvisionError(major, err);
  });
  installsInFlight.set(major, job);
  try {
    return await job;
  } finally {
    installsInFlight.delete(major);
  }
}

export default {
  ensureJavaRuntime,
  runtimePlatformKey,
  javaComponentForMajor,
  JAVA_RUNTIME_MANIFEST_URL,
};
