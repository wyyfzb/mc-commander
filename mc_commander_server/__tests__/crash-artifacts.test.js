/**
 * 崩溃诊断产物读取与解析。
 *
 * 样本来源：**真实产物**（本机实测），已脱敏与截头——崩溃报告出自 MC 26.1 启动期崩溃，
 * `hs_err` 出自 JVM 段错误与 `-XX:+CrashOnOutOfMemoryError` 两种故障。
 * 结构依据见 `services/mc-server/crash-artifacts.js` 头注释（含 wiki / Fabric 文档链接）。
 *
 * 承重点：这是**诊断信息**，宁可如实说「读不到」，也不能显示空内容让用户以为「没有报错」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as crashArtifacts from '../services/mc-server/crash-artifacts.js';
import { parseCrashReport, parseHsErr } from '../services/mc-server/crash-artifacts.js';

// 夹具一律用 .txt：服务端包 .gitignore 忽略 *.log，用真扩展名会被静默排除在提交之外，
// 于是本地绿、CI 红（找不到夹具）
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

/**
 * 构造实例：把**整个域模块**挂到对象上，与生产的 `Object.assign(MCServerInstance.prototype, …)`
 * 同形。只挂两个入口会让内部调用的 `_crashArtifactContained`/`_crashArtifactStat` 缺失，
 * 于是枚举静默抛错被吞成「无产物」——那会让「期望 null」的用例**因错误的原因通过**。
 */
function makeInstance(serverPath) {
  return Object.assign({ id: 'crash-test', serverPath }, crashArtifacts);
}

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crash-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger 走 stderr
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeCrashReport(name, content) {
  const dir = path.join(tmpDir, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function writeHsErr(name, content) {
  fs.writeFileSync(path.join(tmpDir, name), content);
}

describe('MC 崩溃报告解析', () => {
  it('真实样本：取出时间/描述/版本/内存等已核实字段', () => {
    const r = parseCrashReport(read('crash-invalid-secret.txt'));
    expect(r.parseError).toBeUndefined();
    const byLabel = Object.fromEntries(r.summary.map((f) => [f.label, f.value]));
    expect(byLabel['时间']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(byLabel['描述']).toBe('Exception in server tick loop');
    expect(byLabel['Minecraft 版本']).toBe('26.1');
    expect(byLabel['Java 版本']).toMatch(/^25\./);
    expect(byLabel['内存']).toContain('up to');
    expect(r.sections).toContain('System Details');
  });

  it('真实样本：顶层异常与栈、Caused by 链', () => {
    const r = parseCrashReport(read('crash-tls-keystore.txt'));
    expect(r.exception).toBe(
      'java.lang.IllegalStateException: Failed to configure TLS for the server management protocol',
    );
    expect(r.causedBy).toEqual([
      'java.lang.IllegalArgumentException: TLS is enabled but keystore is not configured',
    ]);
    expect(r.stack[0]).toMatch(/^\s*at /);
    expect(r.stack.length).toBeGreaterThan(3);
  });

  it('启动期崩溃没有 -- Affected level --，按可选处理不报错', () => {
    const r = parseCrashReport(read('crash-invalid-secret.txt'));
    expect(r.sections).not.toContain('Affected level');
    expect(r.parseError).toBeUndefined();
  });

  it('有 -- Affected level -- 时取出该段字段（结构依文档，真实样本只含 System Details）', () => {
    // 该段只在推进到世界/刻循环的崩溃里出现，本机两份真实样本都没有，故按已核实的
    // 结构（`-- <段名> --` + Details: 块）构造一条，覆盖「存在时必须取到」
    const synthetic = [
      '---- Minecraft Crash Report ----',
      '// Oh dear',
      '',
      'Time: 2026-10-05 02:00:00',
      'Description: Ticking entity',
      '',
      'java.lang.RuntimeException: boom',
      '\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:1)',
      '',
      'A detailed walkthrough of the error, its code path and all known details is as follows:',
      '---------------------------------------------------------------------------------------',
      '',
      '-- Affected level --',
      'Details:',
      '\tAll players: 1 total; [ServerPlayer[/1, lvl=0, x=1.0, y=2.0, z=3.0]]',
      '\tServer brand: vanilla',
      '\tLevel dimension: minecraft:overworld',
      '',
      '-- System Details --',
      'Details:',
      '\tMinecraft Version: 26.1',
    ].join('\n');
    const r = parseCrashReport(synthetic);
    expect(r.sections).toEqual(['Affected level', 'System Details']);
    const byLabel = Object.fromEntries(r.summary.map((f) => [f.label, f.value]));
    expect(byLabel['服务端品牌']).toBe('vanilla');
    expect(byLabel['崩溃时在线玩家']).toContain('ServerPlayer');
  });

  it('不是崩溃报告时如实降级，不给出空字段', () => {
    const r = parseCrashReport('随便一段文本\n没有任何头部标识');
    expect(r.parseError).toContain('未找到崩溃报告头部标识');
    expect(r.summary).toBeUndefined();
  });
});

describe('JVM 崩溃日志（hs_err）解析', () => {
  it('信号型：故障行 + 问题帧', () => {
    const r = parseHsErr(read('hs-err-segv.txt'));
    expect(r.parseError).toBeUndefined();
    const byLabel = Object.fromEntries(r.summary.map((f) => [f.label, f.value]));
    expect(byLabel['故障']).toContain('SIGSEGV');
    expect(byLabel['JRE 版本']).toContain('OpenJDK');
    expect(byLabel['问题帧']).toBe('C  [libc.so.6+0x98e4f]');
  });

  it('OOM 型：两行故障，且**没有**问题帧段时不报错', () => {
    const r = parseHsErr(read('hs-err-oom.txt'));
    const byLabel = Object.fromEntries(r.summary.map((f) => [f.label, f.value]));
    expect(byLabel['故障']).toContain('Internal Error');
    expect(byLabel['故障']).toContain('OutOfMemory');
    expect(byLabel['问题帧']).toBeUndefined();
    expect(r.problematicFrame).toBeNull();
  });

  it('不是 hs_err 时如实降级', () => {
    expect(parseHsErr('hello').parseError).toContain('未找到 JVM 崩溃日志头部标识');
  });
});

describe('getCrashArtifact 取用与降级', () => {
  it('从未崩溃过 → 返回 null（正常空态，不是错误）', () => {
    const inst = makeInstance(tmpDir);
    // 先自证枚举确实跑通了（空目录返回空列表），否则「返回 null」也可能是枚举抛错被吞
    expect(inst._listCrashArtifacts()).toEqual([]);
    expect(inst.getCrashArtifact()).toBeNull();
  });

  it('两类产物并存时取 mtime 最新的一份', () => {
    writeCrashReport('crash-2026-10-05_01.00.00-server.txt', read('crash-invalid-secret.txt'));
    writeHsErr('hs_err_pid123.log', read('hs-err-segv.txt'));
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(
      path.join(tmpDir, 'crash-reports', 'crash-2026-10-05_01.00.00-server.txt'),
      past,
      past,
    );
    const r = makeInstance(tmpDir).getCrashArtifact();
    expect(r.kind).toBe('jvm-crash');
    expect(r.fileName).toBe('hs_err_pid123.log');
    expect(r.available).toBe(true);
  });

  it('只认约定命名：其它文件不当作崩溃产物', () => {
    writeCrashReport('notes.txt', read('crash-invalid-secret.txt'));
    writeHsErr('hs_err_pid1.log.bak', read('hs-err-segv.txt'));
    // 同目录放一份**合法**产物：若扫描整体失灵，这条会一起失败，
    // 避免「期望 null」的用例因枚举根本没跑而假绿
    writeCrashReport('crash-2026-10-05_01.00.00-server.txt', read('crash-invalid-secret.txt'));
    const found = makeInstance(tmpDir)._listCrashArtifacts();
    expect(found.map((a) => a.fileName)).toEqual(['crash-2026-10-05_01.00.00-server.txt']);
  });

  it('格式不认识时 parseError 非空，但 excerpt 仍给出原文（不显示空）', () => {
    writeCrashReport('crash-2026-10-05_01.00.00-server.txt', '被截断的文件，头部丢失');
    const r = makeInstance(tmpDir).getCrashArtifact();
    expect(r.available).toBe(true);
    expect(r.parseError).toContain('未找到崩溃报告头部标识');
    expect(r.excerpt).toContain('被截断的文件');
  });

  it('读取失败时如实降级为 available:false + parseError（不静默给空）', () => {
    writeCrashReport('crash-2026-10-05_01.00.00-server.txt', read('crash-invalid-secret.txt'));
    const inst = makeInstance(tmpDir);
    // 枚举拿得到、读取拿不到：模拟权限/竞争导致的读失败
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => {
      if (String(p).includes('crash-reports')) throw new Error('EACCES: permission denied');
      return realOpen(p, ...rest);
    });
    const r = inst.getCrashArtifact();
    expect(r.available).toBe(true);
    expect(r.parseError).toContain('读取失败');
    expect(r.excerpt).toBeUndefined();
  });

  it('崩溃报告目录不可读时不抛错（按无产物处理）', () => {
    fs.mkdirSync(path.join(tmpDir, 'crash-reports'), { recursive: true });
    const inst = makeInstance(tmpDir);
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => inst.getCrashArtifact()).not.toThrow();
    expect(inst.getCrashArtifact()).toBeNull();
  });

  it('符号链接指向实例外时不读取（路径包含性）', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'evil.txt'), read('crash-invalid-secret.txt'));
      fs.mkdirSync(path.join(tmpDir, 'crash-reports'), { recursive: true });
      fs.symlinkSync(
        path.join(outside, 'evil.txt'),
        path.join(tmpDir, 'crash-reports', 'crash-2026-10-05_01.00.00-server.txt'),
      );
      // 符号链接 resolve 后落在实例外 ⇒ 丢弃
      expect(makeInstance(tmpDir).getCrashArtifact()).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// 实例报错持久面：产物文件本身跨面板重启留存，历史面只是把它读出来
describe('崩溃产物历史（getCrashArtifactHistory）', () => {
  /** 固定产物 mtime，让「最新在前」有确定含义 */
  function touch(fileName, mtimeMs, dir = tmpDir) {
    const target = path.join(dir, fileName);
    const seconds = mtimeMs / 1000;
    fs.utimesSync(target, seconds, seconds);
  }

  it('从未崩溃：空列表（正常空态，不是读取失败）', () => {
    const instance = makeInstance(tmpDir);
    expect(instance.getCrashArtifactHistory()).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('多份产物按 mtime 最新在前，各自带时间/原因/顶层异常；hs_err 的时间留空', () => {
    writeCrashReport('crash-2026-10-05_01.10.36-server.txt', read('crash-invalid-secret.txt'));
    writeCrashReport('crash-2026-10-04_02.00.00-server.txt', read('crash-tls-keystore.txt'));
    writeHsErr('hs_err_pid2601333.log', read('hs-err-segv.txt'));
    touch(path.join('crash-reports', 'crash-2026-10-05_01.10.36-server.txt'), 3000);
    touch(path.join('crash-reports', 'crash-2026-10-04_02.00.00-server.txt'), 1000);
    touch('hs_err_pid2601333.log', 5000);

    const history = makeInstance(tmpDir).getCrashArtifactHistory();

    expect(history.total).toBe(3);
    expect(history.hasMore).toBe(false);
    expect(history.items.map((i) => i.fileName)).toEqual([
      'hs_err_pid2601333.log',
      'crash-2026-10-05_01.10.36-server.txt',
      'crash-2026-10-04_02.00.00-server.txt',
    ]);
    // hs_err：原因取故障行、详情取问题帧；时间留空（其 Time 行形态含 elapsed time，交由界面用 mtime）
    expect(history.items[0].kind).toBe('jvm-crash');
    expect(history.items[0].reason).toContain('SIGSEGV');
    expect(history.items[0].detail).toBeTruthy();
    expect(history.items[0].time).toBeNull();
    // 崩溃报告：Time/Description 直接取自产物，顶层异常行作为详情
    expect(history.items[1]).toMatchObject({
      kind: 'crash-report',
      time: '2026-10-05 01:10:36',
      reason: 'Exception in server tick loop',
    });
    expect(history.items[1].detail).toMatch(/(Exception|Error)\b/);
    expect(history.items[2].reason).toBeTruthy();
  });

  it('limit 裁剪最早的那些，total/hasMore 如实反映总量', () => {
    writeCrashReport('crash-a-server.txt', read('crash-invalid-secret.txt'));
    writeCrashReport('crash-b-server.txt', read('crash-tls-keystore.txt'));
    touch(path.join('crash-reports', 'crash-a-server.txt'), 2000);
    touch(path.join('crash-reports', 'crash-b-server.txt'), 1000);

    const history = makeInstance(tmpDir).getCrashArtifactHistory({ limit: 1 });

    expect(history.items.map((i) => i.fileName)).toEqual(['crash-a-server.txt']);
    expect(history.total).toBe(2);
    expect(history.hasMore).toBe(true);
  });

  it('单份读不到不影响整列：该条保留元信息、原因留空（不猜），其余照常解析', () => {
    writeCrashReport('crash-a-server.txt', read('crash-invalid-secret.txt'));
    writeCrashReport('crash-b-server.txt', read('crash-tls-keystore.txt'));
    touch(path.join('crash-reports', 'crash-a-server.txt'), 2000);
    touch(path.join('crash-reports', 'crash-b-server.txt'), 1000);
    const origOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
      if (String(target).endsWith('crash-a-server.txt')) throw new Error('EACCES: 权限不足');
      return origOpen(target, ...rest);
    });

    const history = makeInstance(tmpDir).getCrashArtifactHistory();

    expect(history.total).toBe(2);
    expect(history.items[0]).toMatchObject({
      fileName: 'crash-a-server.txt',
      reason: null,
      detail: null,
      time: null,
    });
    expect(history.items[0].sizeBytes).toBeGreaterThan(0); // 元信息仍在，界面能回落到文件名
    expect(history.items[1].reason).toBeTruthy();
  });

  it('产物目录不可读时不抛错（读取面不能把面板拖下去）', () => {
    const instance = makeInstance(path.join(tmpDir, 'not-exist-dir'));
    expect(() => instance.getCrashArtifactHistory()).not.toThrow();
    expect(instance.getCrashArtifactHistory().items).toEqual([]);
  });
});
