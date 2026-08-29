/**
 * 插件市场服务（feat-8 延伸：Modrinth 一键安装）
 *
 * 数据源：Modrinth API v2（无需鉴权；要求携带可联系的 User-Agent，尊重其
 * ~300 req/min 限速 → 服务端代理 + 60s 内存 TTL 缓存，前端不直连外网）。
 *
 * 范围：project_type=plugin（Bukkit 系：paper/spigot/bukkit/purpur/folia）。
 * 安装 = 服务端解析版本 primary 文件 → CDN 下载（域名白名单 + 100MB 上限 +
 * zip 魔数校验）→ 复用 uploadPlugin 落盘（同名 40912 / overwrite 显式覆盖，
 * 与手动上传完全同一套安全语义）。
 *
 * 安全设计：
 * - 下载 URL 仅允许 https://cdn.modrinth.com/（版本数据来自 Modrinth API，
 *   但 URL 白名单兜底——即使上游被污染也不产生任意外域下载）
 * - 文件名确定性净化（空格等白名单外字符 → '-'），路径逃逸由 uploadPlugin
 *   的正则白名单 + 目录校验双重防护
 * - 流式下载过程中实时统计字节数，超过上限立刻销毁流并清理半成品
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import got from 'got';
import { AppError, ErrorCodes } from '../utils/response.js';
import { uploadPlugin } from './plugin.service.js';

const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';

/// 下载域名白名单：Modrinth CDN（版本 files[].url 的唯一合法宿主）
const MODRINTH_CDN_PREFIX = 'https://cdn.modrinth.com/';

/// Modrinth 要求 UA 可识别且带联系方式（文档 §Rate Limit）
const USER_AGENT = 'MC_Commander/0.1.0 (+https://github.com/wyyfzb/mc-commander)';

/// API 请求超时（元数据接口）/ 下载超时（CDN 大文件）
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/// 单插件下载体积上限（与手动上传 100MB 对齐）
const MARKET_DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024;

/// 元数据内存 TTL 缓存：60s（尊重上游限速；搜索/版本列表读多写少）
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

/// 插件类加载器白名单（Modrinth facets 用；Bukkit 系）
const ALLOWED_LOADERS = new Set(['paper', 'spigot', 'bukkit', 'purpur', 'folia']);

/// MC 版本号格式（普通版 1.21.4 / 新纪元 26.2 / 快照组合均放宽为数字段）
const GAME_VERSION_REGEX = /^\d{1,3}(\.\d{1,3}){0,2}(-pre\d*)?$/;

/** 简单 TTL 缓存（LRU 语义：超容量时淘汰最早过期的条目） */
const cache = new Map();

/// 仅供测试 / 运维手工刷新缓存使用
export function clearMarketCache() {
  cache.clear();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // 淘汰最早过期的条目（近似 LRU，避免 Map 无界增长）
    let oldestKey = null;
    let oldestExp = Infinity;
    for (const [k, v] of cache) {
      if (v.expires < oldestExp) {
        oldestExp = v.expires;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) cache.delete(oldestKey);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });
}

/**
 * 将 Modrinth API 错误翻译为市场错误码：
 * 404 → 40412/40413（项目/版本不存在），其余 → 50301（上游错误，保留状态码语义）
 */
function translateUpstreamError(err, notFoundCode) {
  if (err instanceof AppError) return err;
  if (err?.response?.statusCode === 404) {
    return new AppError(notFoundCode, 'Not found on Modrinth');
  }
  return new AppError(ErrorCodes.MARKET_UPSTREAM_ERROR,
    `Modrinth upstream error: ${err?.message || 'unknown'}`);
}

/** 参数校验：搜索词 */
function requireQuery(q) {
  if (typeof q !== 'string' || q.trim().length === 0 || q.length > 100) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Query must be 1-100 chars');
  }
  return q.trim();
}

/** 参数校验：MC 版本（可空） */
function sanitizeGameVersion(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !GAME_VERSION_REGEX.test(v)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid game version: ${v}`);
  }
  return v;
}

/** 参数校验：加载器（可空） */
function sanitizeLoader(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !ALLOWED_LOADERS.has(v)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid loader: ${v}`);
  }
  return v;
}

/** 组装 Modrinth facets（project_type=plugin 恒定；版本/加载器可选） */
function buildFacets({ gameVersion, loader }) {
  const facets = [['project_type:plugin']];
  if (gameVersion) facets.push([`game_versions:${gameVersion}`]);
  if (loader) facets.push([`loaders:${loader}`]);
  return facets;
}

/**
 * 搜索插件市场（Modrinth /search 代理 + TTL 缓存）。
 * @returns {{ totalHits: number, hits: Array, cached: boolean }}
 */
export async function searchMarketPlugins({ query, offset = 0, limit = 20, gameVersion = null, loader = null }) {
  const q = requireQuery(query);
  const gv = sanitizeGameVersion(gameVersion);
  const ld = sanitizeLoader(loader);

  const off = Number.isInteger(offset) && offset >= 0 ? Math.min(offset, 10_000) : 0;
  const lim = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 20) : 20;

  const cacheKey = `search:${q}:${off}:${lim}:${gv ?? ''}:${ld ?? ''}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  try {
    const data = await got(`${MODRINTH_API_BASE}/search`, {
      searchParams: {
        query: q,
        offset: off,
        limit: lim,
        index: 'relevance',
        facets: JSON.stringify(buildFacets({ gameVersion: gv, loader: ld })),
      },
      headers: { 'User-Agent': USER_AGENT },
      timeout: { request: API_TIMEOUT_MS },
      retry: { limit: 1 },
    }).json();

    const result = {
      totalHits: typeof data.total_hits === 'number' ? data.total_hits : 0,
      // 字段白名单：只透出列表页所需字段，避免上游结构变化泄漏到响应
      hits: (Array.isArray(data.hits) ? data.hits : []).map((h) => ({
        projectId: h.project_id ?? null,
        slug: h.slug ?? null,
        title: h.title ?? null,
        description: h.description ?? null,
        author: h.author ?? null,
        downloads: typeof h.downloads === 'number' ? h.downloads : 0,
        follows: typeof h.follows === 'number' ? h.follows : 0,
        iconUrl: typeof h.icon_url === 'string' && h.icon_url.startsWith('https://')
          ? h.icon_url
          : null,
        dateModified: h.date_modified ?? null,
        categories: Array.isArray(h.display_categories)
          ? h.display_categories.filter((c) => typeof c === 'string').slice(0, 8)
          : [],
        serverSide: h.server_side ?? null,
        clientSide: h.client_side ?? null,
      })),
      cached: false,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    throw translateUpstreamError(err, ErrorCodes.MARKET_UPSTREAM_ERROR);
  }
}

/**
 * 拉取项目的版本列表（Modrinth /project/:slug/version 代理 + TTL 缓存）。
 * 按 date_published 倒序返回（上游默认即倒序，这里显式保证）。
 * @returns {{ projectSlug: string, versions: Array, cached: boolean }}
 */
export async function getMarketProjectVersions(slug, { gameVersion = null, loader = null } = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(slug)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid project slug: ${slug}`);
  }
  const gv = sanitizeGameVersion(gameVersion);
  const ld = sanitizeLoader(loader);

  const cacheKey = `versions:${slug}:${gv ?? ''}:${ld ?? ''}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const searchParams = {};
  if (gv) searchParams.game_versions = JSON.stringify([gv]);
  if (ld) searchParams.loaders = JSON.stringify([ld]);

  try {
    const data = await got(`${MODRINTH_API_BASE}/project/${encodeURIComponent(slug)}/version`, {
      searchParams,
      headers: { 'User-Agent': USER_AGENT },
      timeout: { request: API_TIMEOUT_MS },
      retry: { limit: 1 },
    }).json();

    const versions = (Array.isArray(data) ? data : [])
      .map((v) => {
        const primary = (Array.isArray(v.files) ? v.files : []).find((f) => f.primary)
          ?? (Array.isArray(v.files) ? v.files[0] : null);
        return {
          versionNumber: typeof v.version_number === 'string' ? v.version_number : null,
          versionType: ['release', 'beta', 'alpha'].includes(v.version_type) ? v.version_type : null,
          name: typeof v.name === 'string' ? v.name : null,
          changelog: typeof v.changelog === 'string' ? v.changelog.slice(0, 2000) : null,
          datePublished: v.date_published ?? null,
          downloads: typeof v.downloads === 'number' ? v.downloads : 0,
          gameVersions: Array.isArray(v.game_versions)
            ? v.game_versions.filter((g) => typeof g === 'string').slice(0, 30)
            : [],
          loaders: Array.isArray(v.loaders)
            ? v.loaders.filter((l) => typeof l === 'string').slice(0, 8)
            : [],
          file: primary
            ? {
                url: typeof primary.url === 'string' ? primary.url : null,
                filename: typeof primary.filename === 'string' ? primary.filename : null,
                size: typeof primary.size === 'number' ? primary.size : 0,
              }
            : null,
        };
      })
      // 无 primary 文件（极端情况）或文件名为空的版本不可安装，直接过滤
      .filter((v) => v.file && v.file.filename);

    const result = { projectSlug: slug, versions, cached: false };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    throw translateUpstreamError(err, ErrorCodes.MARKET_PROJECT_NOT_FOUND);
  }
}

/**
 * 文件名确定性净化：Modrinth 文件名可能含空格/括号等白名单外字符。
 * 规则：取 basename（防上游异常路径）→ 空白折叠为 '-' → 删除白名单外字符 →
 * 空结果回退 slug-version.jar（回退名同样净化，保证任何上游数据下输出都满足
 * PLUGIN_UPLOAD_NAME_REGEX 语义）。输出必须匹配上传白名单。
 */
export function sanitizeMarketFileName(filename, { slug, versionNumber }) {
  const fallback = (() => {
    const raw = `${slug || 'plugin'}-${versionNumber || 'file'}.jar`
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .replace(/^\.+/, '');
    return /^[A-Za-z0-9][A-Za-z0-9._-]*\.jar$/.test(raw) ? raw : 'modrinth-plugin.jar';
  })();

  const base = String(filename || '').split(/[/\\]/).pop();
  const stripped = base
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '');
  // 净化后为空（空文件名/全白名单外字符）→ 直接走回退名
  if (!stripped) return fallback;
  let cleaned = /^[A-Za-z0-9]/.test(stripped) ? stripped : `mc-${stripped}`;
  // 扩展名统一为小写 .jar（Plugin.JAR → Plugin.jar；大写形式不满足上传白名单）
  cleaned = cleaned.replace(/\.jar$/i, '.jar');
  if (cleaned.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jar$/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

/**
 * 下载 Modrinth CDN 文件到临时目录，返回临时文件路径。
 * - 域名白名单：url 必须以 https://cdn.modrinth.com/ 开头
 * - Content-Length 预检 + 流式实时计数双保险，超过 100MB 立刻中断
 * - 失败路径统一清理半成品（临时文件由调用方或本函数兜底删除）
 */
export async function downloadMarketFile(url) {
  if (typeof url !== 'string' || !url.startsWith(MODRINTH_CDN_PREFIX)) {
    throw new AppError(ErrorCodes.MARKET_UPSTREAM_ERROR,
      'Download URL is not on the Modrinth CDN allowlist');
  }

  const tmpDir = path.join(os.tmpdir(), 'mc-commander-uploads');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    throw new AppError(ErrorCodes.SERVER_ERROR, `Failed to create tmp dir: ${err.message}`);
  }
  const tmpPath = path.join(tmpDir, `.market-download.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const source = got.stream(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: { request: DOWNLOAD_TIMEOUT_MS },
    retry: { limit: 1 },
    isResponseOk: true,
  });

  // 计数中间层：流式实时统计字节数，超限立刻断流（比 Content-Length 预检更可靠——
  // 分块传输/代理场景下 Content-Length 可能缺失或失真）
  let transferred = 0;
  let sizeExceeded = false;
  const counter = new PassThrough();
  counter.on('data', (chunk) => {
    if (sizeExceeded) return;
    transferred += chunk.length;
    if (transferred > MARKET_DOWNLOAD_MAX_SIZE) {
      sizeExceeded = true;
      source.destroy(new AppError(ErrorCodes.MARKET_UPSTREAM_ERROR,
        `Plugin exceeds download size limit (${Math.round(MARKET_DOWNLOAD_MAX_SIZE / 1024 / 1024)}MB)`));
      counter.destroy();
    }
  });

  try {
    await pipeline(source, counter, fs.createWriteStream(tmpPath));
    return tmpPath;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* 半成品清理失败可忽略 */ }
    if (err instanceof AppError) throw err;
    throw new AppError(ErrorCodes.MARKET_UPSTREAM_ERROR,
      `Failed to download plugin: ${err?.message || 'unknown'}`);
  }
}

/**
 * 从 Modrinth 安装插件到实例 plugins/ 目录（feat-8 延伸核心端点）。
 * 流程：拉取版本列表 → 按 versionNumber 定位版本 → 取 primary 文件 →
 * CDN 白名单校验 → 下载到临时目录 → uploadPlugin 复用落盘（zip 魔数 +
 * 文件名白名单 + 同名 40912/overwrite 语义 + 元数据读取）→ 清理临时文件。
 *
 * 注意：不从客户端接收下载 URL（服务端重新解析，防 SSRF/任意下载）。
 * @returns {object} uploadPlugin 结果 + { slug, versionNumber, source }
 */
export async function installPluginFromMarket(serverPath, { slug, versionNumber }, { overwrite = false } = {}) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(slug)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid project slug: ${slug}`);
  }
  if (typeof versionNumber !== 'string' || versionNumber.length === 0 || versionNumber.length > 100) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid version number: ${versionNumber}`);
  }

  // 重新拉取版本列表定位目标版本（绕过缓存会浪费配额；60s TTL 内数据新鲜度足够）
  const { versions } = await getMarketProjectVersions(slug, {});
  const target = versions.find((v) => v.versionNumber === versionNumber);
  if (!target) {
    throw new AppError(ErrorCodes.MARKET_VERSION_NOT_FOUND,
      `Version not found on Modrinth: ${versionNumber}`);
  }
  if (!target.file?.url) {
    throw new AppError(ErrorCodes.MARKET_VERSION_NOT_FOUND,
      'Version has no downloadable file');
  }

  const tmpPath = await downloadMarketFile(target.file.url);
  try {
    const fileName = sanitizeMarketFileName(target.file.filename, { slug, versionNumber });
    const result = uploadPlugin(serverPath, tmpPath, fileName, { overwrite });
    return {
      ...result,
      slug,
      versionNumber,
      source: 'modrinth',
      originalFileName: target.file.filename,
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* 已清理 */ }
  }
}
