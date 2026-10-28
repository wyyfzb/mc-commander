/**
 * vanilla 构建解析的**唯一实现**：从 Mojang Piston manifest 取目标版本的 server jar 地址与摘要。
 *
 * 为什么要有这个模块：vanilla 构建解析全仓只有这一处实现，部署与升级共用它。
 * 两处各写一份必然分叉——两套夹具、两套哈希可得性（`artifact.hash || build.sha256 ||
 * build.sha1` 三级回退即此形态），而「读到哪个字段」会随上游形状漂移。这正是「测试夹具
 * 把错误形状固化成契约」这类失效模式的温床（本仓已因此出过两次生产缺陷）。
 *
 * 形态依据（对照真实响应核实）：
 * - manifest：`{ latest: { release }, versions: [{ id, type, url }] }`
 * - 每版详情：`{ downloads: { server: { url, sha1, size } } }`
 * - 摘要**只取 `sha1`**：Piston 对 server jar 给的就是 sha1，与升级路径既有口径一致。
 *   不再做多级回退——回退会让「读到哪个字段」随上游形状漂移，而校验一旦静默跳过，
 *   下载损坏就变成「装上了但起不来」。
 */

import { httpJson } from '../utils/http-client.js';

/** Piston 版本清单（唯一事实源） */
export const PISTON_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** 上游请求超时与重试口径：两处调用点共用，避免各写一份而漂移 */
const UPSTREAM_OPTIONS = { timeoutMs: 15000, retryLimit: 2 };

/** 取版本清单（部署的版本列表端点与构建解析共用） */
export async function fetchVanillaManifest() {
  return httpJson(PISTON_MANIFEST_URL, UPSTREAM_OPTIONS);
}

/**
 * 取 vanilla 服务端的下载地址与摘要。
 *
 * 只认 `type === 'release'`：快照/预发布不出现在面板的部署选项里，若按 id 命中快照会让
 * 用户部署到非正式版。
 *
 * @param {string} mcVersion 目标 MC 版本（如 `1.21.4`）
 * @returns {Promise<{ url: string, expectedHash: { algorithm: 'sha1', digest: string } | null }>}
 */
export async function resolveVanillaDownload(mcVersion) {
  const manifest = await fetchVanillaManifest();
  const versionEntry = manifest?.versions?.find((v) => v.id === mcVersion && v.type === 'release');
  if (!versionEntry?.url) throw new Error(`Vanilla version ${mcVersion} not found`);

  const detail = await httpJson(versionEntry.url, UPSTREAM_OPTIONS);
  const serverJar = detail?.downloads?.server;
  if (!serverJar?.url) throw new Error(`No server JAR download for ${mcVersion}`);

  return {
    url: serverJar.url,
    expectedHash: serverJar.sha1 ? { algorithm: 'sha1', digest: String(serverJar.sha1) } : null,
  };
}

/**
 * 取指定 MC 版本在 Mojang 版本元数据里声明的 Java 运行时组件（权威映射）。
 *
 * 面板自供 Java 时用它决定下载哪个 java-runtime 组件：组件名随版本变化
 * （1.16.5 是 jre-legacy、1.20.4 是 java-runtime-gamma、26.x 是 java-runtime-epsilon），
 * 只有版本元数据能给出权威值；取不到（快照未收录/上游字段变更）返回 null，由调用方查表。
 *
 * @param {string} mcVersion 目标 MC 版本
 * @returns {Promise<{ component: string, majorVersion: number } | null>}
 */
export async function resolveVanillaJavaRuntime(mcVersion) {
  const manifest = await fetchVanillaManifest();
  const versionEntry = manifest?.versions?.find((v) => v.id === mcVersion);
  if (!versionEntry?.url) return null;
  const detail = await httpJson(versionEntry.url, UPSTREAM_OPTIONS);
  const javaVersion = detail?.javaVersion;
  const component = javaVersion?.component;
  const majorVersion = javaVersion?.majorVersion;
  if (typeof component !== 'string' || component === '' || !Number.isInteger(majorVersion)) {
    return null;
  }
  return { component, majorVersion };
}

/**
 * 正式版列表（按清单顺序＝由新到旧），供部署对话框的版本选择器使用。
 * @param {number} limit 上限（端点历来只给前 30 个）
 */
export async function listVanillaReleases(limit = 30) {
  const manifest = await fetchVanillaManifest();
  return (manifest?.versions ?? [])
    .filter((v) => v.type === 'release')
    .slice(0, limit)
    .map((v) => v.id);
}
