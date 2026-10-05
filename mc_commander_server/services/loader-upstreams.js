/**
 * 加载器上游（fabric / purpur / …）的版本与构建发现——`minecraft-core` 的原生替代。
 *
 * 为什么要有它：部署路径此前把版本列表与构建解析委托给 `minecraft-core`（`getVersions` /
 * `getLatestBuild` / `downloadServer`），而升级路径是直连上游的。同一个事实两种取法，
 * 于是有了两套夹具、两套哈希可得性，以及一条「库内自取时面板侧的体积上限与域白名单都不生效」
 * 的边界（URL 不经过本仓，断言不到）。本模块把上游调用收回本仓。
 *
 * 形态依据（**打真实请求核过，不是照记忆写的**）：
 * - fabric：`GET https://meta.fabricmc.net/v2/versions/game` → `[{ version, stable }]`，**由新到旧**；
 *   快照与 rc 也在列表里，`stable` 为 `false`。
 * - purpur：`GET https://api.purpurmc.org/v2/purpur` → `{ project, metadata: { current }, versions: [...] }`，
 *   **由旧到新**（与 fabric 相反，取用时必须显式反向）。
 */

import { httpJson } from '../utils/http-client.js';

/** 上游请求超时与重试口径：与 vanilla 解析保持一致，避免各写一份 */
const UPSTREAM_OPTIONS = { timeoutMs: 15000, retryLimit: 2 };

/** fabric 的游戏版本列表（只取正式版，由新到旧；上限与其它类型统一为 30） */
export async function listFabricGameVersions(limit = 30) {
  const data = await httpJson('https://meta.fabricmc.net/v2/versions/game', UPSTREAM_OPTIONS);
  return (Array.isArray(data) ? data : [])
    .filter((v) => v?.stable === true && typeof v.version === 'string')
    .slice(0, limit)
    .map((v) => v.version);
}

/** purpur 的版本列表（上游由旧到新，这里反向后取前 limit 个） */
export async function listPurpurVersions(limit = 30) {
  const data = await httpJson('https://api.purpurmc.org/v2/purpur', UPSTREAM_OPTIONS);
  const versions = Array.isArray(data?.versions) ? data.versions : [];
  return versions
    .filter((v) => typeof v === 'string')
    .reverse()
    .slice(0, limit);
}

/**
 * purpur 的下载地址与摘要。
 *
 * 摘要只在 `/latest` 响应的**顶层 `md5`** 字段里（实测与真实 jar 字节一致），下载直链本身不带
 * 摘要 ⇒ 必须先查 `/latest` 才能校验；查不到就降级为无摘要（不阻断部署，也不拿别的字段顶替）。
 *
 * 下载用 `latest.build` 拼**具体构建号**而不是 `/latest/download`：否则「查询到的摘要」与
 * 「实际下载的构建」可能不是同一个（中间有新构建发布就会错位，对正常文件报完整性失败）。
 */
export async function resolvePurpurDownload(mcVersion) {
  const latest = await httpJson(
    `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest`,
    UPSTREAM_OPTIONS,
  );
  const digest = latest?.md5;
  const url =
    latest?.build != null
      ? `https://api.purpurmc.org/v2/purpur/${mcVersion}/${latest.build}/download`
      : `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`;
  return { url, expectedHash: digest ? { algorithm: 'md5', digest } : null };
}

/**
 * fabric 服务端 jar 的下载地址。
 *
 * 上游给的是**按 loader 版本拼出来的固定路径**，没有独立的构建查询接口，也**不提供摘要**
 * ⇒ 返回的 `expectedHash` 恒为 `null`（如实表达「上游没给」，而不是拿别的字段凑一个）。
 * `loader` 省略时用一个已知可用的默认值——loader 版本由请求带上来，缺失时不该让整条部署失败。
 */
export async function resolveFabricDownload(mcVersion, loaderVersion) {
  const loader = loaderVersion || '0.16.10';
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader}/1.0.1/server/jar`,
    expectedHash: null,
  };
}

/** forge 的 promotions（推荐/最新构建号）——版本列表端点也在读同一份 */
const FORGE_PROMOTIONS_URL =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

/**
 * forge 安装器的下载地址。
 *
 * forge 没有「构建详情」接口：它的构建号在 promotions 里，下载地址是按
 * `<mcVersion>-<forgeVersion>` 拼出来的 maven 路径。优先 `recommended`，没有则 `latest`
 * （与 forge 自己的推荐口径一致）。
 *
 * ⚠️ 上游**不提供摘要** ⇒ `expectedHash` 恒为 `null`（如实表达，而不是拿别的字段凑一个）。
 *
 * @returns {Promise<{ url: string, expectedHash: null }>} 找不到该 MC 版本的 forge 构建时抛错
 */
export async function resolveForgeInstallerDownload(mcVersion) {
  const data = await httpJson(FORGE_PROMOTIONS_URL, UPSTREAM_OPTIONS);
  const promos = data?.promos ?? {};
  const forgeVersion = promos[`${mcVersion}-recommended`] ?? promos[`${mcVersion}-latest`];
  if (!forgeVersion) throw new Error(`No Forge build found for ${mcVersion}`);
  return {
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`,
    expectedHash: null,
  };
}
