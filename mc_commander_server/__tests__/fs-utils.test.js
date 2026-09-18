import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveSafePath, resolveContainedPath, isPathContained, PathTraversalError, ensureDir, renameNoClobber, atomicWriteFile } from '../utils/fs-utils.js';

// resolveSafePath 单元测试：四步防线
// （归一化、相等排除 + sep 边界、逐段 realpath、最终目标 symlink 拒绝）
describe('fs-utils resolveSafePath', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fsutils-'));
    fs.mkdirSync(path.join(base, 'sub'));
    fs.writeFileSync(path.join(base, 'sub', 'file.txt'), 'data');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('合法相对路径正常返回归一化绝对路径', () => {
    const full = resolveSafePath(base, 'sub/file.txt');
    expect(full).toBe(path.resolve(base, 'sub', 'file.txt'));
  });

  it('新建文件路径（目标不存在）允许返回（PUT 新建场景）', () => {
    const full = resolveSafePath(base, 'new/deep/file.txt');
    expect(full).toBe(path.resolve(base, 'new', 'deep', 'file.txt'));
  });

  it('根目录相等排除：. ./ .// a/../ 全部拒绝', () => {
    for (const p of ['.', './', './/', 'a/../']) {
      expect(() => resolveSafePath(base, p)).toThrow(PathTraversalError);
    }
  });

  it('allowRoot 时允许返回实例根目录（列表根目录场景）', () => {
    expect(resolveSafePath(base, '/', { allowRoot: true })).toBe(path.resolve(base));
    expect(resolveSafePath(base, '.', { allowRoot: true })).toBe(path.resolve(base));
    // 不传 allowRoot 时根目录仍拒绝
    expect(() => resolveSafePath(base, '/')).toThrow(PathTraversalError);
  });

  it('sep 边界：前缀相同但非子路径（兄弟目录名）拒绝', () => {
    const sibling = `${base}-sibling`;
    fs.mkdirSync(sibling);
    try {
      expect(() => resolveSafePath(base, `../${path.basename(base)}-sibling/x`))
        .toThrow(PathTraversalError);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('.. 逃逸拒绝', () => {
    expect(() => resolveSafePath(base, '../')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(base, 'sub/../../')).toThrow(PathTraversalError);
  });

  it('NUL 字节路径拒绝', () => {
    expect(() => resolveSafePath(base, 'a\0b')).toThrow(PathTraversalError);
  });

  it('实例目录不存在时抛原生 ENOENT（路由层映射 404）', () => {
    expect(() => resolveSafePath(path.join(base, 'missing'), 'x'))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('PathTraversalError 携带独立错误码 EPATHTRAVERSAL', () => {
    try {
      resolveSafePath(base, '.');
      expect.unreachable('应抛出 PathTraversalError');
    } catch (err) {
      expect(err).toBeInstanceOf(PathTraversalError);
      expect(err.code).toBe('EPATHTRAVERSAL');
      expect(err.message).toBeTruthy();
    }
  });

  describe('符号链接防线', () => {
    // Windows 创建符号链接需要管理员权限或开发者模式：探测一次，不可用则跳过
    let symlinkSupported = false;
    try {
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-symlink-probe-'));
      try {
        fs.symlinkSync('probe-target', path.join(probe, 'probe-link'), 'file');
        symlinkSupported = true;
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }
    } catch {}

    let outside;

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fsutils-out-'));
      fs.writeFileSync(path.join(outside, 's.txt'), 'secret');
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it.skipIf(!symlinkSupported)('符号链接指向外部文件 → 拒绝（realpath 越界）', () => {
      fs.symlinkSync(path.join(outside, 's.txt'), path.join(base, 'link.txt'), 'file');
      expect(() => resolveSafePath(base, 'link.txt')).toThrow(PathTraversalError);
    });

    it.skipIf(!symlinkSupported)('符号链接目录及其嵌套子路径 → 拒绝', () => {
      fs.symlinkSync(outside, path.join(base, 'linkdir'), 'junction');
      expect(() => resolveSafePath(base, 'linkdir')).toThrow(PathTraversalError);
      expect(() => resolveSafePath(base, 'linkdir/s.txt')).toThrow(PathTraversalError);
    });

    it.skipIf(!symlinkSupported)('最终目标符号链接（即使指向实例内）一律拒绝', () => {
      fs.symlinkSync(path.join(base, 'sub', 'file.txt'), path.join(base, 'link-inside.txt'), 'file');
      expect(() => resolveSafePath(base, 'link-inside.txt')).toThrow(PathTraversalError);
    });

    it.skipIf(!symlinkSupported)('实例内目录指向实例内目标（非最终目标）不受影响', () => {
      // 中间组件符号链接指向实例内目录：realpath 校验通过，仅拒绝最终目标链接
      const inner = path.join(base, 'inner-real');
      fs.mkdirSync(inner);
      fs.writeFileSync(path.join(inner, 'f.txt'), 'x');
      fs.symlinkSync(inner, path.join(base, 'sub', 'inner-link'), 'junction');
      const full = resolveSafePath(base, 'sub/inner-link/f.txt');
      expect(full).toBe(path.resolve(base, 'sub', 'inner-link', 'f.txt'));
    });
  });
});

// ── 存在性判定纪律的执行件（existsSync TOCTOU 收敛）─────────────
describe('fs-utils ensureDir', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-ensure-dir-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('多级目录一次创建', () => {
    const target = path.join(root, 'a', 'b', 'c');
    ensureDir(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it('已存在时幂等（不抛 EEXIST，目录内容保留）', () => {
    const target = path.join(root, 'a');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');

    expect(() => ensureDir(target)).not.toThrow();
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('x');
  });
});

describe('fs-utils renameNoClobber', () => {
  let root;
  const at = (name) => path.join(root, name);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-rename-noclobber-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('文件：正常重命名（内容随文件走，源消失）', () => {
    fs.writeFileSync(at('src.txt'), 'payload');
    renameNoClobber(at('src.txt'), at('dst.txt'));

    expect(fs.readFileSync(at('dst.txt'), 'utf-8')).toBe('payload');
    expect(fs.existsSync(at('src.txt'))).toBe(false);
  });

  it('文件：目标已存在 → 抛 EEXIST，且目标原内容未被覆盖（这是本助手存在的理由）', () => {
    fs.writeFileSync(at('src.txt'), 'NEW');
    fs.writeFileSync(at('dst.txt'), 'OLD');

    expect(() => renameNoClobber(at('src.txt'), at('dst.txt')))
      .toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(at('dst.txt'), 'utf-8')).toBe('OLD');
    // 失败路径不留残件：源仍在、目标未被清空
    expect(fs.readFileSync(at('src.txt'), 'utf-8')).toBe('NEW');
  });

  it('文件：源不存在 → 抛 ENOENT 且不留下占位文件', () => {
    expect(() => renameNoClobber(at('missing.txt'), at('dst.txt')))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(fs.existsSync(at('dst.txt'))).toBe(false);
  });

  it('目录：正常重命名（含内部文件）', () => {
    fs.mkdirSync(at('srcDir'));
    fs.writeFileSync(path.join(at('srcDir'), 'inner.txt'), 'x');
    renameNoClobber(at('srcDir'), at('dstDir'));

    expect(fs.statSync(at('dstDir')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(at('dstDir'), 'inner.txt'), 'utf-8')).toBe('x');
    expect(fs.existsSync(at('srcDir'))).toBe(false);
  });

  it('目录：目标已存在 → 抛 EEXIST，且目标目录保留（源码目录未被搬走）', () => {
    fs.mkdirSync(at('srcDir'));
    fs.mkdirSync(at('dstDir'));

    expect(() => renameNoClobber(at('srcDir'), at('dstDir')))
      .toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.existsSync(at('dstDir'))).toBe(true);
    expect(fs.existsSync(at('srcDir'))).toBe(true);
  });
});

describe('fs-utils atomicWriteFile', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-atomic-write-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('覆盖已有目标且不留临时文件', () => {
    const target = path.join(root, 'f.txt');
    fs.writeFileSync(target, 'old');
    atomicWriteFile(target, 'new');

    expect(fs.readFileSync(target, 'utf-8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['f.txt']);
  });

  it('目标不存在时直接创建', () => {
    const target = path.join(root, 'fresh.txt');
    atomicWriteFile(target, 'v1');
    expect(fs.readFileSync(target, 'utf-8')).toBe('v1');
  });

  it('rename 失败（目标是目录）时不破坏目标，且清掉残留临时文件', () => {
    const dirTarget = path.join(root, 'dir-target');
    fs.mkdirSync(dirTarget);

    expect(() => atomicWriteFile(dirTarget, 'x')).toThrow();
    expect(fs.statSync(dirTarget).isDirectory()).toBe(true);
    // 目录里没有内容，且同层只剩目标目录本身（临时文件已被 finally 清掉）
    expect(fs.readdirSync(root)).toEqual(['dir-target']);
  });

  it('父目录不存在时抛错且不留下半个目标文件', () => {
    const target = path.join(root, 'nope', 'f.txt');
    expect(() => atomicWriteFile(target, 'x')).toThrow();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  // Windows 无 POSIX 权限位（statSync().mode 恒 0o666 形态），权限断言只在 Linux/macOS 有效
  it.skipIf(process.platform === 'win32')('options.mode 落到最终文件上（.env 0600 场景）', () => {
    const target = path.join(root, '.env');
    atomicWriteFile(target, 'API_KEY_HASH=abc\n', { mode: 0o600 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  // Windows 杀软/索引服务短暂持有目标文件时 rename 瞬时抛 EPERM/EACCES/EBUSY
  // （keys-hash 轮换用例「全量首跑偶红、复跑与隔离跑全绿」的历史 flake 的候选机理之一，
  // 未用失败现场栈闭环——下次偶红先抓完整失败栈区分断言失败 vs teardown 清理错误），
  // 生产代码以有界重试根除——以下用例锁住重试契约，防静默退化
  it('rename 遇瞬时共享冲突（EPERM）重试后成功', () => {
    const target = path.join(root, 'f.txt');
    fs.writeFileSync(target, 'old');
    const realRename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => { throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); })
      .mockImplementation(realRename);
    try {
      atomicWriteFile(target, 'new');
      expect(fs.readFileSync(target, 'utf-8')).toBe('new');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('瞬时冲突（%s）持续存在时重试到上限后抛出（不无限重试）', (code) => {
    const target = path.join(root, 'f.txt');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code });
    });
    try {
      expect(() => atomicWriteFile(target, 'x')).toThrow(expect.objectContaining({ code }));
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('非瞬时错误（ENOENT）不重试立即抛出', () => {
    const target = path.join(root, 'f.txt');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    try {
      expect(() => atomicWriteFile(target, 'x')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 路径包含校验收敛（三实现单源化）：解析面 resolveContainedPath 与文本面
// isPathContained 的差异维度矩阵（相等排除 / symlink / base 存在性 / 大小写）──
describe('fs-utils resolveContainedPath（解析面，绝对/混合 target）', () => {
  let root;
  let base;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-resolve-contained-'));
    base = path.join(root, 'base');
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, 'file.txt'), 'data');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('绝对 target 在 base 内 → 返回归一化绝对路径', () => {
    expect(resolveContainedPath(base, path.join(base, 'sub', 'x'))).toBe(path.join(base, 'sub', 'x'));
  });

  it('相对 target 按 base 拼接（不依赖进程 CWD）', () => {
    expect(resolveContainedPath(base, 'sub/x')).toBe(path.join(base, 'sub', 'x'));
  });

  it('target 等于 base：默认拒绝，allowRoot 放行', () => {
    expect(() => resolveContainedPath(base, base)).toThrow(PathTraversalError);
    expect(resolveContainedPath(base, base, { allowRoot: true })).toBe(base);
  });

  it('兄弟目录前缀陷阱（base-evil）拒绝', () => {
    const evil = path.join(root, 'base-evil');
    fs.mkdirSync(evil);
    expect(() => resolveContainedPath(base, evil)).toThrow(PathTraversalError);
  });

  it('.. 逃逸与 NUL 字节拒绝', () => {
    expect(() => resolveContainedPath(base, path.join(base, '..', 'evil'))).toThrow(PathTraversalError);
    expect(() => resolveContainedPath(base, 'a\0b')).toThrow(PathTraversalError);
  });

  it('缺失叶子（无 symlink）通过：前缀 + 逐段 realpath 兜底', () => {
    expect(resolveContainedPath(base, path.join(base, 'new', 'deep'))).toBe(path.join(base, 'new', 'deep'));
  });

  // Windows 创建符号链接需要管理员权限或开发者模式：探测一次，不可用则跳过
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-symlink-probe2-'));
  let symlinkSupported = false;
  try {
    fs.symlinkSync('probe-target', path.join(probe, 'probe-link'), 'file');
    symlinkSupported = true;
  } catch {}
  finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }

  it.skipIf(!symlinkSupported)('中间目录 symlink 指向 base 外 + 叶子缺失 → 拒绝（旧 backup 实现的漏检面）', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(base, 'world'), 'junction');
    // 叶子不存在，旧实现（只对完整目标 realpath）会因 realpath ENOENT 而放行
    expect(() => resolveContainedPath(base, path.join(base, 'world', 'newfile')))
      .toThrow(PathTraversalError);
  });

  it.skipIf(!symlinkSupported)('最终目标 symlink（即使指向 base 内）拒绝：第 ④ 步', () => {
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'junction');
    expect(() => resolveContainedPath(base, path.join(base, 'link'))).toThrow(PathTraversalError);
  });

  it('base 不存在：缺省抛 ENOENT，baseMustExist=false 容忍（备份先校验后判存在的口径）', () => {
    const missing = path.join(root, 'no-such-base');
    expect(() => resolveContainedPath(missing, path.join(missing, 'world')))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(resolveContainedPath(missing, path.join(missing, 'world'), { baseMustExist: false }))
      .toBe(path.join(missing, 'world'));
  });
});

describe('fs-utils isPathContained（文本面，内部候选过滤）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-text-contained-'));
  const base = path.join(root, 'base');
  fs.mkdirSync(base);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('相等允许（与解析面的唯一语义分歧之一）：「实例根本身」是合法候选', () => {
    expect(isPathContained(base, base)).toBe(true);
  });

  it('子路径与相对 target 拼接', () => {
    expect(isPathContained(base, path.join(base, 'world', 'x'))).toBe(true);
    expect(isPathContained(base, 'world/x')).toBe(true);
  });

  it('兄弟前缀陷阱与 .. 逃逸拒绝', () => {
    expect(isPathContained(base, path.join(root, 'base-evil', 'x'))).toBe(false);
    expect(isPathContained(base, path.join(base, '..', 'evil'))).toBe(false);
  });

  it('symlink 维度：文本面不跟随也不检测（合法 symlink 世界目录放行）', () => {
    // 与解析面的关键分歧：文本面零 fs 判定，路径字面在 base 内即 true
    expect(isPathContained(base, path.join(base, 'world-symlinked', 'players'))).toBe(true);
  });

  it('大小写维度：前缀按字面比较、不折叠（Windows 上只误拒不误放）', () => {
    expect(isPathContained(base, path.join(root, 'BASE', 'sub'))).toBe(false);
  });
});
