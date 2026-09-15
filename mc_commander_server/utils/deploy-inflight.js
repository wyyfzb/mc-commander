/**
 * 在途部署注册表读取判据（单一事实源）：注册表由 routes/server-jar.js 写入，
 * WS 连接补发与 GET /instances/deploy/status 两个出口必须同口径——一处过滤死快照、
 * 另一处照发，前端会据补发恢复出一个早已结束的「部署中」视图。
 */

/**
 * 在途快照时限（15 分钟）：下载 + Forge 安装（120s）+ 首启（60s）的实测上限远低于此。
 * 超时未更新的在途快照视为死快照（进程崩溃/被重启打断，终态清理未执行），
 * 否则前端会永久卡在「部署中」而无法再次发起部署。
 */
export const MAX_INFLIGHT_DEPLOY_AGE_MS = 15 * 60 * 1000;

/**
 * 未过期的在途部署条目。updatedAt 缺失按死快照处理：注册表只由 trackDeployProgress
 * 写入且恒带该字段，无该字段的条目无法判龄，放行等于绕过上面的兜底时限。
 */
export function inFlightDeploys(serverManager) {
  const now = Date.now();
  const fresh = [];
  for (const dep of serverManager.activeDeploys?.values() ?? []) {
    if (now - (dep.updatedAt ?? 0) > MAX_INFLIGHT_DEPLOY_AGE_MS) continue;
    fresh.push(dep);
  }
  return fresh;
}

/**
 * 最近一条在途快照（全局至多一条：部署实例尚未入库，
 * 面板同一时刻只呈现一个部署进度视图）。
 */
export function latestInFlightDeploy(serverManager) {
  let latest = null;
  for (const dep of inFlightDeploys(serverManager)) {
    if (!latest || dep.updatedAt > latest.updatedAt) latest = dep;
  }
  return latest;
}

/** 服务端是否确有部署在途（POST /instances/deploy 的重复部署门控与 GET 端点共用） */
export function isDeployInFlight(serverManager) {
  return latestInFlightDeploy(serverManager) !== null;
}
