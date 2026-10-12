// 主机资源采集共享实现（system-stats 广播与 metrics 落库共用单一来源）：
// CPU 为 loadavg/核数 近似（避免复制 /proc/stat 状态机；status.js 的 Linux
// /proc 版本按端点独立维护），内存/负载/运行时长取自 os 模块，磁盘按
// serversDir/dataDir/backupsDir 三个数据目录聚合（10s 缓存，复用挂载点取
// 使用率最高者为主盘）。全部为纯 Node 读数，无子进程开销。
import os from 'os';
import fs from 'fs';
import config from '../config.js';

const diskCache = { ts: 0, result: null };

/** 清空磁盘缓存（测试隔离；生产无调用方——10s 窗口自然过期） */
export function resetSystemStatsCache() {
  diskCache.ts = 0;
  diskCache.result = null;
}

function getDiskUsage() {
  const now = Date.now();
  if (diskCache.result && now - diskCache.ts < 10_000) return diskCache.result;
  const dirs = [config.serversDir, config.dataDir, config.backupsDir];
  const seen = new Map();
  for (const dir of dirs) {
    try {
      const stat = fs.statfsSync(dir);
      const total = stat.bsize * stat.blocks;
      const free = stat.bsize * stat.bfree;
      const used = total - free;
      const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      const entry = {
        mountpoint: stat.mounted || dir,
        totalGB: Math.round((total / (1024 * 1024 * 1024)) * 10) / 10,
        usedGB: Math.round((used / (1024 * 1024 * 1024)) * 10) / 10,
        percent,
      };
      // 同一挂载点多目录取使用率最高者（最紧张口径）
      if (!seen.has(entry.mountpoint) || entry.percent > seen.get(entry.mountpoint).percent) {
        seen.set(entry.mountpoint, entry);
      }
    } catch {
      /* 目录不可用时跳过 */
    }
  }
  const all = Array.from(seen.values());
  const primary = all.sort((a, b) => b.percent - a.percent)[0] || null;
  const result = { primary, all };
  diskCache.ts = now;
  diskCache.result = result;
  return result;
}

function getCpuUsage() {
  const cores = os.cpus().length || 1;
  const load = os.loadavg()[0] || 0;
  return Math.min(100, Math.round((load / cores) * 100 * 10) / 10);
}

/** 主机资源读数（与 WS systemStatsUpdate 载荷同构） */
export function collectSystemStats() {
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = totalMemBytes - freeMemBytes;
  const totalMemGB = Math.round((totalMemBytes / (1024 * 1024 * 1024)) * 10) / 10;
  const usedMemGB = Math.round((usedMemBytes / (1024 * 1024 * 1024)) * 10) / 10;
  const memUsagePercent =
    totalMemBytes > 0 ? Math.round((usedMemBytes / totalMemBytes) * 1000) / 10 : 0;
  return {
    cpuUsage: getCpuUsage(),
    memoryUsage: usedMemGB,
    totalMemory: totalMemGB,
    memoryPercent: memUsagePercent,
    cpuCores: os.cpus().length,
    loadAvg: os.loadavg(),
    uptime: os.uptime(),
    diskUsage: getDiskUsage(),
    // 阈值随读数一并下发：前端是告警的裁决者，让它自己写一份数字必然与部署配置漂移
    diskAlert: config.diskAlert,
    // 内存阈值同理随 `memoryPercent` 一并下发（同一份读数、同一个来源，不必前端各判一次）
    memoryAlert: config.memoryAlert,
  };
}
