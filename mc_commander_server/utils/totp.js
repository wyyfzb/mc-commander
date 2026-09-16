import crypto from 'crypto';

/**
 * TOTP（RFC 6238）两因素校验原语——零第三方密码学依赖。
 *
 * 参数刻意固定在主流认证器 App（Google Authenticator / Authy / 1Password /
 * Microsoft Authenticator）的默认口径上：SHA-1 + 6 位数字 + 30 秒步长。
 * SHA-1 在 HMAC 构造中不承担抗碰撞职责（HMAC-SHA1 仍无实用攻击），
 * 且是 otpauth 生态事实上的互操作基线——换 SHA-256 会让部分 App 静默算出错码。
 */

/** 动态口令位数（主流认证器默认，也是 otpauth URL 的 digits 参数） */
export const TOTP_DIGITS = 6;
/** 步长（秒）：RFC 6238 默认 30s，与认证器 App 一致 */
export const TOTP_PERIOD_SECONDS = 30;
/**
 * 漂移窗：接受 t-1 / t / t+1 三个步长（±30s）。
 * 取 ±1 而非更大窗口的理由：①手机与服务器时钟偏差（NTP 未同步、时区处理错误）
 * 实测通常在数秒内，±30s 已覆盖；②窗口每放宽一步，攻击者可试的码数线性增长
 * （3 个候选 → 6 位码的空间实际缩小 3 倍），而 6 位码本身只有 10^6 空间；
 * ③再加一层重放防护后，漂移窗不再是唯一防线。
 */
export const TOTP_DRIFT_STEPS = 1;
/** secret 字节数：RFC 4226 建议 HMAC-SHA1 密钥 ≥ 160 bit（= 20B → 32 位 base32） */
const TOTP_SECRET_BYTES = 20;

/**
 * RFC 4648 §6 的标准 base32 字母表（Table 3）：`A-Z` + `2-7`，pad 为 `=`。
 *
 * 这张表**包含 I(8)、L(11)、O(14)、U(20)**，正是认证器 App 生成/展示 secret 用的
 * 同一张表——解码侧因此不做去混淆（把 I/O 当表外字符会让合法 secret 无法使用；
 * RFC 4648 §3.4 只要求「解码器默认不应把 0 当 O、1 当 I/L」，即拒绝而非接受 0/1）。
 * 真正去混淆的是**恢复码**字母表（utils/recovery-codes.js，人工抄写场景），两者
 * 用意不同，不要互相靠拢。base32hex（§7，数字开头的另一张表）不在此列。
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 字节序列 → base32（无填充）：otpauth URL 与认证器 App 的 secret 编码格式 */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * base32 → Buffer（严格解码）。
 *
 * 容忍认证器/用户抄写时常见的分隔（空格、连字符）与大小写差异，以及尾部填充
 * `=`；其余一切非法形态返回 null（调用方按「secret 不可用」处理）：
 * - 字母表外字符（数字 0/1/8/9、符号、内嵌 `=`）——§3.3 要求拒绝；
 * - 数据字符数 % 8 ∈ {1,3,6}：§6 只允许 0/2/4/5/7 五种收尾量子；
 * - 填充不符：带 `=` 时总长必须是 8 的倍数，且 `=` 个数须与该数据长度匹配
 *   （§6 的 2+6 / 4+4 / 5+3 / 7+1 四种带填充形态）；
 * - 未使用的尾位非零（§3.5 canonical encoding）。
 *
 * 为什么必须这么严：静默丢弃不足 8 bit 的尾部会让**不同输入解出同一个密钥**
 * （`AB` 与 `ABA`、`MFRGG…LK` 与 `MFRGG…LKA` 都是同密钥）。这类「多抄/抄错一位
 * 仍然接受」的失败模式，用户看到的是「验证码永远不对」而不是「secret 格式
 * 错误」——既不可诊断，也让一个 App 无法导入的串在本服务端静默可用。
 */
export function base32Decode(input) {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  if (compact === '') return null;

  // 填充校验：`=` 只能出现在末尾，且个数与数据长度匹配（带填充时总长为 8 的倍数）
  let data = compact;
  const padIndex = compact.indexOf('=');
  if (padIndex !== -1) {
    const padding = compact.slice(padIndex);
    if (!/^=+$/.test(padding)) return null;
    if (compact.length % 8 !== 0) return null;
    data = compact.slice(0, padIndex);
    if (padding.length !== (8 - (data.length % 8)) % 8) return null;
  }
  if (data === '') return null;

  // 收尾量子：每 8 字符编码 5 字节，余数只能是 0/2/4/5/7
  const remainder = data.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) return null;

  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of data) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // 尾部不足 8 bit 的位必须为零（§3.5）：否则不同输入映射到同一密钥
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return Buffer.from(bytes);
}

/** 生成新 secret：20 字节 CSPRNG → base32（32 字符，可被认证器 App 直接录入） */
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));
}

/** 当前步长序号（Unix 秒 / 30s，向下取整） */
export function currentTimeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * HOTP（RFC 4226）：HMAC-SHA1 → 动态截断 → 取模 10^digits → 左侧补零。
 * counter 以 8 字节大端参与 HMAC（RFC 4226 §5.2 的 C 编码）。
 * @param {Buffer} key 已解码的密钥
 * @param {number} counter 步长序号
 */
export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** 指定步长的 6 位码；secret 非法返回 null */
export function totpCodeAtStep(secret, step) {
  const key = base32Decode(secret);
  if (!key) return null;
  return hotp(key, step);
}

/** 归一化用户输入的动态口令：容忍空格/连字符（App 与恢复码常见分组写法） */
export function normalizeTotpCode(code) {
  if (typeof code !== 'string') return null;
  const digits = code.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** 6 位定长串的恒时比较（两侧长度必为 6，不会触发 timingSafeEqual 的长度异常） */
function timingSafeEqualDigits(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 校验动态口令（漂移窗 + 重放防护）。
 *
 * 漂移窗：逐个试 t-1 / t / t+1 三个步长，全部算完再判定（不因中途命中提前
 * 返回），避免响应耗时泄漏「命中落在哪个窗口」。
 *
 * 重放防护：`lastAcceptedStep` 是上次被接受的步长（持久化在
 * admin_account.totp_last_step）。任何 ≤ 它的匹配一律判为 replay 并拒绝——
 * 即使该步长仍在漂移窗内。这条独立于漂移窗：没有它，同一个码在 ±30s 内可被
 * 重复使用（截屏/肩窥/日志泄漏后重放），漂移窗越宽可利用时间越长。
 *
 * 基线合理性护栏：基线只可能由「验证成功时的当前步长」写入，合法值不可能
 * 超过 current + 漂移窗（那是未来时刻的步长）。更大的值只能是损坏值（库被手工
 * 改写，或时钟前跳期间成功验证后残留）——若照旧参与比较，正确码会被永久判为
 * 重放（自锁死，只剩恢复码退路）。故**仅当基线越过 current + 漂移窗**时忽略它并
 * 放行（reason 标 `stale-baseline`，调用方会把本次步长写回，基线自愈）；
 * 窗口内与刚过去的基线一律照旧参与重放判定，护栏不构成绕过重放的路径。
 *
 * @param {string} secret base32 secret
 * @param {string} code 用户输入的 6 位码
 * @param {number|null} lastAcceptedStep 上次接受的步长（null = 无基线，首次接受任意窗）
 * @returns {{ ok: boolean, step: number|null, reason: 'ok'|'stale-baseline'|'no-secret'|'malformed'|'mismatch'|'replay' }}
 */
export function verifyTotpCode(secret, code, lastAcceptedStep = null) {
  const key = base32Decode(secret);
  if (!key) return { ok: false, step: null, reason: 'no-secret' };
  const candidate = normalizeTotpCode(code);
  if (candidate === null) return { ok: false, step: null, reason: 'malformed' };

  const current = currentTimeStep();
  let matchedStep = null;
  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset += 1) {
    const step = current + offset;
    if (timingSafeEqualDigits(hotp(key, step), candidate)) matchedStep = step;
  }
  if (matchedStep === null) return { ok: false, step: null, reason: 'mismatch' };

  const staleBaseline =
    lastAcceptedStep !== null && lastAcceptedStep > current + TOTP_DRIFT_STEPS;
  if (!staleBaseline && lastAcceptedStep !== null && matchedStep <= lastAcceptedStep) {
    return { ok: false, step: null, reason: 'replay' };
  }
  return {
    ok: true,
    step: matchedStep,
    reason: staleBaseline ? 'stale-baseline' : 'ok',
  };
}

/**
 * otpauth:// 挂靠 URI（认证器 App 扫码/手抄的唯一录入载体）。
 *
 * 编码口径按 Key URI Format 统一走百分号编码（`encodeURIComponent`）：
 * label 是 `issuer:account`，两段各自编码、`:` 作分隔符保持字面量；query 值同样
 * 百分号编码——`URLSearchParams` 会把空格编成 `+`，而 otpauth 客户端按 URI 语义
 * 逐字解析（`+` 不是空格），会得到发行方名 `MC+Commander` 这类错值。
 */
export function buildOtpauthUrl({ secret, issuer, account }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = [
    ['secret', secret],
    ['issuer', issuer],
    ['algorithm', 'SHA1'],
    ['digits', String(TOTP_DIGITS)],
    ['period', String(TOTP_PERIOD_SECONDS)],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `otpauth://totp/${label}?${params}`;
}

export default {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_DRIFT_STEPS,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  currentTimeStep,
  hotp,
  totpCodeAtStep,
  normalizeTotpCode,
  verifyTotpCode,
  buildOtpauthUrl,
};
