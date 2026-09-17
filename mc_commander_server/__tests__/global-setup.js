/**
 * vitest 全局准备/收尾（服务端包）
 *
 * 动因：`test.env` 里那个运行根原本是固定目录、刻意跨轮复用（便于排查），代价是每轮留下的
 * SQLite 夹具库会一直堆积（实测残留 1.3 MB）。现改为**按进程分子目录**：每进程一个
 * `mc-commander-server-vitest-<pid>`，起手清空自己在用的那个、收尾删掉它——同包两轮并发时
 * 各自操作各自的目录，既不相撞也不会像删固定根那样在 Windows 上因句柄占用硬中止。
 *
 * 顺带回收：起手把**同前缀、且其 pid 已不存在**的陈旧根清掉（崩溃轮次的残留）。
 * 排查现场需要保留时：`KEEP_TEST_TMP=1 npm test`（下一轮起手仍会清掉它，故请当轮自取）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT_PREFIX = 'mc-commander-server-vitest-';
const TMP = os.tmpdir();

/** 本进程的运行根：与 vitest.config.js 同源（那里把 DATA_DIR/SERVERS_DIR/BACKUPS_DIR 挂进来） */
function ownRoot() {
  const fromEnv = process.env.MCS_TEST_TMP;
  if (fromEnv) return fromEnv;
  return path.join(TMP, `${ROOT_PREFIX}${process.pid}`);
}

/** 删目录：Windows 上残留句柄/杀软扫描会让 rmSync 抛 EBUSY/EPERM，故给重试 */
function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** 该 pid 是否还活着（EPERM = 存在但无权限，同样算活着） */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 回收同前缀的陈旧根：只清 pid 已不存在的那些，不动其他在跑的进程 */
function sweepStaleRoots() {
  let entries = [];
  try {
    entries = fs.readdirSync(TMP);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of entries) {
    // 旧版固定名（带 pid 之前的写法）不在前缀扫描里，单独收一次
    if (name === 'mc-commander-server-vitest') {
      try {
        rmDir(path.join(TMP, name));
        swept += 1;
      } catch {
        // 占用中则留待下次
      }
      continue;
    }
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const pid = Number(name.slice(ROOT_PREFIX.length));
    if (!Number.isInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
    try {
      rmDir(path.join(TMP, name));
      swept += 1;
    } catch {
      // 单个清理失败不阻塞本轮（例如仍被别的句柄占用）
    }
  }
  return swept;
}

/* vitest globalSetup 在测试进程内执行、不属于服务端运行时——运行时的日志收口
   （utils/logger.js 的分级过滤与轮转）在这里不适用，输出直接走测试进程控制台 */
/* eslint-disable no-console */

export function setup() {
  const root = ownRoot();
  rmDir(root);
  fs.mkdirSync(root, { recursive: true });
  const swept = sweepStaleRoots();
  if (swept > 0) console.log(`[vitest] 已回收 ${swept} 个陈旧运行目录`);
}

export function teardown() {
  const root = ownRoot();
  if (process.env.KEEP_TEST_TMP === '1') {
    console.log(`[vitest] KEEP_TEST_TMP=1：保留运行目录 ${root}（下一轮起手会清掉它）`);
    return;
  }
  try {
    rmDir(root);
  } catch (e) {
    // 清理失败不该伪装成测试失败，但也不能静默——留下目录与原因
    console.warn(`[vitest] 运行目录清理失败（${root}）：${e?.code ?? e?.message ?? e}`);
  }
}
