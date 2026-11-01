/**
 * 性能快照解析域：把 `/perf` 的 ZIP 与 `/jfr` 的 summary JSON 读成结论。
 *
 * 本模块只有纯函数，不碰实例、不碰网络——采集动作在 perf-collect.js，解析与判定在这里，
 * 两者分开是为了让「真实产物长什么样」可以逐条被夹具锁住。
 *
 * 格式依据全部来自 26.3 真服产物（夹具见 tests/fixtures/perf/）：
 * - ZIP 内结构是 `system.txt` + `server/{profiling,stats,gamerules,...}.txt` +
 *   `server/metrics/{jvm,ticking,cpu,event-loops,consecutive-executors}.csv` +
 *   `server/levels/<命名空间>/<维度>/{chunks,entities,block_entities,entity_chunks,stats,example_crash}`。
 *   条目全部在 `server/` 下，不是 ZIP 根。
 * - `jvm.csv` 表头 `@tick,heap MiB`，每刻一行，口径是 **used** 堆（不是 committed）。
 * - `stats.txt` 的 `average_tick_time` 单位是 **毫秒**（实测 0.129312），`tick_times` 数组
 *   单位是 **纳秒**（同窗口均值 130599 ns ÷ 1e6 = 0.1306 ms，与前者对得上）。
 * - `ticking.csv` 是每刻的**墙钟间隔**，不是单刻耗时：同一次取样里它中位数 49.95 ms
 *   而真 MSPT 只有 0.163 ms（差 306 倍）。展示成耗时会凭空造出一台「快挂了」的服，
 *   故本模块**不读它**。
 * - `profiling.txt` 的树形段落每行以 `[NN]` 起头，NN 即深度；节点形如
 *   `name(调用次数/计数) - 父内占比%/全局占比%`，计数器行（`#runTask 1/0`）没有百分比。
 * - JFR summary 的数值位会出现 **非标准 JSON 字面量** `NaN` / `Infinity` / `-Infinity`
 *   （实测 26.3 产物各出现 9 / 7 / 3 次），Node 的 `JSON.parse` 遇之直接抛错，故必须先替换。
 * - JFR 的 `fps` 段在服务端恒为 0（无客户端），本模块不读该段。
 */

/** 单刻预算（毫秒）：20 TPS 即每刻 50 ms，超出就开始掉 TPS */
const MSPT_BUDGET_MS = 50;
/** 单刻耗时占掉一半预算：还没掉 TPS，但余量已经不多 */
const MSPT_WARNING_MS = 25;
/** 堆峰值占比：再涨就要靠频繁 GC 续命 */
const HEAP_WARNING_PERCENT = 75;
/** 堆峰值占比：接近上限，随时可能 OutOfMemoryError */
const HEAP_CRITICAL_PERCENT = 90;
/** GC 开销占比：官方 JVM 的默认告警线（GCTimeLimit）即 98%，这里取更保守的两档 */
const GC_OVERHEAD_WARNING_PERCENT = 10;
const GC_OVERHEAD_CRITICAL_PERCENT = 20;
/**
 * JFR 录制窗口下限：实测 452 ms 的短录制里分位字段与 GC 统计都退化
 * （p50/p75/p90/p99 全等于 max），不足该时长的结论只作参考。
 * 导出供用例构造「足够长的窗口」——夹具写死 15000 会在阈值上调时静默落进短窗口分支，
 * 于是「调阈值」看起来安全，实际是三条用例在测别的分支。
 */
export const JFR_MIN_USEFUL_MS = 5000;

/**
 * 把 JSON 文本里的 `NaN` / `Infinity` / `-Infinity` 换成 `null`。
 *
 * 必须逐字符走一遍而不是正则直替：这些词也可能是**字符串值**的一部分（如线程名、
 * 文件路径），正则替换会把字符串内容一起改掉。只有字符串外的裸 token 才是数值字面量。
 * 三个 token 里 `-Infinity` 含 `Infinity`，故先匹配负号，避免剩下一个孤立的 `-`。
 */
export function stripNonStandardJsonLiterals(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // 转义序列整体照抄：`\"` 不是字符串结束
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    // 带起点比对，不复制剩余全文
    if (text.startsWith('-Infinity', i)) {
      out += 'null';
      i += '-Infinity'.length;
      continue;
    }
    if (text.startsWith('Infinity', i)) {
      out += 'null';
      i += 'Infinity'.length;
      continue;
    }
    if (text.startsWith('NaN', i)) {
      out += 'null';
      i += 'NaN'.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 数字字段：非有限数（含替换后的 null）一律 null，不拿 0 顶替——0 是「量到了 0」 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 解析 JFR summary JSON。解析失败返回 null（调用方转成一条解析降级说明），不抛错：
 * 一份读不懂的产物不该让整次采集变成 500。
 */
export function parseJfrSummaryJson(text) {
  let data;
  try {
    data = JSON.parse(stripNonStandardJsonLiterals(text));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const heap = data.heap ?? {};
  const cpuJvm = data.cpuPercent?.jvm ?? {};
  const tick = data.serverTick ?? {};
  const allocBytesPerSecond = finiteOrNull(heap.allocationRateBytesPerSecond);
  return {
    durationMs: finiteOrNull(data.durationMs),
    gcCount: finiteOrNull(heap.gcCount),
    gcOverheadPercent: finiteOrNull(heap.gcOverHeadPercent),
    gcTotalDurationMs: finiteOrNull(heap.gcTotalDurationMs),
    allocationRateMiBPerSecond:
      allocBytesPerSecond == null ? null : allocBytesPerSecond / (1024 * 1024),
    cpuJvmAveragePercent: finiteOrNull(cpuJvm.average),
    tickAverageMs: finiteOrNull(tick.averageMs),
    tickMaxMs: finiteOrNull(tick.maxMs),
  };
}

/**
 * 解析 `server/stats.txt`。
 * `average_tick_time` 是毫秒，`tick_times` 是纳秒数组（同一窗口下均值 ÷ 1e6 才等于前者）。
 * `tick_times` 是定长环形缓冲（实测两份样本都是 100 条），故 p99 与 max 天然接近——
 * 它反映的是最近 100 刻，不是整个窗口。
 */
export function parseStatsTxt(text) {
  const avgMatch = /^average_tick_time:\s*([\d.eE+-]+)/m.exec(text);
  const timesMatch = /^tick_times:\s*\[([^\]]*)\]/m.exec(text);
  const tickTimesNs = timesMatch
    ? timesMatch[1]
        .split(',')
        .map((s) => Number.parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n))
    : [];
  const tickTimesMs = tickTimesNs.map((ns) => ns / 1e6).sort((a, b) => a - b);
  const averageMs = avgMatch ? Number.parseFloat(avgMatch[1]) : null;
  const p99Index = tickTimesMs.length > 0 ? Math.ceil(tickTimesMs.length * 0.99) - 1 : -1;
  return {
    averageMs: Number.isFinite(averageMs) ? averageMs : null,
    p99Ms: p99Index >= 0 ? tickTimesMs[p99Index] : null,
    maxMs: tickTimesMs.length > 0 ? tickTimesMs[tickTimesMs.length - 1] : null,
    samples: tickTimesMs.length,
  };
}

/** 解析单列 CSV（`@tick,<值>`），返回数值列 */
export function parseSingleColumnCsv(text) {
  const values = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('@')) continue;
    const value = Number.parseFloat(trimmed.split(',')[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** 解析 CSV 的数据行数（不含表头）：区块/实体清单只需要条数 */
export function countCsvRows(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim()) count += 1;
  }
  return Math.max(0, count - 1);
}

/**
 * 解析 `server/profiling.txt`。
 *
 * 只取两处：头部三行（窗口长度与 tick 速率）与 PROFILE DUMP 树。树的每行以 `[NN]` 起头，
 * NN 就是深度，不需要数 `|` 前缀——后者随格式微调就会错位。
 * 计数器行（`#runTask 1/0`）没有百分比，跳过：它们没有耗时语义。
 */
export function parseProfilingTxt(text) {
  const timeSpanMatch = /^Time span:\s*([\d.]+)\s*ms/m.exec(text);
  const tickSpanMatch = /^Tick span:\s*(\d+)\s*ticks/m.exec(text);
  const tpsMatch = /approximately\s+([\d.]+)\s+ticks per second/.exec(text);

  const nodes = [];
  const dumpStart = text.indexOf('--- BEGIN PROFILE DUMP ---');
  const dumpEnd = text.indexOf('--- END PROFILE DUMP ---');
  const dump =
    dumpStart >= 0 ? text.slice(dumpStart, dumpEnd > dumpStart ? dumpEnd : undefined) : '';
  for (const line of dump.split('\n')) {
    const depthMatch = /^\[(\d+)\]\s*(.*)$/.exec(line.trim());
    if (!depthMatch) continue;
    const depth = Number.parseInt(depthMatch[1], 10);
    const body = depthMatch[2].replace(/^\|[\s|]*/, '').trim();
    if (!body || body.startsWith('#')) continue;
    const nodeMatch = /^(.*?)\((\d+)\/(\d+)\)\s*-\s*([\d.]+)%\/([\d.]+)%$/.exec(body);
    if (!nodeMatch) continue;
    nodes.push({
      depth,
      name: nodeMatch[1].trim(),
      parentSharePercent: Number.parseFloat(nodeMatch[4]),
      globalSharePercent: Number.parseFloat(nodeMatch[5]),
    });
  }
  return {
    timeSpanMs: timeSpanMatch ? Number.parseFloat(timeSpanMatch[1]) : null,
    tickSpan: tickSpanMatch ? Number.parseInt(tickSpanMatch[1], 10) : null,
    ticksPerSecond: tpsMatch ? Number.parseFloat(tpsMatch[1]) : null,
    nodes,
  };
}

/**
 * tick 内部的热点分布：取 `tick` 节点的直接子节点，按「占 tick 的比例」排序。
 *
 * 用父内占比而不是全局占比：全局占比的分母含 `nextTickWait`（实测 99.85%），
 * 那个节点是「等下一刻」的空转，不是耗时来源；混在一起看会把真正的热点稀释成 0.0x%。
 */
export function extractTickHotspots(nodes, limit = 5) {
  const tickIndex = nodes.findIndex((n) => n.depth === 0 && n.name === 'tick');
  if (tickIndex < 0) return [];
  const tickDepth = nodes[tickIndex].depth;
  const children = [];
  for (let i = tickIndex + 1; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.depth <= tickDepth) break;
    if (node.depth === tickDepth + 1) children.push(node);
  }
  return children
    .sort((a, b) => b.parentSharePercent - a.parentSharePercent)
    .slice(0, limit)
    .map((n) => ({ name: n.name, sharePercent: n.parentSharePercent }));
}

/**
 * 解析 `system.txt`：版本、CPU 核数、堆上限与进程 CPU。
 *
 * `Process Loads` 的百分比是**进程自启动以来的平均占用**（单核口径），不是窗口瞬时值——
 * 拿它当「现在 CPU 多高」会在一台空转的服上读到启动期 JIT 编译留下的高值。
 */
export function parseSystemTxt(text) {
  const mcVersion = /^Minecraft Version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const javaVersion = /^Java Version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const cpus = Number.parseInt(/^CPUs:\s*(\d+)/m.exec(text)?.[1] ?? '', 10);
  const processCpu = Number.parseFloat(/^Process Loads:.*\(([\d.]+)%\)\s*$/m.exec(text)?.[1] ?? '');
  // 只认 heap 那一行：non-heap 的 max 实测写作 `000MiB`，取错会得出「上限 0」
  const heapLine = /^Memory \(heap\):.*$/m.exec(text)?.[0] ?? '';
  const heapUsed = Number.parseFloat(/used:\s*(\d+)MiB/.exec(heapLine)?.[1] ?? '');
  const heapMax = Number.parseFloat(/max:\s*(\d+)MiB/.exec(heapLine)?.[1] ?? '');
  return {
    mcVersion,
    javaVersion,
    cpus: Number.isFinite(cpus) ? cpus : null,
    processCpuPercent: Number.isFinite(processCpu) ? processCpu : null,
    heapUsedMiB: Number.isFinite(heapUsed) ? heapUsed : null,
    heapMaxMiB: Number.isFinite(heapMax) ? heapMax : null,
  };
}

/** 堆曲线聚合：口径是 used（非 committed），峰值才是「会不会 OOM」的判据 */
export function summarizeHeap(samples, maxMiB) {
  if (samples.length === 0) return null;
  const peak = Math.max(...samples);
  return {
    usedPeakMiB: peak,
    usedStartMiB: samples[0],
    usedEndMiB: samples[samples.length - 1],
    maxMiB: maxMiB ?? null,
    usedPeakPercent: maxMiB ? (peak / maxMiB) * 100 : null,
    samples: samples.length,
  };
}

/** 数值保留一位小数：结论里的数字带太多位会被读成「精确到小数点后十几位」 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * 性能快照的结论。
 *
 * 判定顺序即严重度顺序：先看「已经掉 TPS」，再看「内存要到顶」，最后才看「余量变少」。
 * 两条同时成立时结论只取最严重的那条，但 detail 会把另一条也写进去——
 * 用户按最严重的去处理，同时不该漏掉第二个问题。
 */
export function derivePerfVerdict({ tick, heap }) {
  const findings = [];
  if (tick) {
    findings.push({
      label: '单刻平均耗时',
      value: `${round1(tick.averageMs)} ms`,
      hint: `20 TPS 的单刻预算是 ${MSPT_BUDGET_MS} ms，越接近越容易掉刻`,
    });
    if (tick.p99Ms != null && tick.maxMs != null) {
      findings.push({
        label: '单刻耗时 p99 / 峰值',
        value: `${round1(tick.p99Ms)} / ${round1(tick.maxMs)} ms`,
        hint: '取自最近 100 刻的环形缓冲，不是整个窗口',
      });
    }
    if (tick.ticksPerSecond != null) {
      findings.push({
        label: '实际 tick 速率',
        value: `${round1(tick.ticksPerSecond)} 次/秒`,
        hint: '低于 20 说明窗口内确实掉过刻',
      });
    }
  }
  if (heap) {
    findings.push({
      label: '堆峰值占用',
      value:
        heap.usedPeakPercent == null
          ? `${round1(heap.usedPeakMiB)} MiB`
          : `${round1(heap.usedPeakMiB)} / ${heap.maxMiB} MiB（${round1(heap.usedPeakPercent)}%）`,
      hint:
        heap.usedPeakPercent == null ? '取不到堆上限，无法判断余量' : '口径是已用堆，不是已提交',
    });
  }

  const tickCritical = tick != null && tick.averageMs >= MSPT_BUDGET_MS;
  const tickWarning = tick != null && tick.averageMs >= MSPT_WARNING_MS;
  const heapPercent = heap?.usedPeakPercent ?? null;
  const heapCritical = heapPercent != null && heapPercent >= HEAP_CRITICAL_PERCENT;
  const heapWarning = heapPercent != null && heapPercent >= HEAP_WARNING_PERCENT;

  const tickText = tick
    ? `单刻平均耗时 ${round1(tick.averageMs)} ms（预算 ${MSPT_BUDGET_MS} ms）`
    : null;
  const heapText =
    heapPercent != null
      ? `堆峰值 ${round1(heap.usedPeakMiB)} MiB，占上限 ${round1(heapPercent)}%`
      : null;

  if (tickCritical) {
    return {
      level: 'critical',
      headline: '服务器已经跟不上 20 TPS：单刻耗时超出预算',
      detail: [tickText, heapCritical || heapWarning ? heapText : null]
        .filter(Boolean)
        .join('；')
        .concat('。先看下方「tick 内耗时分布」，占比最高的那一项就是主要开销来源。'),
      findings,
    };
  }
  if (heapCritical) {
    return {
      level: 'critical',
      headline: '内存快要用完了：堆占用接近上限',
      detail: `${heapText}。堆到顶后服务端会频繁 GC 直至 OutOfMemoryError，可在实例设置里调大内存上限，或减少同时加载的区块与实体。`,
      findings,
    };
  }
  if (tickWarning || heapWarning) {
    const parts = [tickWarning ? tickText : null, heapWarning ? heapText : null]
      .filter(Boolean)
      .join('；');
    return {
      level: 'warning',
      headline: tickWarning ? '服务器开始吃力：单刻耗时已用掉一半预算' : '内存余量不多：堆占用偏高',
      detail: `${parts}。还没到出问题的程度，但余量已经不多——留意玩家变多或加载新区块时的表现。`,
      findings,
    };
  }
  if (!tick && !heap) {
    return {
      level: 'warning',
      headline: '快照取到了，但没能读出可判断的指标',
      detail: '产物里的耗时与堆数据都没解析出来，请把下方「原始产物」下载下来反馈。',
      findings,
    };
  }
  return {
    level: 'healthy',
    headline: '没发现瓶颈：耗时与内存都还有余量',
    detail: [tickText, heapText].filter(Boolean).join('；').concat('。'),
    findings,
  };
}

/**
 * JFR 快照的结论。
 *
 * 只看 GC：分配速率与 CPU 占比没有普适阈值（同一台服装 5 个模组与装 50 个模组差一个量级），
 * 给它们编阈值等于把猜测写成结论。GC 开销有官方口径（JVM 的 GCTimeLimit 默认 98%），
 * 两档阈值取在其下方。
 */
export function deriveJfrVerdict(jfr) {
  const findings = [];
  if (jfr.gcOverheadPercent != null) {
    findings.push({
      label: 'GC 开销占比',
      value: `${round1(jfr.gcOverheadPercent)}%`,
      hint: `窗口内共 ${jfr.gcCount ?? '?'} 次回收，累计 ${round1(jfr.gcTotalDurationMs ?? 0)} ms`,
    });
  }
  if (jfr.allocationRateMiBPerSecond != null) {
    findings.push({
      label: '对象分配速率',
      value: `${round1(jfr.allocationRateMiBPerSecond)} MiB/秒`,
      hint: '分配越快，GC 越频繁；这项没有普适阈值，看趋势即可',
    });
  }
  if (jfr.cpuJvmAveragePercent != null) {
    findings.push({
      label: 'JVM CPU 占用',
      value: `${round1(jfr.cpuJvmAveragePercent)}%`,
      hint: '百分比按单核计，多核机器上可超过 100%',
    });
  }
  if (jfr.tickAverageMs != null) {
    findings.push({
      label: '单刻平均耗时',
      value: `${round1(jfr.tickAverageMs)} ms`,
      hint: '与性能快照的 stats.txt 同口径，两者可互相印证',
    });
  }

  // 窗口太短的结论不可靠，这条优先于任何阈值判定：数据本身不成立时不该给「健康」
  if (jfr.durationMs != null && jfr.durationMs < JFR_MIN_USEFUL_MS) {
    return {
      level: 'warning',
      headline: '录制窗口太短，这次结论只能作参考',
      detail: `只录到 ${round1(jfr.durationMs / 1000)} 秒，GC 次数与分位值在这个长度上会退化成同一个数。重新取一次完整窗口的快照更可靠。`,
      findings,
    };
  }
  const overhead = jfr.gcOverheadPercent;
  if (overhead != null && overhead >= GC_OVERHEAD_CRITICAL_PERCENT) {
    return {
      level: 'critical',
      headline: '垃圾回收吃掉了大量 CPU：堆或对象分配有问题',
      detail: `GC 开销占 ${round1(overhead)}%。常见来源是堆太小、一次性加载大量区块，或某个模组在每刻产生大量临时对象。`,
      findings,
    };
  }
  if (overhead != null && overhead >= GC_OVERHEAD_WARNING_PERCENT) {
    return {
      level: 'warning',
      headline: '垃圾回收开销偏高',
      detail: `GC 开销占 ${round1(overhead)}%，还没到拖慢服务的程度，但值得盯一下：玩家变多时它会先恶化。`,
      findings,
    };
  }
  if (overhead == null) {
    return {
      level: 'warning',
      headline: '快照取到了，但没能读出 GC 数据',
      detail: 'summary 里没有可用的 GC 字段，请把下方「原始产物」下载下来反馈。',
      findings,
    };
  }
  return {
    level: 'healthy',
    headline: '没发现垃圾回收压力：GC 开销很低',
    detail: `窗口内 GC 开销 ${round1(overhead)}%，累计 ${round1(jfr.gcTotalDurationMs ?? 0)} ms。`,
    findings,
  };
}
