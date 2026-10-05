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
