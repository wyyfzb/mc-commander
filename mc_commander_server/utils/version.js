import fs from 'fs';

// 版本号单一来源：package.json。惰性求值 + 缓存 + 兜底——
// 模块顶层 readFileSync 会与测试的 vi.mock('fs') 冲突（模块加载即崩，
// 见 status.endpoints.test.js 43 用例崩溃先例），失败回退占位值。
let cached = null;

export function getServerVersion() {
  if (cached !== null) return cached;
  try {
    cached = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ).version;
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
