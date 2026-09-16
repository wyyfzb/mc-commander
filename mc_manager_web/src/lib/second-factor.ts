/**
 * 第二因子（TOTP / 恢复码）输入纪律的单一事实源。
 *
 * 服务端按**形状**分流：6 位数字走动态口令（RFC 6238，含漂移窗与重放防护），
 * 其余形状走一次性恢复码（见 mc_commander_server/routes/auth.js 的 verifySecondFactor）。
 * 因此前端不设「改用恢复码」开关——同一个输入框粘贴恢复码即可，分流由服务端按形状判定；
 * 多一个模式开关只会制造「开关选错 → 明明粘对了却报码错」的假失败面。
 *
 * 相应地，前端**不得改动输入的长度语义**：清洗只做「去分隔符」这一件服务端也做的事，
 * 绝不截断或补长。任何按直觉把「多余的字符」削掉的规则都会重写形状，从而把用户原本
 * 有效的凭据改造成服务端必拒的形态（服务端字母表含 8 个数字字符，**纯数字的合法恢复码
 * 确实存在**），而且截断发生在 onChange 上，用户连自己粘的是什么码都看不到。
 *
 * 本模块是纯函数，零依赖：登录页与设置页向导共用同一套清洗与提示口径。
 */

/** 动态口令位数（RFC 6238 默认 6 位；服务端 normalizeTotpCode 同口径） */
export const TOTP_CODE_LENGTH = 6

/** 恢复码长度（服务端 utils/recovery-codes.js 的 CODE_LENGTH） */
export const RECOVERY_CODE_LENGTH = 10

/**
 * 恢复码字母表：服务端 ALPHABET 原样搬来（32 字符，去混淆剔除 I/O/0/1）。
 * 注意其中含 2–9 共 8 个数字字符 —— 这正是「纯数字恢复码合法」的来源。
 */
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 恰好 6 位纯数字（服务端 normalizeTotpCode 的唯一接收形状） */
const TOTP_CODE_SHAPE = new RegExp(`^\\d{${TOTP_CODE_LENGTH}}$`)

/**
 * 恢复码形状：与服务端 normalizeRecoveryCode 逐条对齐——去分隔后 10 位、字符全在字母表内。
 * 大小写不敏感：服务端先 toUpperCase 再比对，小写粘贴同样有效；前端不能比服务端更严，
 * 否则会拦下服务端本会接受的输入。
 */
const RECOVERY_CODE_SHAPE = new RegExp(
  `^[${RECOVERY_CODE_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`,
  'i',
)

/**
 * 输入清洗：只去空白与连字符（粘贴常带分组符），与服务端 `replace(/[\s-]/g, '')` 同口径。
 *
 * 刻意**不做长度处理**：截断会重写形状（把纯数字恢复码削成 6 位 TOTP，服务端据此改走
 * 动态口令分支而必然失败），补长更是无中生有。长度是否合法交给
 * `isSecondFactorSubmittable` 判断，由调用方以行内提示处置，而不是静默改动用户输入。
 */
export function sanitizeSecondFactorInput(raw: string): string {
  return raw.replace(/[\s-]/g, '')
}

/**
 * 可提交性判定：恰好 6 位动态口令，或一枚形状完整的恢复码。
 * 返回 false 时调用方给出行内提示而不发请求——省掉一次必然失败的往返，
 * 而失败往返在服务端会计入登录失败封禁（错码与错密码共用同一计数）。
 */
export function isSecondFactorSubmittable(value: string): boolean {
  if (TOTP_CODE_SHAPE.test(value)) return true
  return RECOVERY_CODE_SHAPE.test(value)
}

/** 输入框 placeholder：两种码的形状差异在此一眼可见 */
export const SECOND_FACTOR_PLACEHOLDER = '6 位验证码或恢复码'

/** 区分提示：动态口令与恢复码的形态差异（输入框下方常驻说明） */
export const SECOND_FACTOR_HINT =
  '认证器里的 6 位数字，或一枚一次性恢复码（10 位字母数字，不含 I/O/0/1）；恢复码用后即作废。'

/**
 * 形状不符时的行内提示。登录页与设置页的关闭向导共用同一句，
 * 否则「什么样算合法」会在两处各说一套，而它们判定的是同一件事。
 */
export const SECOND_FACTOR_SHAPE_HINT =
  `验证码为 ${TOTP_CODE_LENGTH} 位数字；恢复码为 ${RECOVERY_CODE_LENGTH} 位字母数字` +
  `（不含 I/O/0/1）。请核对后重试`
