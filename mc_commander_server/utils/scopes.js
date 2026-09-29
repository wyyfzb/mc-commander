/**
 * 机器凭据的作用域目录（scope catalog）与「端点 → 所需作用域」的唯一映射。
 *
 * 设计意图（owner 2026-09-27 拍板）：让用户自己的 AI 通过面板接口做运维，而
 * **权限在接口层限制**——比提示词约束可靠（OWASP LLM03 *Excessive Agency* 首条缓解
 * 即 complete mediation：鉴权必须落在下游系统，不能靠模型自行判断）。
 *
 * 三条口径：
 * 1. **命名用扁平 `resource:action`**（如 `instance:read`），不做 ABAC、不做实例级 ACL。
 * 2. **本模块是「端点需要什么」的唯一声明源**：`READONLY_ALLOWED` 不再独立维护，
 *    而是从本表推导——两处各写一份必然漂移，且漂移方向是「白名单比作用域更宽」＝越权。
 * 3. **fail-closed**：不在表内的端点**没有任何作用域能满足**，因此对受限凭据一律拒绝。
 *    登记的是**放行**而非拒绝，漏登记只会更严、不会更松。
 */

/** 作用域取值。一期只交付只读作用域（不开任何写操作）。 */
export const SCOPES = Object.freeze({
  /** 整机与实例的实时读数（概览、系统指标） */
  SYSTEM_READ: 'system:read',
  /** 实例列表与单个实例的读数 */
  INSTANCE_READ: 'instance:read',
  /** 实例内玩家在线读数 */
  PLAYER_READ: 'player:read',
});

/** 全部已定义作用域（校验入参用） */
export const ALL_SCOPES = Object.freeze(Object.values(SCOPES));

/**
 * 一期对外发放的作用域集合＝只读作用域全集。
 * 单独列出（而非等于 ALL_SCOPES）是为了将来加写作用域时，这里**必须显式改**
 * ——新作用域不会因为「加进 SCOPES」就自动变得可发放。
 */
export const READONLY_SCOPES = Object.freeze([
  SCOPES.SYSTEM_READ,
  SCOPES.INSTANCE_READ,
  SCOPES.PLAYER_READ,
]);

/** 作用域是否只读（描述性判据，用于「发放边界」的注释与审查；判定本身看 GRANTABLE_SCOPES） */
export function isReadonlyScope(scope) {
  return READONLY_SCOPES.includes(scope);
}

/**
 * **可发放**给机器凭据的作用域（一期＝只读全集）。
 *
 * 与 ALL_SCOPES 分开是**安全边界**而非冗余：将来 `SCOPES` 里加了写作用域，
 * 它不会因为「被定义了」就自动变得可发放——必须有人显式把作用域加进本表。
 * 契约的 zod 枚举只锁「语法上认得的取值」，本表锁「允许授予的取值」，两者互补。
 */
export const GRANTABLE_SCOPES = Object.freeze([...READONLY_SCOPES]);

/** 作用域是否**可发放**给机器凭据——发放边界的唯一判据 */
export function isGrantableScope(scope) {
  return GRANTABLE_SCOPES.includes(scope);
}

/**
 * 把请求的作用域分成「可发放」与「不可发放」两组。
 *
 * 之所以是独立纯函数、而不是写在路由里的一个 filter：**这个判定必须能被直接测到**。
 * 契约的 zod 枚举会先把写作用域/未知作用域挡掉，导致路由里那句 filter 在 HTTP 层
 * 永远走不到（变异探针实测：删掉它全部用例仍绿 ⇒ 那是不可测的死代码）。
 * 抽成纯函数后它既能在单元层被断言，又能在契约放宽的那天真正生效。
 */
export function partitionGrantable(requested) {
  const { scopes, unknown } = parseScopes(requested);
  const grantable = scopes.filter((s) => GRANTABLE_SCOPES.includes(s));
  const ungrantable = scopes.filter((s) => !GRANTABLE_SCOPES.includes(s));
  return { grantable, ungrantable, unknown };
}

/**
 * 端点 → 所需作用域。键为 `METHOD 路径`，路径相对 v1Router 挂载点（/api/v1），
 * `:param` 为任意单段占位（与 middleware/auth.js 的段级匹配同构）。
 *
 * 收录标准（沿用既有只读白名单口径）：只读监控/仪表盘真正需要的实时状态观测端点，
 * 且不返回凭据、文件内容、日志、配置内容、命令史、备份、会话或审计明细。
 * 返回历史/管理记录的一律不收。
 *
 * **白名单只决定「能不能进」，不保证「进来后看到什么」**：命中本表的端点若其响应含
 * 凭据可能驻留的字段，必须在**出参构造处**按作用域裁剪（见 routes/status.js 的
 * statusForRole——/instances 两条即此例）。
 */
export const SCOPE_ENDPOINTS = Object.freeze([
  ['GET /overview', SCOPES.SYSTEM_READ],
  ['GET /system-stats', SCOPES.SYSTEM_READ],
  ['GET /instances', SCOPES.INSTANCE_READ],
  ['GET /instances/:id', SCOPES.INSTANCE_READ],
  ['GET /instances/:id/players', SCOPES.PLAYER_READ],
]);

/**
 * **不需要任何作用域**的端点：任何已认证凭据（含作用域化凭据）均可访问。
 *
 * 存在的理由：这类端点只回显**调用方自己的身份**（名字与作用域），不读取任何服务端
 * 资源——调用方早就持有那份信息，放行不产生新的信息暴露。没有它，AI/脚本只能靠
 * 「发一个请求看是否 403」试错来判断自己的权限面。
 *
 * 仍然 fail-closed：只有显式登记在此的端点免作用域，其余一律按 SCOPE_ENDPOINTS 判。
 */
export const SCOPE_FREE_ENDPOINTS = Object.freeze(['GET /machine-credentials/self']);

/** 端点为「免作用域的身份自省面」 */
export function isScopeFreeEndpoint(method, reqPath) {
  return SCOPE_FREE_ENDPOINTS.some((entry) => matchesPattern(method, entry, reqPath));
}

/** 路径 → 非空段数组（首尾斜杠不产生段） */
function segments(p) {
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

/**
 * 段级匹配：模式与请求路径段数必须一致，`:param` 段接受任意非空段。
 * 路径尾部斜杠由调用方归一化（与 Express 路由 `strict:false` 一致）。
 * 空段（`//`）一律不匹配：Express 的 `:param` 不匹配空段，若按「过滤空段后比对」
 * 放行，判断就会比路由表更宽。
 */
export function matchesPattern(method, pattern, reqPath) {
  const [patternMethod, patternPath] = pattern.split(' ');
  if (patternMethod !== method) return false;
  const expected = segments(patternPath);
  const actual = segments(reqPath);
  if (expected.includes('') || actual.includes('')) return false;
  if (expected.length !== actual.length) return false;
  return expected.every((seg, i) => seg.startsWith(':') || seg === actual[i]);
}

/**
 * 该方法+路径所需的作用域；无任何作用域可满足时返回 null（调用方据此拒绝）。
 * 导出供路由表枚举测试直接断言，避免测试另写一份匹配逻辑而与运行时漂移。
 */
export function requiredScope(method, reqPath) {
  for (const [pattern, scope] of SCOPE_ENDPOINTS) {
    if (matchesPattern(method, pattern, reqPath)) return scope;
  }
  return null;
}

/**
 * 作用域是否覆盖该方法+路径。
 * 注意参数顺序：**先解析所需作用域，再判持有**——反过来写会让「端点无作用域」
 * （null）与「凭据无作用域」互相掩盖。
 */
export function scopeCovers(method, reqPath, heldScopes) {
  if (isScopeFreeEndpoint(method, reqPath)) return true;
  const needed = requiredScope(method, reqPath);
  if (needed === null) return false;
  return Array.isArray(heldScopes) && heldScopes.includes(needed);
}

/**
 * 只读凭据可达的端点清单——**由 SCOPE_ENDPOINTS 推导**，不独立维护。
 *
 * 推导用的是**发放边界**（`isGrantableScope`）而非描述性的 `isReadonlyScope`：
 * 两者今天等价，但真正决定「机器凭据能被授予什么」的是 GRANTABLE_SCOPES，让
 * 「可授予什么」与「能进哪些门」共用一个判据，才不会在加写作用域时各说一套。
 *
 * 含两类：① 需要可发放作用域的端点；② **免作用域端点**——后者任何已认证凭据均可访问
 * （含只读），故它确实属于「只读能进的门」。把 ② 纳入本表是为了让
 * `READONLY_ALLOWED` 与 `isReadonlyAllowed` 逐条一致：两者若各说一套，安全审查与
 * 枚举测试就会得出不同的「放行面」，而漂移方向恰好是越权。
 */
export const READONLY_ALLOWED = Object.freeze([
  ...SCOPE_ENDPOINTS.filter(([, scope]) => isGrantableScope(scope)).map(([pattern]) => pattern),
  ...SCOPE_FREE_ENDPOINTS,
]);

/** 只读作用域是否可访问该方法+路径（等价于 scopeCovers + READONLY_SCOPES） */
export function isReadonlyAllowed(method, reqPath) {
  return scopeCovers(method, reqPath, READONLY_SCOPES);
}

/**
 * 解析并校验作用域字符串列表：去重、剔除空值、拒绝未知作用域。
 * 返回 `{ scopes, unknown }`——未知项**不静默丢弃**（丢弃会把「写错了作用域名」
 * 变成「凭据权限比预期小」，用户只会看到莫名其妙的 403；调用方据此报错）。
 */
export function parseScopes(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const scopes = [];
  const unknown = [];
  for (const raw of list) {
    const scope = String(raw ?? '').trim();
    if (!scope) continue;
    if (!ALL_SCOPES.includes(scope)) {
      if (!unknown.includes(scope)) unknown.push(scope);
      continue;
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return { scopes, unknown };
}

/** 序列化为存储形态（逗号分隔；与 parseScopes 的字符串分支对偶） */
export function serializeScopes(scopes) {
  return parseScopes(scopes).scopes.join(',');
}

export default {
  SCOPES,
  ALL_SCOPES,
  READONLY_SCOPES,
  GRANTABLE_SCOPES,
  SCOPE_ENDPOINTS,
  SCOPE_FREE_ENDPOINTS,
  READONLY_ALLOWED,
  isReadonlyScope,
  isGrantableScope,
  partitionGrantable,
  requiredScope,
  scopeCovers,
  isReadonlyAllowed,
  isScopeFreeEndpoint,
  matchesPattern,
  parseScopes,
  serializeScopes,
};
