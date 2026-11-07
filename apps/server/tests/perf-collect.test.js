/**
 * 性能快照采集域测试。
 *
 * 采集链路里最容易被写错的三处，都是「回包不可信」的直接后果：
 * ① `/perf start` 只回「已开始」，ZIP 要等 10 秒才出现；`/perf stop` 提前终止时**回包是空串**
 *    但包照常生成 ⇒ 成败只能由「目录里有没有新文件」判定，不能用回包判断；
 * ② 目录里可能有**历史产物**（上一次取过的包）⇒ 必须以采集前的目录快照为基线取差集，
 *    否则每次都会把上一次的包当成这一次的结果；
 * ③ 旧版本上命令不存在时的回包是 `Unknown or incomplete command` ⇒ 必须报「不支持」，
 *    不能继续等一个永远不会出现的文件直到超时。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

const FIXTURES = path.resolve(__dirname, 'fixtures/perf');

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  isUnsupportedResponse,
  listDirNames,
  pickNewestArtifact,
  readPerfArchive,
  readJfrReport,
  collectSnapshot,
  PerfCaptureError,
  PERF_SERVER_WINDOW_MS,
  PERF_DONE_TIMEOUT_MS,
  JFR_WINDOW_MS,
} = await import('../src/services/mc-server/perf-collect.js');

/** 造一个只暴露采集所需成员的假实例：serverPath / 运行态 / RCON 态 / 命令发送 */
function makeInstance(serverPath, { responses = [], onCommand = null } = {}) {
  const sent = [];
  return {
    id: 'inst-perf',
    serverPath,
    isRunning: true,
    isRconConnected: true,
    sent,
    async sendCommandWithResponse(command) {
      sent.push(command);
      if (onCommand) await onCommand(command, sent.length - 1);
      const next = responses.shift();
      return next ?? '';
    },
  };
}

/** 按真实产物的条目结构造一个最小 ZIP（路径与实测一致，全在 server/ 下） */
function writePerfZip(targetPath) {
  const zip = new AdmZip();
  zip.addFile('system.txt', Buffer.from(fs.readFileSync(path.join(FIXTURES, 'system.txt'))));
  zip.addFile('server/stats.txt', Buffer.from(fs.readFileSync(path.join(FIXTURES, 'stats.txt'))));
  zip.addFile(
    'server/profiling.txt',
    Buffer.from(fs.readFileSync(path.join(FIXTURES, 'profiling.txt'))),
  );
  zip.addFile(
    'server/metrics/jvm.csv',
    Buffer.from(fs.readFileSync(path.join(FIXTURES, 'jvm.csv'))),
  );
  zip.addFile('server/levels/minecraft/overworld/chunks.csv', Buffer.from('x,z\n0,0\n0,1\n'));
  zip.addFile('server/levels/minecraft/overworld/entities.csv', Buffer.from('x,y,z,uuid\n'));
  zip.addFile('server/levels/minecraft/the_nether/chunks.csv', Buffer.from('x,z\n0,0\n'));
  zip.addFile('server/levels/minecraft/the_nether/entities.csv', Buffer.from('x,y,z,uuid\n'));
  zip.writeZip(targetPath);
}

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-perf-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isUnsupportedResponse', () => {
  it('识别实测的三种拒绝措辞', () => {
    expect(isUnsupportedResponse('Unknown or incomplete command. See below for error')).toBe(true);
    expect(isUnsupportedResponse('Unknown command. Try /help')).toBe(true);
    expect(isUnsupportedResponse('Incorrect argument for command')).toBe(true);
  });

  it('正常回包与空串不算不支持', () => {
    expect(isUnsupportedResponse('Started a 10-second performance profiling run')).toBe(false);
    expect(isUnsupportedResponse('')).toBe(false);
    expect(isUnsupportedResponse(null)).toBe(false);
  });
});

describe('listDirNames / pickNewestArtifact', () => {
  it('目录不存在时返回空数组而不是抛错', () => {
    expect(listDirNames(path.join(tmpRoot, 'nope'))).toEqual([]);
  });

  it('基线里的文件不被选中（历史产物不能当成本次结果）', () => {
    const dir = path.join(tmpRoot, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'old.zip'), 'x');
    fs.writeFileSync(path.join(dir, 'new.zip'), 'x');
    const baseline = new Set(['old.zip']);
    const anyName = () => true;
    expect(pickNewestArtifact(dir, ['old.zip', 'new.zip'], baseline, null, anyName)).toBe(
      'new.zip',
    );
  });

  it('全都已存在时返回 null（不拿旧包顶替）', () => {
    const dir = path.join(tmpRoot, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'old.zip'), 'x');
    expect(pickNewestArtifact(dir, ['old.zip'], new Set(['old.zip']), null, () => true)).toBeNull();
  });

  it('mtime 早于基线时刻的不选（时钟回拨兜底）', () => {
    const dir = path.join(tmpRoot, 'd');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, 'x');
    // 阈值取明确的未来时刻：拿 Date.now() 会因 mtimeMs 的小数部分比整数毫秒略大而假绿
    const future = fs.statSync(file).mtimeMs + 60_000;
    const past = fs.statSync(file).mtimeMs - 60_000;
    expect(pickNewestArtifact(dir, ['a.zip'], new Set(), future, () => true)).toBeNull();
    expect(pickNewestArtifact(dir, ['a.zip'], new Set(), past, () => true)).toBe('a.zip');
  });

  it('写盘中的临时文件不被选中（实测服务端先写 <名>.zip_tmp 再改名）', () => {
    const dir = path.join(tmpRoot, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a-world-26_3.zip_tmp'), 'x');
    const accept = (name) => name.endsWith('.zip');
    expect(pickNewestArtifact(dir, ['a-world-26_3.zip_tmp'], new Set(), null, accept)).toBeNull();
  });

  it('多个候选取最新的那个', () => {
    const dir = path.join(tmpRoot, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.zip'), 'x');
    const newer = path.join(dir, 'b.zip');
    fs.writeFileSync(newer, 'x');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(newer, future, future);
    expect(pickNewestArtifact(dir, ['a.zip', 'b.zip'], new Set(), null, () => true)).toBe('b.zip');
  });
});

describe('readPerfArchive', () => {
  it('真实结构（server/ 前缀）读得出耗时、堆、热点与维度', () => {
    const zipPath = path.join(tmpRoot, 'a.zip');
    writePerfZip(zipPath);
    const { detail, warnings } = readPerfArchive(zipPath);

    expect(warnings).toEqual([]);
    expect(detail.mcVersion).toBe('26.3');
    expect(detail.tick.averageMs).toBeCloseTo(0.129312, 6);
    expect(detail.tick.tickSpan).toBe(201);
    expect(detail.heap.maxMiB).toBe(1024);
    expect(detail.hotspots[0].name).toBe('unspecified');
    expect(detail.dimensions.map((d) => d.name).sort()).toEqual(['overworld', 'the_nether']);
  });

  it('维度条数来自 CSV 行数', () => {
    const zipPath = path.join(tmpRoot, 'a.zip');
    writePerfZip(zipPath);
    const { detail } = readPerfArchive(zipPath);
    const overworld = detail.dimensions.find((d) => d.name === 'overworld');
    expect(overworld.chunks).toBe(2);
    expect(overworld.entities).toBe(0);
  });

  it('模组维度：命名空间从产物取，且非默认命名空间带前缀（裸名会撞车）', () => {
    const zipPath = path.join(tmpRoot, 'mod.zip');
    const zip = new AdmZip();
    zip.addFile('server/levels/minecraft/overworld/chunks.csv', Buffer.from('x,z\n0,0\n'));
    zip.addFile('server/levels/minecraft/overworld/entities.csv', Buffer.from('x,y,z,uuid\n'));
    zip.addFile('server/levels/mymod/lobby/chunks.csv', Buffer.from('x,z\n0,0\n0,1\n0,2\n'));
    zip.addFile('server/levels/mymod/lobby/entities.csv', Buffer.from('x,y,z,uuid\n'));
    zip.writeZip(zipPath);

    const { detail } = readPerfArchive(zipPath);
    const names = detail.dimensions.map((d) => d.name).sort();
    expect(names).toEqual(['mymod:lobby', 'overworld']);
    // 写死 minecraft/ 回读会让这一行静默变成 0
    expect(detail.dimensions.find((d) => d.name === 'mymod:lobby').chunks).toBe(3);
  });

  it('缺条目时逐条降级：留下能读的部分，缺的部分进 warnings', () => {
    const zipPath = path.join(tmpRoot, 'b.zip');
    const zip = new AdmZip();
    zip.addFile(
      'server/metrics/jvm.csv',
      Buffer.from(fs.readFileSync(path.join(FIXTURES, 'jvm.csv'))),
    );
    zip.writeZip(zipPath);
    const { detail, warnings } = readPerfArchive(zipPath);

    expect(detail.heap).not.toBeNull();
    expect(detail.tick).toBeNull();
    expect(warnings.join(' ')).toContain('stats.txt');
    expect(warnings.join(' ')).toContain('system.txt');
  });

  it('打不开的文件：返回空 detail 与一条说明，不抛错', () => {
    const bad = path.join(tmpRoot, 'bad.zip');
    fs.writeFileSync(bad, 'not a zip');
    const { detail, warnings } = readPerfArchive(bad);
    expect(detail.tick).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('readJfrReport', () => {
  it('真实 summary（含 NaN/Infinity）能读出 GC 数据', () => {
    const { detail, warnings } = readJfrReport(path.join(FIXTURES, 'jfr-report.json'));
    expect(warnings).toEqual([]);
    expect(detail.gcCount).toBe(2);
    expect(detail.gcOverheadPercent).toBeCloseTo(0.69911504, 8);
    expect(detail.allocationRateMiBPerSecond).toBeNull();
  });

  it('不是 JSON 时给出空 detail 与说明', () => {
    const bad = path.join(tmpRoot, 'r.json');
    fs.writeFileSync(bad, '{{{');
    const { detail, warnings } = readJfrReport(bad);
    expect(detail.gcCount).toBeNull();
    expect(warnings.join(' ')).toContain('JSON');
  });
});

describe('collectSnapshot：perf', () => {
  it('回包只说「已开始」也能取到结果：成败由产物落地判定', async () => {
    const instance = makeInstance(tmpRoot, {
      responses: ['Started a 10-second performance profiling run (use /perf stop to stop early)'],
      onCommand: (command) => {
        if (command !== 'perf start') return;
        const dir = path.join(tmpRoot, 'debug', 'profiling');
        fs.mkdirSync(dir, { recursive: true });
        writePerfZip(path.join(dir, '2026-11-01_14_43_13-world-26_3.zip'));
      },
    });

    const snapshot = await collectSnapshot(instance, { kind: 'perf' });
    expect(snapshot.kind).toBe('perf');
    expect(snapshot.perf.tick.averageMs).toBeCloseTo(0.129312, 6);
    expect(snapshot.archivePath).toBe('debug/profiling/2026-11-01_14_43_13-world-26_3.zip');
    expect(snapshot.windowMs).toBe(10013);
    expect(snapshot.verdict.level).toBe('healthy');
  });

  it('目录里的历史包不会被当成本次结果', async () => {
    const profilingDir = path.join(tmpRoot, 'debug', 'profiling');
    fs.mkdirSync(profilingDir, { recursive: true });
    // 历史包：先写一个坏 ZIP，若被选中解析就会出 warnings
    fs.writeFileSync(path.join(profilingDir, 'old-world-26_3.zip'), 'not a zip');

    const instance = makeInstance(tmpRoot, {
      onCommand: () => {
        writePerfZip(path.join(profilingDir, 'new-world-26_3.zip'));
      },
    });

    const snapshot = await collectSnapshot(instance, { kind: 'perf' });
    expect(snapshot.archivePath).toBe('debug/profiling/new-world-26_3.zip');
    expect(snapshot.parseWarnings).toEqual([]);
  });

  it('命令不被该版本识别 → 报不支持而不是等超时', async () => {
    const instance = makeInstance(tmpRoot, {
      responses: ['Unknown or incomplete command. See below for error'],
    });
    await expect(collectSnapshot(instance, { kind: 'perf' })).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });

  it('实例未运行 → not-running（不发出任何命令）', async () => {
    const instance = makeInstance(tmpRoot);
    instance.isRunning = false;
    await expect(collectSnapshot(instance, { kind: 'perf' })).rejects.toMatchObject({
      kind: 'not-running',
    });
    expect(instance.sent).toEqual([]);
  });

  it('RCON 未连接 → no-rcon', async () => {
    const instance = makeInstance(tmpRoot);
    instance.isRconConnected = false;
    await expect(collectSnapshot(instance, { kind: 'perf' })).rejects.toMatchObject({
      kind: 'no-rcon',
    });
  });

  it('debug/ 不存在时被创建（JFR 与 perf 的产物落点都靠它）', async () => {
    const instance = makeInstance(tmpRoot, {
      onCommand: () => {
        const dir = path.join(tmpRoot, 'debug', 'profiling');
        fs.mkdirSync(dir, { recursive: true });
        writePerfZip(path.join(dir, 'a-world-26_3.zip'));
      },
    });
    await collectSnapshot(instance, { kind: 'perf' });
    expect(fs.existsSync(path.join(tmpRoot, 'debug'))).toBe(true);
  });
});

describe('collectSnapshot：jfr', () => {
  it('按新增的 jfr-report 定位（stop 回包只提 .jfr，不提 report）', async () => {
    const debugDir = path.join(tmpRoot, 'debug');
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, 'jfr-report-server-old.json'), '{"durationMs":1}');

    const instance = makeInstance(tmpRoot, {
      responses: [
        'JFR profiling started',
        'JFR profiling stopped and dumped to debug/server-2026-11-01-144350.jfr',
      ],
      onCommand: (command) => {
        if (command !== 'jfr stop') return;
        // 用「读内容再写」而不是 copyFileSync：后者在 Windows 上会**保留源文件的
        // mtime**（CopyFileEx 语义），而本用例把 Date 冻在假时钟上、文件落盘用的是
        // 真实时钟，两者一错开就会让产物被 `startedAt - 1000` 的过滤当成旧文件排除，
        // 等待循环于是永远等不到结果。重写文件以保证 mtime 是「此刻」。
        fs.writeFileSync(
          path.join(debugDir, 'jfr-report-server-new.json'),
          fs.readFileSync(path.join(FIXTURES, 'jfr-report.json')),
        );
      },
    });

    // 录制窗口是固定时长的真等待：用假定时器推进，避免用例本身占用真实时间。
    // 推进量必须引用常量——写死 15_000 会让「窗口调大」时这里干等到超时，
    // 等于用流程用例把常量断言给出的「窗口可调」承诺架空。
    //
    // `shouldAdvanceTime` 让 Date 跟着假定时器一起走：等待循环的终止条件是
    // `Date.now() >= deadline`，只伪造 setTimeout 而 Date 读真实时钟时，
    // 推进定时器不会推进 deadline，循环会一直自旋到用例真超时。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending = collectSnapshot(instance, { kind: 'jfr' });
      // 先让 `jfr start` 的微任务链跑完，等待循环的 setTimeout 才会注册上来
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(JFR_WINDOW_MS);
      const snapshot = await pending;
      expect(snapshot.kind).toBe('jfr');
      expect(snapshot.archivePath).toBe('debug/jfr-report-server-new.json');
      expect(snapshot.jfr.gcCount).toBe(2);
      // 短窗口必须落到「窗口太短」这一档，而不是绿色健康
      expect(snapshot.verdict.headline).toContain('窗口太短');
    } finally {
      vi.useRealTimers();
    }
  });

  it('已有一段录制在进行中时明确拒绝（不把别人的录制停掉）', async () => {
    const instance = makeInstance(tmpRoot, { responses: ['Failed to start JFR profiling'] });
    await expect(collectSnapshot(instance, { kind: 'jfr' })).rejects.toMatchObject({
      kind: 'timeout',
    });
    // 只发出了 start，没有发 stop
    expect(instance.sent).toEqual(['jfr start']);
  });

  it('debug/ 在发出命令之前就存在（目录缺失时 JFR 静默失败，不报错也不落文件）', async () => {
    let debugExistedAtStart = null;
    const instance = makeInstance(tmpRoot, {
      responses: ['Failed to start JFR profiling'],
      onCommand: (command) => {
        if (command === 'jfr start') {
          debugExistedAtStart = fs.existsSync(path.join(tmpRoot, 'debug'));
        }
      },
    });
    await expect(collectSnapshot(instance, { kind: 'jfr' })).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(debugExistedAtStart).toBe(true);
  });

  it('命令不被该版本识别 → 报不支持', async () => {
    const instance = makeInstance(tmpRoot, {
      responses: ['Unknown or incomplete command. See below for error'],
    });
    await expect(collectSnapshot(instance, { kind: 'jfr' })).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });
});

describe('PerfCaptureError', () => {
  it('带类别，路由据此挑错误码', () => {
    const err = new PerfCaptureError('timeout', '超时了');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('timeout');
    expect(err.message).toBe('超时了');
  });
});

/**
 * 时长常量守的是**性质**不是数值：写死 30_000 的断言在合理调整时也会红，
 * 那会训练人「改数字就改测试」，等于没有约束。这里锁两条下界语义。
 */
describe('时长常量的下界', () => {
  it('落地等待必须覆盖服务端窗口（否则窗口还没走完就判超时）', () => {
    expect(PERF_DONE_TIMEOUT_MS).toBeGreaterThanOrEqual(PERF_SERVER_WINDOW_MS);
  });

  it('落地等待要留足余量：至少 2 倍窗口（压缩与磁盘写入都在窗口之后）', () => {
    expect(PERF_DONE_TIMEOUT_MS).toBeGreaterThanOrEqual(PERF_SERVER_WINDOW_MS * 2);
  });

  it('JFR 窗口不低于 10 秒：每秒一条采样，更短则事件数不足、分位字段退化', () => {
    expect(JFR_WINDOW_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('JFR 窗口不是无限长：长窗口会让用户干等，上限取 60 秒', () => {
    expect(JFR_WINDOW_MS).toBeLessThanOrEqual(60_000);
  });
});
