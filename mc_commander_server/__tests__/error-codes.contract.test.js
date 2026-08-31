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

/** 递归获取目录下所有 .js 文件（排除 node_modules） */
function collectJsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/** 在源码中搜索 ErrorCodes.KEY 的引用 */
function isReferenced(keyName) {
  const pattern = `ErrorCodes.${keyName}`;
  const allFiles = [...collectJsFiles(SRC_DIR)];
  // 也检查测试文件中对 code 数值的直接引用（如 expect(res.body.code).toBe(40903)）
  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    if (content.includes(pattern)) return true;
  }
  return false;
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
