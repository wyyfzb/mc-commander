/**
 * vitest 全局准备/收尾（服务端包）
 *
 * 动因：`test.env` 里那个运行根原本是固定目录、刻意跨轮复用（便于排查），代价是每轮留下的
 * SQLite 夹具库会一直堆积（实测残留 1.3 MB）。现改为**按进程分子目录**：每进程一个
 * `mc-commander-server-vitest-<pid>`，起手清空自己在用的那个、收尾删掉它——同包两轮并发时
 * 各自操作各自的目录，既不相撞也不会像删固定根那样在 Windows 上因句柄占用硬中止。
 *
 * 顺带回收：起手把**同前缀、且其 pid 已不存在**的陈旧根清掉（崩溃轮次的残留），
 * 以及各测试文件在 tmpdir 下自建、早已无人回收的夹具目录（见 sweepStaleSiblings）。
 * 排查现场需要保留时：`KEEP_TEST_TMP=1 npm test`（下一轮起手仍会清掉它，故请当轮自取）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

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

/**
 * 回收范围＝**本仓测试源码里出现过的 tmpdir 前缀**（现场提取，不写死前缀表）。
 * 判据是**年龄**而不是「是否为空」：实测堆积的大头恰恰是**非空**目录
 * （`mc-manager-test-*` / `mc-stats-collector-test-*` 这类里的 SQLite 夹具库与 `-wal` 可达 MB 级），
 * 只看空目录回收不到它们。
 *
 * 为什么提取而不是宽泛匹配：`mc-` 是通用缩写，直接通配会命中其它工具在 TMP 下的目录；
 * 写死一张前缀表又会在新增测试时静默失效。提取口径 = 源码里 `tmpdir(), '前缀'` 的字面量，
 * 且要求**含连字符**（排除 `world`/`servers`/`inst1` 这类通用词做目录名的情况）。
 *
 * 残留（据实记录）：一轮挂起超过年龄门仍在用自己目录的极端情况会被另一轮删掉——
 * 名内不带 pid 无法判活，Windows 上多被句柄占用挡回；正常并发（一轮约 1 分钟）不受影响。
 */
const SIBLING_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const SIBLING_KEEP = 1000; // 异常情况下的兜底上限（单轮最多回收量；到顶会报出剩余数）

function collectFixturePrefixes() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const prefixes = new Set();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!file.endsWith('.js') || file === 'global-setup.js') continue;
    let src = '';
    try {
      src = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/tmpdir\(\)\s*,\s*'([^']+)'/g)) {
      if (m[1].includes('-')) prefixes.add(m[1]);
    }
  }
  return [...prefixes];
}

function sweepStaleSiblings(now) {
  const prefixes = collectFixturePrefixes();
  let entries = [];
  try {
    entries = fs.readdirSync(TMP);
  } catch {
    return { swept: 0, remaining: 0 };
  }
  const isFixture = (name) => prefixes.some((p) => name.startsWith(p));
  const stale = entries.filter((name) => {
    if (!isFixture(name)) return false;
    let stat;
    try {
      stat = fs.statSync(path.join(TMP, name));
    } catch {
      return false;
    }
    return stat.isDirectory() && now - stat.mtimeMs >= SIBLING_MIN_AGE_MS;
  });

  let swept = 0;
  for (const name of stale) {
    if (swept >= SIBLING_KEEP) break;
    try {
      rmDir(path.join(TMP, name));
      swept += 1;
    } catch {
      // 占用中则留待下次
    }
  }
  return { swept, remaining: stale.length - swept };
}

/* vitest globalSetup 在测试进程内执行、不属于服务端运行时——运行时的日志收口
   （utils/logger.js 的分级过滤与轮转）在这里不适用，输出直接走测试进程控制台 */
/* eslint-disable no-console */

export function setup() {
  const root = ownRoot();
  rmDir(root);
  fs.mkdirSync(root, { recursive: true });
  const sweptRoots = sweepStaleRoots();
  const { swept: sweptSiblings, remaining } = sweepStaleSiblings(Date.now());
  const swept = sweptRoots + sweptSiblings;
  if (swept > 0) {
    const tail = remaining > 0 ? `，另有 ${remaining} 个留待下轮` : '';
    console.log(
      `[vitest] 已回收 ${swept} 个陈旧目录（运行根 ${sweptRoots} / per-test 夹具目录 ${sweptSiblings}）${tail}`,
    );
  }
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
