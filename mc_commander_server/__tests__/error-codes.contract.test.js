/**
 * 错误码契约测试（issue #174）
 * 验证 ErrorCodes 注册表无码值碰撞、无僵尸码、前后端对齐。
 *
 * 规则：
 * 1. 每个 code 数值全局唯一（无碰撞）
 * 2. 每个已定义的 ErrorCodes 键都被至少一个路由/服务/Middleware 引用
 * 3. code 编号遵循 HTTP 状态类前缀约定（0=成功, 4xxxx=客户端, 5xxxx=服务端）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ErrorCodes } from '../utils/response.js';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../..');

/** 递归获取目录下所有 .js 文件（排除 node_modules）。
 *  目录扫描失败即跳过该支：并发用例可能在扫描间隙清理临时目录，让整个契约检查
 *  因 ENOENT 变红没有意义；真扫不到源码时下方「无僵尸码」会因全部键未命中而失败，
 *  不会静默放行。 */
function collectJsFiles(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

// 源码内容缓存：僵尸码逐键扫描不重复读盘（全量并发慢机器上逐键重读曾触发 5s 超时）
let sourceContents = [];

/** 在源码中搜索 ErrorCodes.KEY 的引用（源码内容由僵尸码 describe 的 beforeAll 一次性缓存） */
function isReferenced(keyName) {
  const pattern = `ErrorCodes.${keyName}`;
  return sourceContents.some((content) => content.includes(pattern));
}

describe('错误码契约：码值唯一性', () => {
  const entries = Object.entries(ErrorCodes);
  const codeMap = new Map();

  it('所有 ErrorCodes 条目 code 数值全局唯一（无碰撞）', () => {
    const collisions = [];
    for (const [name, entry] of entries) {
      const prev = codeMap.get(entry.code);
      if (prev) {
        collisions.push(`code ${entry.code}: ${prev} vs ${name}`);
      }
      codeMap.set(entry.code, name);
    }
    expect(collisions, `碰撞: ${collisions.join('; ')}`).toHaveLength(0);
  });

  it('SUCCESS 码为 0', () => {
    expect(ErrorCodes.SUCCESS.code).toBe(0);
  });

  it('客户端错误码 4xxxx 与服务端错误码 5xxxx 区分正确', () => {
    for (const [name, entry] of entries) {
      if (name === 'SUCCESS') continue;
      const code = entry.code;
      if (code >= 40000 && code < 50000) {
        expect(entry.status, `${name} code=${code} 应为 4xx HTTP 状态`).toBeGreaterThanOrEqual(400);
        expect(entry.status, `${name} code=${code} 应为 4xx HTTP 状态`).toBeLessThan(500);
      } else if (code >= 50000) {
        expect(entry.status, `${name} code=${code} 应为 5xx HTTP 状态`).toBeGreaterThanOrEqual(500);
      }
    }
  });
});

describe('错误码契约：僵尸码检测', () => {
  beforeAll(() => {
    sourceContents = collectJsFiles(SRC_DIR).map((f) => fs.readFileSync(f, 'utf-8'));
  });

  it('每个已定义的 ErrorCodes 键在源码中被引用（无僵尸码）', () => {
    const unreferenced = [];
    for (const [name] of Object.entries(ErrorCodes)) {
      if (!isReferenced(name)) {
        unreferenced.push(name);
      }
    }
    expect(unreferenced, `僵尸码（定义但未引用）: ${unreferenced.join(', ')}`).toHaveLength(0);
  });
});

describe('错误码契约：前后端对齐', () => {
  let frontendCodes;

  beforeAll(() => {
    const frontendErrorsPath = path.resolve(REPO_ROOT, 'mc_manager_web/src/api/errors.ts');
    const content = fs.readFileSync(frontendErrorsPath, 'utf-8');
    // 提取 ErrorCode 枚举中的数字常量
    frontendCodes = new Set();
    // 精确提取枚举值：KEY: NUMBER 模式
    const enumRegex = /:\s*(\d{4,5})\b/g;
    let match;
    while ((match = enumRegex.exec(content)) !== null) {
      frontendCodes.add(Number(match[1]));
    }
  });

  it('服务端每个错误码在前端 ErrorCode 枚举中有对应值', () => {
    const missing = [];
    for (const [name, entry] of Object.entries(ErrorCodes)) {
      if (name === 'SUCCESS') continue; // 前端不需要 SUCCESS 码
      if (!frontendCodes.has(entry.code)) {
        missing.push(`${name}(${entry.code})`);
      }
    }
    expect(missing, `前端缺失的错误码: ${missing.join(', ')}`).toHaveLength(0);
  });
});
