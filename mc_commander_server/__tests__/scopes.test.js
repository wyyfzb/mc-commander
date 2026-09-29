import { describe, it, expect } from 'vitest';
import {
  SCOPES,
  ALL_SCOPES,
  READONLY_SCOPES,
  SCOPE_ENDPOINTS,
  SCOPE_FREE_ENDPOINTS,
  READONLY_ALLOWED,
  requiredScope,
  scopeCovers,
  isReadonlyAllowed,
  isScopeFreeEndpoint,
  isReadonlyScope,
  matchesPattern,
  parseScopes,
  serializeScopes,
  GRANTABLE_SCOPES,
  partitionGrantable,
} from '../utils/scopes.js';

/**
 * 作用域目录单测。
 *
 * 重点不在「函数能跑」，而在几条**安全不变量**：
 * - 目录与白名单必须一致（两处各说一套 ⇒ 安全审查与枚举测试得出不同放行面）
 * - 未登记端点必须**无任何作用域可满足**（fail-closed 的根）
 * - 段级匹配不得比路由表更宽（空段 / 尾斜杠 / 长度不等等边界）
 */

describe('作用域目录的完整性', () => {
  it('一期只发放只读作用域（写作用域不得混入 READONLY_SCOPES）', () => {
    expect(READONLY_SCOPES).toEqual([SCOPES.SYSTEM_READ, SCOPES.INSTANCE_READ, SCOPES.PLAYER_READ]);
    expect(READONLY_SCOPES.every((s) => isReadonlyScope(s))).toBe(true);
    // 已知的全部作用域＝只读作用域：本条会在新增写作用域时变红，逼作者显式决定
    // 「它是否可发放给机器凭据」，而不是悄悄生效
    expect([...ALL_SCOPES].sort()).toEqual([...READONLY_SCOPES].sort());
  });

  it('SCOPE_ENDPOINTS 的每条作用域都在 ALL_SCOPES 内（防笔误造出永不生效的条目）', () => {
    for (const [pattern, scope] of SCOPE_ENDPOINTS) {
      expect(ALL_SCOPES, `条目 ${pattern} 的作用域 ${scope} 未定义`).toContain(scope);
    }
  });

  it('READONLY_ALLOWED 与「只读作用域可覆盖」逐条一致（含免作用域端点）', () => {
    for (const entry of READONLY_ALLOWED) {
      const [method, pattern] = entry.split(' ');
      expect(isReadonlyAllowed(method, pattern), `${entry} 在白名单内但判定为不可达`).toBe(true);
    }
    // 反向：需要写作用域（或未登记）的端点不得出现在白名单里
    expect(READONLY_ALLOWED).toHaveLength(
      SCOPE_ENDPOINTS.filter(([, s]) => isReadonlyScope(s)).length + SCOPE_FREE_ENDPOINTS.length,
    );
  });
});

describe('requiredScope / scopeCovers（fail-closed 的根）', () => {
  it('已登记端点解析出预期作用域', () => {
    expect(requiredScope('GET', '/overview')).toBe(SCOPES.SYSTEM_READ);
    expect(requiredScope('GET', '/system-stats')).toBe(SCOPES.SYSTEM_READ);
    expect(requiredScope('GET', '/instances')).toBe(SCOPES.INSTANCE_READ);
    expect(requiredScope('GET', '/instances/abc')).toBe(SCOPES.INSTANCE_READ);
    expect(requiredScope('GET', '/instances/abc/players')).toBe(SCOPES.PLAYER_READ);
  });

  it('未登记端点返回 null，且任何作用域组合都不满足（漏登记只会更严）', () => {
    for (const [method, path] of [
      ['GET', '/audit-logs'],
      ['GET', '/command-history'],
      ['GET', '/instances/abc/files'],
      ['POST', '/instances/abc/command'],
      ['GET', '/machine-credentials'],
    ]) {
      expect(requiredScope(method, path), `${method} ${path} 不该有作用域`).toBe(null);
      expect(scopeCovers(method, path, READONLY_SCOPES), `${method} ${path} 不该被覆盖`).toBe(
        false,
      );
      expect(scopeCovers(method, path, ALL_SCOPES), `${method} ${path} 持全集也不该被覆盖`).toBe(
        false,
      );
    }
  });

  it('只持有部分作用域时不越权：system:read 打不开 instance 端点', () => {
    expect(scopeCovers('GET', '/system-stats', [SCOPES.SYSTEM_READ])).toBe(true);
    expect(scopeCovers('GET', '/instances', [SCOPES.SYSTEM_READ])).toBe(false);
    expect(scopeCovers('GET', '/instances/abc/players', [SCOPES.INSTANCE_READ])).toBe(false);
    expect(scopeCovers('GET', '/instances/abc/players', [SCOPES.PLAYER_READ])).toBe(true);
  });

  it('方法必须匹配：GET 的作用域不能用于 POST 同路径', () => {
    expect(scopeCovers('POST', '/instances', READONLY_SCOPES)).toBe(false);
    expect(scopeCovers('DELETE', '/instances/abc', READONLY_SCOPES)).toBe(false);
  });

  it('作用域列表非数组时一律不覆盖（不下标 undefined、不因类型意外放行）', () => {
    for (const bad of [null, undefined, 'instance:read', 42, {}]) {
      expect(scopeCovers('GET', '/instances', bad)).toBe(false);
    }
  });

  it('免作用域端点：任何已认证凭据（含空作用域）均可访问', () => {
    const [entry] = SCOPE_FREE_ENDPOINTS;
    const [method, path] = entry.split(' ');
    expect(isScopeFreeEndpoint(method, path)).toBe(true);
    expect(scopeCovers(method, path, [])).toBe(true);
    expect(scopeCovers(method, path, null)).toBe(true);
    expect(requiredScope(method, path)).toBe(null); // 它不需要作用域
  });
});

describe('matchesPattern 段级匹配边界', () => {
  it('段数一致、:param 接受任意非空段', () => {
    expect(matchesPattern('GET', 'GET /instances/:id', '/instances/abc')).toBe(true);
    expect(matchesPattern('GET', 'GET /instances/:id', '/instances/abc/players')).toBe(false);
    expect(matchesPattern('GET', 'GET /instances', '/instances/abc')).toBe(false);
  });

  it('尾斜杠归一化后同判（与 Express strict:false 一致）', () => {
    expect(matchesPattern('GET', 'GET /instances', '/instances/')).toBe(true);
    expect(matchesPattern('GET', 'GET /instances/:id', '/instances/abc/')).toBe(true);
  });

  it('空段一律不匹配：// 不得被当成合法路径', () => {
    expect(matchesPattern('GET', 'GET /instances/:id', '/instances//')).toBe(false);
    expect(matchesPattern('GET', 'GET /instances', '//')).toBe(false);
  });

  it('方法不同不匹配', () => {
    expect(matchesPattern('POST', 'GET /instances', '/instances')).toBe(false);
  });
});

describe('parseScopes / serializeScopes', () => {
  it('去重、剥空白、保序', () => {
    expect(parseScopes(['instance:read', ' system:read ', 'instance:read']).scopes).toEqual([
      'instance:read',
      'system:read',
    ]);
  });

  it('未知作用域**不静默丢弃**：单独回报（丢弃会把「写错了名字」变成「权限莫名变小」）', () => {
    const { scopes, unknown } = parseScopes(['instance:read', 'bogus', 'admin:all']);
    expect(scopes).toEqual(['instance:read']);
    expect(unknown).toEqual(['bogus', 'admin:all']);
  });

  it('接受逗号分隔字符串，并容忍空项', () => {
    expect(parseScopes('system:read,,player:read').scopes).toEqual(['system:read', 'player:read']);
  });

  it('非数组/非字符串输入得到空集（fail-closed，不是「全给」）', () => {
    for (const bad of [null, undefined, 42, {}, true]) {
      expect(parseScopes(bad).scopes).toEqual([]);
    }
  });

  it('serialize 与 parse 对偶', () => {
    expect(serializeScopes(['instance:read', 'system:read'])).toBe('instance:read,system:read');
    expect(parseScopes(serializeScopes(['player:read'])).scopes).toEqual(['player:read']);
    expect(serializeScopes([])).toBe('');
  });
});

describe('发放边界：GRANTABLE_SCOPES 与 partitionGrantable', () => {
  it('可发放集合一期＝只读全集（写作用域不得出现在这里）', () => {
    expect(GRANTABLE_SCOPES).toEqual([...READONLY_SCOPES]);
    expect(GRANTABLE_SCOPES).not.toContain('instance:write');
  });

  it('可发放项与其余项被分开回报（今天未定义的取值落 unknown）', () => {
    // 今天 ALL_SCOPES == READONLY_SCOPES == GRANTABLE_SCOPES，故「已定义但不可发放」这一桶
    // 必然为空；写作用域此刻尚未定义，落在 unknown 桶。关键安全性质不变：
    // **任何非可发放取值都不得出现在 grantable 里**。
    const r = partitionGrantable(['instance:read', 'instance:write', 'bogus']);
    expect(r.grantable).toEqual(['instance:read']);
    expect(r.ungrantable).toEqual([]);
    expect(r.unknown).toEqual(['instance:write', 'bogus']);
  });

  it('「已定义但不可发放」今天为空，且这条断言会在写作用域落地时变红', () => {
    // ungrantable 桶是给「契约放行、但策略不许发放」准备的防线。今天没有这样的取值，
    // 故断言为空——一旦有人往 SCOPES 加了写作用域却忘了同步决定它是否可发放，
    // 这条会变红，逼他显式表态，而不是让新作用域悄悄变得可发放
    const definedButNotGrantable = ALL_SCOPES.filter((s) => !GRANTABLE_SCOPES.includes(s));
    expect(definedButNotGrantable).toEqual([]);
  });

  it('全部可发放时另两组为空（反向对照：不会把合法项误判成越权）', () => {
    const r = partitionGrantable(['system:read', 'instance:read', 'player:read']);
    expect(r.grantable).toHaveLength(3);
    expect(r.ungrantable).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('未知作用域不会被当成可发放（否则笔误就等于授权）', () => {
    const r = partitionGrantable(['admin:all']);
    expect(r.grantable).toEqual([]);
    expect(r.unknown).toEqual(['admin:all']);
  });

  it('空输入得到全空三组', () => {
    const r = partitionGrantable([]);
    expect(r).toEqual({ grantable: [], ungrantable: [], unknown: [] });
  });
});
