/**
 * 首访设密所有权证明：一次性 SETUP_TOKEN（audit S-P0-1 / issue #309）
 *
 * 威胁模型：服务绑定 0.0.0.0（公网/局域网）时，「部署完成 → 管理员设密」窗口内
 * 任何发现端口者可抢先 POST /auth/setup 永久接管面板。防御：部署脚本首次部署
 * 生成一次性 SETUP_TOKEN（openssl rand -hex 32）写入 .env 并随部署输出展示；
 * setup 请求必须携带 `Authorization: SetupToken <token>`（约定见 routes/auth.js
 * 顶部注释），校验通过后立即作废：
 *   1. 内存清空——同进程后续请求即失效；
 *   2. .env 移除 SETUP_TOKEN 行——服务重启后从 .env 读不到，同样失效。
 * 未配置 token 时保持原有行为（本机首发场景不受影响）；README/SECURITY.md
 * 说明公网部署必须通过部署脚本生成 token。
 *
 * 比对采用「长度判等 + crypto.timingSafeEqual」的常量时间语义，
 * 与 middleware/auth.js 的 API Key 校验一致，防时序侧信道。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { atomicWriteFile } from './fs-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** .env 路径与 config.js 的 dotenv 加载路径一致（服务端根目录） */
const DEFAULT_ENV_PATH = path.resolve(__dirname, '../.env');

/** 内存中的当前 token：模块加载时自 config（.env）读入，作废后即清空 */
let currentToken = config.setupToken || '';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 当前是否配置了 SETUP_TOKEN（决定 setup 路由是否强制校验） */
export function isSetupTokenRequired() {
  return currentToken.length > 0;
}

/**
 * 校验候选 token（常量时间比对）。
 * 未配置 token 时恒 false——调用方应先以 isSetupTokenRequired() 分流。
 * @param {unknown} candidate
 * @returns {boolean}
 */
export function verifySetupToken(candidate) {
  if (!currentToken) return false;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return safeEqual(candidate, currentToken);
}

/** 从 .env 文本中剥离 SETUP_TOKEN 行（保留 #SETUP_TOKEN= 注释与其他行原样） */
export function stripSetupTokenLines(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('SETUP_TOKEN='))
    .join('\n');
}

/**
 * 作废当前 token：内存无条件清空 + .env 移除 SETUP_TOKEN 行（best-effort，
 * 只读文件系统等写入失败时仅跳过，不抛出——内存清空已保证本进程内失效）。
 * @param {string} [envPath] 默认服务端根目录 .env（测试注入用）
 * @returns {{ cleared: boolean, envRemoved: boolean }}
 */
export function consumeSetupToken(envPath = DEFAULT_ENV_PATH) {
  const cleared = currentToken.length > 0;
  currentToken = '';
  let envRemoved = false;
  try {
    // 读取即判定：ENOENT ＝ 没有可改的 .env（不必先 existsSync），其余错误由外层
    // catch 兜住（best-effort）。写入走原子写 + 0600：.env 里存着 API Key 摘要，
    // 原地 truncate 写崩溃会把整份凭据文件截断
    const raw = fs.readFileSync(envPath, 'utf8');
    const next = stripSetupTokenLines(raw);
    if (next !== raw) {
      // 权限对齐部署脚本的 chmod 600 .env（仅属主可读写，.env 含凭据）
      atomicWriteFile(envPath, next, { mode: 0o600 });
      envRemoved = true;
    }
  } catch {
    // best-effort：写失败不阻断设密主流程（token 已在内存作废）
  }
  return { cleared, envRemoved };
}

/** 测试钩子：注入/清空 token（生产代码不调用） */
export function _setSetupToken(token) {
  currentToken = token || '';
}

/** 测试钩子：读取当前内存 token（作废断言用） */
export function _getSetupToken() {
  return currentToken;
}
