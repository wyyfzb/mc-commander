/**
 * 性能快照采集域：经 RCON 触发 `/perf` 或 `/jfr`，把落地产物读成一次结论。
 *
 * 两条命令都是**一次性取样**，不是持续监控：`/perf start` 固定采 10 秒后自己压包落地，
 * `/jfr` 从 start 到 stop 之间录制。所以面板这里的形态是「点一次 → 等窗口 → 出结论」，
 * 界面上必须说清这是一次取样（见 perf.ts 契约的 windowMs）。
 *
 * 产物落点是**命令自己写的**，回包不携带可靠路径，故不能靠回包判断成败：
 * - `/perf start` 立刻回一句「已开始」，ZIP 在 10 秒后才出现在 `debug/profiling/`；
 * - `/perf stop` 提前终止时回包是**空串**，但 ZIP 照常生成；
 * - `/jfr stop` 的回包带文件名（`dumped to debug/server-<时间戳>.jfr`），可用来定位，
 *   但同一次 stop 还会另写一份 `jfr-report-server-<时间戳>.json`（回包不提它）。
 * 故本域一律「采集前记录目录快照 → 采集后取新增文件」，不解析回包里的路径。
 *
 * 命令在旧版本上不存在时的回包是 `Unknown or incomplete command`（实测 26.3 对 `perf`
 * 裸命令如此），必须显式识别并报「该版本不支持」，不能当成采集成功等一个永远不会来的文件。
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { logger } from '../../utils/logger.js';
import {
  countCsvRows,
  deriveJfrVerdict,
  derivePerfVerdict,
  extractTickHotspots,
  parseJfrSummaryJson,
  parseProfilingTxt,
  parseSingleColumnCsv,
  parseStatsTxt,
  parseSystemTxt,
  summarizeHeap,
} from './perf-parse.js';

/**
 * 服务端侧 `/perf` 的固定窗口（命令自身写死 10 秒，面板无从缩短或延长）。
 * 导出是因为它带下界语义：落地等待必须覆盖它，改小了会在窗口还没走完时就判超时。
 */
export const PERF_SERVER_WINDOW_MS = 10_000;
/** 等 ZIP 落地的上限：窗口 10 秒 + 压缩与磁盘写入，留三倍余量 */
export const PERF_DONE_TIMEOUT_MS = 30_000;
/**
 * JFR 录制窗口。
 *
 * 下界由采样粒度决定：JFR 的 tick 采样约每秒一条，窗口太短则事件数不足，分位字段会
 * 退化成同一个值（实测 452 ms 的录制里 p50=p75=p90=p99=max，当分布看就是错的）。
 * 导出是为了让「窗口不得低于下界」这条性质有用例守着——它不是可随手调小的魔数。
 */
export const JFR_WINDOW_MS = 15_000;
/** 等 summary 落地的上限 */
export const JFR_DONE_TIMEOUT_MS = 20_000;
/** 轮询间隔：产物是「几十 KB 的文件出现」，500 ms 足够且不会把磁盘打满 */
const POLL_INTERVAL_MS = 500;

const PROFILING_DIR = path.join('debug', 'profiling');
const DEBUG_DIR = 'debug';

/** 旧版本/无权限时 MC 的三种拒绝措辞（`perf` 与 `jfr` 裸命令实测都回第一种） */
const UNSUPPORTED_PATTERNS = [
  /unknown or incomplete command/i,
  /unknown command/i,
  /incorrect argument/i,
];

/**
 * 命令是否被这个服务端版本拒绝。
 * 与「命令执行失败」区分：这里要回答的是「有没有这条命令」，据此决定报不支持还是报采集失败。
 */
export function isUnsupportedResponse(response) {
  if (typeof response !== 'string') return false;
  return UNSUPPORTED_PATTERNS.some((re) => re.test(response));
}

/** 列目录（不存在返回空数组）：采集前后各取一次，差集即本次新增的产物 */
export function listDirNames(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

/**
 * 在候选里挑出「不在基线中、且 mtime 不早于基线时刻」的最新一项。
 *
 * `accept` 是必备的收尾过滤而不是可选优化：服务端压包时先写 `<最终名>_tmp` 再改名，
 * 只按「目录里多了什么文件」判定会选中那个写到一半的临时文件（实测真机取到
 * `…-world-26_3.zip_tmp`，解出来是空的）。能锚的只有**最终形态**本身。
 */
export function pickNewestArtifact(dirPath, names, baseline, notBeforeMs, accept) {
  const candidates = [];
  for (const name of names) {
    if (baseline.has(name)) continue;
    if (!accept(name)) continue;
    const full = path.join(dirPath, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (notBeforeMs != null && stat.mtimeMs < notBeforeMs) continue;
      candidates.push({ name, mtimeMs: stat.mtimeMs });
    } catch {
      // 并发删除：这一项已经不在了，跳过即可，不影响其余候选
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].name;
}

/** 产物只认最终形态：perf 的包是 `.zip`（临时名带 `_tmp` 后缀），JFR 的报告是 `jfr-report-*.json` */
const acceptPerfArchive = (name) => name.endsWith('.zip');
const acceptJfrReport = (name) => name.startsWith('jfr-report-') && name.endsWith('.json');

/**
 * 轮询等待 predicate 返回真值；超时返回 null。用轮询而不是 fs.watch：
 *  产物由另一个进程写入，watch 在「目录刚被创建」时会丢事件，轮询的失败面只有一个「等不到」。 */
async function waitForArtifact(probe, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 把 ZIP 读成可判断的指标。
 * 任何一个条目读不出来都只记一条 warning 并把该指标留空——半份产物仍是证据，
 * 整份丢弃会让用户拿不到「已经取到的部分」。
 */
export function readPerfArchive(zipPath) {
  const warnings = [];
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    return {
      detail: emptyPerfDetail(),
      warnings: [`性能快照包无法打开：${e.message}`],
    };
  }

  const readEntry = (name) => {
    const entry = zip.getEntry(name);
    if (!entry) return null;
    try {
      return zip.readAsText(entry);
    } catch {
      warnings.push(`产物内 ${name} 读取失败`);
      return null;
    }
  };

  const systemTxt = readEntry('system.txt');
  const system = systemTxt ? parseSystemTxt(systemTxt) : null;
  if (!systemTxt) warnings.push('产物内缺少 system.txt，版本与堆上限无从得知');

  const statsTxt = readEntry('server/stats.txt');
  const stats = statsTxt ? parseStatsTxt(statsTxt) : null;
  if (!statsTxt) warnings.push('产物内缺少 server/stats.txt，单刻耗时无从得知');

  const profilingTxt = readEntry('server/profiling.txt');
  const profiling = profilingTxt ? parseProfilingTxt(profilingTxt) : null;
  if (!profilingTxt) warnings.push('产物内缺少 server/profiling.txt，热点分布无从得知');

  const jvmCsv = readEntry('server/metrics/jvm.csv');
  const heapSamples = jvmCsv ? parseSingleColumnCsv(jvmCsv) : [];
  if (!jvmCsv) warnings.push('产物内缺少 server/metrics/jvm.csv，堆曲线无从得知');

  const tick =
    stats && stats.averageMs != null
      ? {
          averageMs: stats.averageMs,
          p99Ms: stats.p99Ms,
          maxMs: stats.maxMs,
          samples: stats.samples,
          tickSpan: profiling?.tickSpan ?? null,
          timeSpanMs: profiling?.timeSpanMs ?? null,
          ticksPerSecond: profiling?.ticksPerSecond ?? null,
        }
      : null;
  if (stats && stats.averageMs == null) {
    warnings.push('server/stats.txt 里没有可解析的 average_tick_time');
  }

  const heap = summarizeHeap(heapSamples, system?.heapMaxMiB ?? null);

  // 维度清单从 levels/ 下的目录名取，不写死三个：模组可以新增维度。
  // 命名空间也必须从产物里取——模组维度的目录是 `levels/<命名空间>/<维度>/`，
  // 回读时写死 `minecraft/` 会让这些维度静默变成 0 区块 0 实体。
  const dimensions = [];
  for (const entry of zip.getEntries()) {
    const match = /^(server\/levels\/([^/]+)\/([^/]+))\/chunks\.csv$/.exec(entry.entryName);
    if (!match) continue;
    const dimPath = match[1];
    const namespace = match[2];
    const dimName = match[3];
    const chunksCsv = readEntry(`${dimPath}/chunks.csv`);
    const entitiesCsv = readEntry(`${dimPath}/entities.csv`);
    dimensions.push({
      // 非默认命名空间要带出来：两个模组各有一个 `lobby` 维度时，裸名会让界面出现两行同名
      name: namespace === 'minecraft' ? dimName : `${namespace}:${dimName}`,
      chunks: chunksCsv ? countCsvRows(chunksCsv) : 0,
      entities: entitiesCsv ? countCsvRows(entitiesCsv) : 0,
    });
  }

  return {
    detail: {
      mcVersion: system?.mcVersion ?? null,
      javaVersion: system?.javaVersion ?? null,
      cpus: system?.cpus ?? null,
      processCpuPercent: system?.processCpuPercent ?? null,
      tick,
      heap,
      hotspots: profiling ? extractTickHotspots(profiling.nodes) : [],
      dimensions,
    },
    warnings,
  };
}

function emptyPerfDetail() {
  return {
    mcVersion: null,
    javaVersion: null,
    cpus: null,
    processCpuPercent: null,
    tick: null,
    heap: null,
    hotspots: [],
    dimensions: [],
  };
}

function emptyJfrDetail() {
  return {
    durationMs: 0,
    gcCount: null,
    gcOverheadPercent: null,
    gcTotalDurationMs: null,
    allocationRateMiBPerSecond: null,
    cpuJvmAveragePercent: null,
    tickAverageMs: null,
    tickMaxMs: null,
  };
}

/** 读 JFR summary；解析不出时返回全空 detail + 一条 warning，由判定层报「读不出可判断的指标」 */
export function readJfrReport(jsonPath) {
  let text;
  try {
    text = fs.readFileSync(jsonPath, 'utf-8');
  } catch (e) {
    return { detail: emptyJfrDetail(), warnings: [`JFR summary 读取失败：${e.message}`] };
  }
  const parsed = parseJfrSummaryJson(text);
  if (!parsed) {
    return {
      detail: emptyJfrDetail(),
      warnings: ['JFR summary 不是可解析的 JSON，GC 与分配数据无从得知'],
    };
  }
  const warnings = [];
  if (parsed.durationMs == null) warnings.push('JFR summary 缺少录制时长');
  return {
    detail: {
      durationMs: parsed.durationMs ?? 0,
      gcCount: parsed.gcCount,
      gcOverheadPercent: parsed.gcOverheadPercent,
      gcTotalDurationMs: parsed.gcTotalDurationMs,
      allocationRateMiBPerSecond: parsed.allocationRateMiBPerSecond,
      cpuJvmAveragePercent: parsed.cpuJvmAveragePercent,
      tickAverageMs: parsed.tickAverageMs,
      tickMaxMs: parsed.tickMaxMs,
    },
    warnings,
  };
}

/** 采集期错误：带一个语义类别，路由据此挑错误码与文案 */
export class PerfCaptureError extends Error {
  /**
   * @param {'unsupported'|'timeout'|'not-running'|'no-rcon'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'PerfCaptureError';
    this.kind = kind;
  }
}

/** 实例上是否具备走这条通道的条件；不满足时抛带类别的错误，由路由翻译成 HTTP 语义 */
function assertChannel(instance) {
  if (!instance.isRunning) {
    throw new PerfCaptureError('not-running', '实例未在运行');
  }
  if (!instance.isRconConnected) {
    throw new PerfCaptureError('no-rcon', 'RCON 未启用或连接已断开');
  }
}

/**
 * 取一次性能快照。
 * @param {object} instance MCServerInstance（需要 serverPath / isRunning / isRconConnected / sendCommandWithResponse）
 * @param {{ kind?: 'perf'|'jfr' }} [options]
 * @returns {Promise<object>} 与 perfSnapshotResponseSchema 同形（不含信封）
 */
export async function collectSnapshot(instance, { kind = 'perf' } = {}) {
  assertChannel(instance);
  const serverPath = instance.serverPath;
  const debugDir = path.join(serverPath, DEBUG_DIR);
  // 产物落地失败时命令仍可能回包成功（`/perf stop` 的提前终止就是空串），
  // 目录存在性是这个不确定性里唯一能提前消掉的一项
  fs.mkdirSync(debugDir, { recursive: true });

  const send = (command) =>
    instance.sendCommandWithResponse(command, { timeout: 10_000 }).catch((err) => {
      // 回包超时不等于命令没执行（RCON 的响应超时语义），交给落地轮询去判定成败；
      // 但通道整体不可用时没有可等的对象，直接抛出去让用户看到原因
      if (err && /RCON is not connected/i.test(err.message)) {
        throw new PerfCaptureError('no-rcon', 'RCON 未启用或连接已断开');
      }
      logger.warn(`[${instance.id}] 性能快照命令无回包:`, err.message);
      return '';
    });

  if (kind === 'jfr') return collectJfr(instance, send, serverPath);
  return collectPerf(instance, send, serverPath);
}

async function collectPerf(instance, send, serverPath) {
  const profilingDir = path.join(serverPath, PROFILING_DIR);
  const baseline = new Set(listDirNames(profilingDir));
  const startedAt = Date.now();

  const startResponse = await send('perf start');
  if (isUnsupportedResponse(startResponse)) {
    throw new PerfCaptureError(
      'unsupported',
      '该服务端版本不支持性能快照（/perf），请升级到带 /perf 的版本',
    );
  }

  const fileName = await waitForArtifact(
    () =>
      pickNewestArtifact(
        profilingDir,
        listDirNames(profilingDir),
        baseline,
        startedAt - 1000,
        acceptPerfArchive,
      ),
    PERF_DONE_TIMEOUT_MS,
  );
  if (!fileName) {
    throw new PerfCaptureError(
      'timeout',
      `等待性能快照包超时（${Math.round(PERF_DONE_TIMEOUT_MS / 1000)} 秒内未在 ${PROFILING_DIR} 出现新文件）`,
    );
  }

  const archiveAbs = path.join(profilingDir, fileName);
  const { detail, warnings } = readPerfArchive(archiveAbs);
  const collectedAt = new Date().toISOString();
  return {
    kind: 'perf',
    collectedAt,
    windowMs: detail.tick?.timeSpanMs ?? PERF_SERVER_WINDOW_MS,
    verdict: derivePerfVerdict({ tick: detail.tick, heap: detail.heap }),
    perf: detail,
    jfr: null,
    archivePath: path.join(PROFILING_DIR, fileName).split(path.sep).join('/'),
    parseWarnings: warnings,
  };
}

async function collectJfr(instance, send, serverPath) {
  const debugDir = path.join(serverPath, DEBUG_DIR);
  const baseline = new Set(listDirNames(debugDir));
  const startedAt = Date.now();

  const startResponse = await send('jfr start');
  if (isUnsupportedResponse(startResponse)) {
    throw new PerfCaptureError(
      'unsupported',
      '该服务端版本不支持 JFR 录制（/jfr），请升级到带 /jfr 的版本',
    );
  }
  // 已在录制中时 start 回「Failed to start JFR profiling」：不能当成开始成功，
  // 否则后面那次 stop 会把**别人**的录制停掉，并读到一个窗口对不上的 summary
  if (/failed to start/i.test(startResponse)) {
    throw new PerfCaptureError(
      'timeout',
      '服务器上已有一段 JFR 录制在进行中，请稍后再试（或先在控制台执行 jfr stop）',
    );
  }

  await new Promise((resolve) => setTimeout(resolve, JFR_WINDOW_MS));
  const stopResponse = await send('jfr stop');
  if (isUnsupportedResponse(stopResponse)) {
    throw new PerfCaptureError('unsupported', '该服务端版本不支持 JFR 录制（/jfr）');
  }

  // 报告文件名带 start 时刻的时间戳，与 .jfr 主产物同批写出；按「新增的 report」定位，
  // 不解析 stop 回包里的路径（回包只提 .jfr，不提 report）
  const reportName = await waitForArtifact(
    () =>
      pickNewestArtifact(
        debugDir,
        listDirNames(debugDir),
        baseline,
        startedAt - 1000,
        acceptJfrReport,
      ),
    JFR_DONE_TIMEOUT_MS,
  );
  if (!reportName) {
    throw new PerfCaptureError(
      'timeout',
      `等待 JFR 报告超时（${Math.round(JFR_DONE_TIMEOUT_MS / 1000)} 秒内未在 ${DEBUG_DIR} 出现新的 jfr-report）`,
    );
  }

  const { detail, warnings } = readJfrReport(path.join(debugDir, reportName));
  return {
    kind: 'jfr',
    collectedAt: new Date().toISOString(),
    windowMs: detail.durationMs || JFR_WINDOW_MS,
    verdict: deriveJfrVerdict(detail),
    perf: null,
    jfr: detail,
    archivePath: path.join(DEBUG_DIR, reportName).split(path.sep).join('/'),
    parseWarnings: warnings,
  };
}

/*
 * 本域按普通模块函数导出、不做原型注入：采集不持有实例状态（每次都是「发命令 → 等产物 →
 * 读产物」），注入只会让它看起来像随实例生命周期存在的东西。
 */
