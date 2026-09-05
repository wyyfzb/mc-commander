import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveSafePath, PathTraversalError } from '../utils/fs-utils.js';

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
