/**
 * 性能快照解析域测试。
 *
 * 夹具全部来自 26.3 真服产物（`tests/fixtures/perf/`，已脱敏去掉宿主机路径），
 * 故「解析器长得对不对」以真实产物为准，而不是按某个臆想的格式写。
 *
 * 承重点五条：
 * ① `ticking.csv` 不是单刻耗时而是墙钟间隔（实测中位数 49.9 ms），
 *    把它当 MSPT 会夸大近 500 倍 —— 解析层根本不读这个文件；
 * ② `stats.txt` 的 `average_tick_time` 是毫秒、`tick_times` 是纳秒，同窗口下两者必须对得上；
 * ③ JFR summary 含 `NaN` / `Infinity` / `-Infinity`，Node 的 `JSON.parse` 会直接抛错，
 *    故必须先替换成 null；且字符串里的同名子串**不能**被误改；
 * ④ 热点只取 `tick` 的直接子节点并按**父内占比**排序，不能把 `nextTickWait`（实测 99.85%）
 *    这类空转节点算进耗时分布；
 * ⑤ 结论分档用阈值判定，且「掉 TPS」优先于「内存偏高」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  stripNonStandardJsonLiterals,
  parseJfrSummaryJson,
  parseStatsTxt,
  parseSingleColumnCsv,
  countCsvRows,
  parseProfilingTxt,
  extractTickHotspots,
  parseSystemTxt,
  summarizeHeap,
  derivePerfVerdict,
  deriveJfrVerdict,
  JFR_MIN_USEFUL_MS,
} from '../src/services/mc-server/perf-parse.js';

const FIXTURES = path.resolve(__dirname, 'fixtures/perf');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

describe('stripNonStandardJsonLiterals', () => {
  it('把三个非标准字面量换成 null', () => {
    const out = stripNonStandardJsonLiterals('{"a":NaN,"b":Infinity,"c":-Infinity}');
    expect(out).toBe('{"a":null,"b":null,"c":null}');
  });

  it('-Infinity 不会被拆成剩下的 -', () => {
    const out = stripNonStandardJsonLiterals('{"a":-Infinity}');
    expect(out).toBe('{"a":null}');
    expect(JSON.parse(out)).toEqual({ a: null });
  });

  it('字符串里的同名子串保持原样', () => {
    const src = '{"name":"NaN test","path":"a/Infinity/b","x":NaN}';
    const out = stripNonStandardJsonLiterals(src);
    expect(out).toBe('{"name":"NaN test","path":"a/Infinity/b","x":null}');
  });

  it('转义引号不会提前结束字符串，其后的 NaN 仍被替换', () => {
    const src = '{"s":"say \\"NaN\\" now","v":NaN}';
    const out = stripNonStandardJsonLiterals(src);
    expect(JSON.parse(out)).toEqual({ s: 'say "NaN" now', v: null });
  });

  it('真实 26.3 summary 替换后可被 JSON.parse 接受', () => {
    const out = stripNonStandardJsonLiterals(read('jfr-report.json'));
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe('parseJfrSummaryJson', () => {
  it('真实产物：NaN 的分配速率变成 null，其余数值照读', () => {
    const parsed = parseJfrSummaryJson(read('jfr-report.json'));
    expect(parsed).not.toBeNull();
    // 该样本的 allocationRateBytesPerSecond 是 NaN
    expect(parsed.allocationRateMiBPerSecond).toBeNull();
    expect(parsed.gcCount).toBe(2);
    expect(parsed.gcOverheadPercent).toBeCloseTo(0.69911504, 8);
    expect(parsed.gcTotalDurationMs).toBe(316);
    expect(parsed.durationMs).toBe(452);
  });

  it('Infinity 的 cpu min/max 不影响 average 的读取', () => {
    const parsed = parseJfrSummaryJson(read('jfr-report.json'));
    expect(parsed.cpuJvmAveragePercent).toBe(0);
  });

  it('不是 JSON 时返回 null 而不抛错', () => {
    expect(parseJfrSummaryJson('not json at all')).toBeNull();
  });
});

describe('parseStatsTxt', () => {
  it('average_tick_time 按毫秒读', () => {
    const stats = parseStatsTxt(read('stats.txt'));
    expect(stats.averageMs).toBeCloseTo(0.129312, 6);
  });

  it('tick_times 按纳秒读，均值与 average_tick_time 对得上（差不超过 5%）', () => {
    const stats = parseStatsTxt(read('stats.txt'));
    const text = read('stats.txt');
    const raw = /^tick_times:\s*\[([^\]]*)\]/m.exec(text)[1].split(',');
    const meanMs = raw.reduce((sum, s) => sum + Number.parseFloat(s), 0) / raw.length / 1e6;
    expect(stats.samples).toBe(raw.length);
    expect(Math.abs(meanMs - stats.averageMs) / stats.averageMs).toBeLessThan(0.05);
  });

  it('p99 与峰值都按毫秒给出，且峰值不小于 p99', () => {
    const stats = parseStatsTxt(read('stats.txt'));
    expect(stats.p99Ms).toBeGreaterThan(0);
    expect(stats.p99Ms).toBeLessThan(1);
    expect(stats.maxMs).toBeGreaterThanOrEqual(stats.p99Ms);
  });

  it('缺字段时给出 null 而不是 0', () => {
    const stats = parseStatsTxt('pending_tasks: 0\n');
    expect(stats.averageMs).toBeNull();
    expect(stats.p99Ms).toBeNull();
    expect(stats.samples).toBe(0);
  });
});

describe('parseSingleColumnCsv / countCsvRows', () => {
  it('跳过表头，只取第二列数值', () => {
    const values = parseSingleColumnCsv(read('jvm.csv'));
    expect(values).toHaveLength(24);
    expect(values[0]).toBeCloseTo(194.913, 3);
  });

  it('行数统计不含表头', () => {
    expect(countCsvRows(read('jvm.csv'))).toBe(24);
    expect(countCsvRows('a,b\n')).toBe(0);
  });
});

describe('parseProfilingTxt / extractTickHotspots', () => {
  it('读出窗口长度、刻数与实际 tick 速率', () => {
    const profiling = parseProfilingTxt(read('profiling.txt'));
    expect(profiling.timeSpanMs).toBe(10013);
    expect(profiling.tickSpan).toBe(201);
    expect(profiling.ticksPerSecond).toBeCloseTo(20.07, 2);
  });

  it('计数器行（#runTask）不进节点表', () => {
    const profiling = parseProfilingTxt(read('profiling.txt'));
    expect(profiling.nodes.some((n) => n.name.startsWith('#'))).toBe(false);
  });

  it('热点只取 tick 的直接子节点', () => {
    const hotspots = extractTickHotspots(parseProfilingTxt(read('profiling.txt')).nodes);
    expect(hotspots.map((h) => h.name)).toEqual(['unspecified', 'scheduledPacketProcessing']);
  });

  it('nextTickWait 不进入热点（它是等下一刻的空转，不是耗时来源）', () => {
    const hotspots = extractTickHotspots(parseProfilingTxt(read('profiling.txt')).nodes);
    expect(hotspots.some((h) => h.name === 'nextTickWait')).toBe(false);
  });

  it('只取直接子节点：孙节点不得混进来（真实样本只有两层，这里补一棵三层树）', () => {
    const text = [
      '--- BEGIN PROFILE DUMP ---',
      '[00] tick(10/1) - 0.05%/0.05%',
      '[01] |   childA(10/1) - 60.00%/0.03%',
      '[02] |   |   grandChild(10/1) - 90.00%/0.027%',
      '[01] |   childB(10/1) - 40.00%/0.02%',
      '--- END PROFILE DUMP ---',
    ].join('\n');
    const hotspots = extractTickHotspots(parseProfilingTxt(text).nodes);
    expect(hotspots.map((h) => h.name)).toEqual(['childA', 'childB']);
  });

  it('按父内占比降序', () => {
    const hotspots = extractTickHotspots(parseProfilingTxt(read('profiling.txt')).nodes);
    expect(hotspots[0].sharePercent).toBeGreaterThan(hotspots[1].sharePercent);
    expect(hotspots[0].sharePercent).toBeCloseTo(93.66, 2);
  });
});

describe('parseSystemTxt', () => {
  it('版本、Java、核数与进程 CPU 都读到', () => {
    const system = parseSystemTxt(read('system.txt'));
    expect(system.mcVersion).toBe('26.3');
    expect(system.javaVersion).toContain('25.0.5');
    expect(system.cpus).toBe(4);
    expect(system.processCpuPercent).toBeCloseTo(17.55, 2);
  });

  it('堆上限取 heap 那一行，不被 non-heap 的 000MiB 带偏', () => {
    const system = parseSystemTxt(read('system.txt'));
    expect(system.heapMaxMiB).toBe(1024);
  });
});

describe('summarizeHeap', () => {
  it('峰值取窗口内最大值，占比对上限换算', () => {
    const heap = summarizeHeap([100, 250, 200], 1024);
    expect(heap.usedPeakMiB).toBe(250);
    expect(heap.usedStartMiB).toBe(100);
    expect(heap.usedEndMiB).toBe(200);
    expect(heap.usedPeakPercent).toBeCloseTo(24.414, 3);
  });

  it('没有上限时占比为 null（不拿 0 顶替，0 会被读成「几乎没用堆」）', () => {
    const heap = summarizeHeap([100, 200], null);
    expect(heap.maxMiB).toBeNull();
    expect(heap.usedPeakPercent).toBeNull();
  });

  it('空样本返回 null', () => {
    expect(summarizeHeap([], 1024)).toBeNull();
  });
});

describe('derivePerfVerdict', () => {
  const tick = (averageMs, p99Ms = averageMs, maxMs = averageMs, tps = 20) => ({
    averageMs,
    p99Ms,
    maxMs,
    samples: 100,
    tickSpan: 201,
    timeSpanMs: 10013,
    ticksPerSecond: tps,
  });
  const heap = (peakPercent) => ({
    usedPeakMiB: peakPercent,
    usedStartMiB: peakPercent,
    usedEndMiB: peakPercent,
    maxMiB: 1024,
    usedPeakPercent: peakPercent,
    samples: 201,
  });

  it('健康样本（真实 26.3 空跑）判 healthy', () => {
    const verdict = derivePerfVerdict({ tick: tick(0.129), heap: heap(20) });
    expect(verdict.level).toBe('healthy');
    expect(verdict.headline).toContain('没发现瓶颈');
  });

  it('单刻耗时超 50 ms 判 critical，且结论说清是掉 TPS', () => {
    const verdict = derivePerfVerdict({ tick: tick(60), heap: heap(20) });
    expect(verdict.level).toBe('critical');
    expect(verdict.headline).toContain('TPS');
  });

  it('单刻耗时远低于一半预算（10 ms）判 healthy', () => {
    const verdict = derivePerfVerdict({ tick: tick(10), heap: heap(20) });
    expect(verdict.level).toBe('healthy');
  });

  it('单刻耗时 25–50 ms 判 warning', () => {
    const verdict = derivePerfVerdict({ tick: tick(30), heap: heap(20) });
    expect(verdict.level).toBe('warning');
  });

  it('堆占比超 90% 判 critical', () => {
    const verdict = derivePerfVerdict({ tick: tick(0.1), heap: heap(93) });
    expect(verdict.level).toBe('critical');
    expect(verdict.headline).toContain('内存');
  });

  it('堆占比 75%–90% 判 warning', () => {
    const verdict = derivePerfVerdict({ tick: tick(0.1), heap: heap(80) });
    expect(verdict.level).toBe('warning');
  });

  it('掉 TPS 优先于内存偏高：两者同时成立时报先掉刻', () => {
    const verdict = derivePerfVerdict({ tick: tick(60), heap: heap(80) });
    expect(verdict.level).toBe('critical');
    expect(verdict.headline).toContain('TPS');
    // 第二个问题不能被丢掉
    expect(verdict.detail).toContain('堆峰值');
  });

  it('两项都没有时不报健康，而是如实说没读出指标', () => {
    const verdict = derivePerfVerdict({ tick: null, heap: null });
    expect(verdict.level).toBe('warning');
    expect(verdict.headline).toContain('没能读出');
  });

  it('findings 里的耗时与堆都带单位', () => {
    const verdict = derivePerfVerdict({ tick: tick(12.34), heap: heap(56.7) });
    const values = verdict.findings.map((f) => f.value).join(' | ');
    expect(values).toContain('ms');
    expect(values).toContain('MiB');
  });
});

describe('deriveJfrVerdict', () => {
  /**
   * 默认窗口取阈值的两倍而不是写死 15000：阈值上调时夹具会静默落进「窗口太短」分支，
   * 那三条 healthy/critical 用例就变成在测别的东西，而它们仍然「通过」。
   */
  const jfr = (over = {}) => ({
    durationMs: JFR_MIN_USEFUL_MS * 2,
    gcCount: 3,
    gcOverheadPercent: 1,
    gcTotalDurationMs: 150,
    allocationRateMiBPerSecond: 50,
    cpuJvmAveragePercent: 20,
    tickAverageMs: 1,
    tickMaxMs: 3,
    ...over,
  });

  it('GC 开销很低判 healthy', () => {
    expect(deriveJfrVerdict(jfr()).level).toBe('healthy');
  });

  it('GC 开销超 20% 判 critical', () => {
    const verdict = deriveJfrVerdict(jfr({ gcOverheadPercent: 25 }));
    expect(verdict.level).toBe('critical');
    expect(verdict.headline).toContain('垃圾回收');
  });

  it('GC 开销 10%–20% 判 warning', () => {
    expect(deriveJfrVerdict(jfr({ gcOverheadPercent: 12 })).level).toBe('warning');
  });

  it('窗口过短时不给健康结论（实测 452 ms 录制里分位值全等于 max）', () => {
    const verdict = deriveJfrVerdict(jfr({ durationMs: 452 }));
    expect(verdict.level).toBe('warning');
    expect(verdict.headline).toContain('窗口太短');
  });

  it('GC 字段缺失时如实说读不出，不报健康', () => {
    const verdict = deriveJfrVerdict(jfr({ gcOverheadPercent: null }));
    expect(verdict.level).toBe('warning');
    expect(verdict.headline).toContain('没能读出');
  });
});
