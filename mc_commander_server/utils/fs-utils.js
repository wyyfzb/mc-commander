// 原子写：写唯一 .tmp 临时文件后 rename 覆盖目标（全仓公共单一实现）。
// 直接 writeFileSync 覆盖（默认 flag 'w'：先 truncate 后写）在进程中途崩溃/断电时会残留
// 截断或半写内容，损坏目标文件（如 server.properties）；原子写崩溃只影响临时文件
// （finally 清理），目标文件保持完整旧内容。
// 按模式库 docs/scan-patterns.md 原子写维度收敛：mc_server.js（saveProperties/_saveProperties、
// instance.json 同步）与 routes/files.js（PUT /files/content）均复用本函数，
// 不再各自定义本地副本，杜绝双写入点原子性保障分叉。
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Windows 瞬时共享冲突重试：rename 覆盖已存在文件时，杀毒/索引/搜索服务可能短暂
// 持有目标文件，rename 会瞬时抛 EPERM/EACCES/EBUSY（新文件首次被扫描的窗口最常见，
// 毫秒级即消散）——凭据轮换/启动播种这类一次性写盘动作没有第二次机会，必须有界重试。
// 三类瞬时码之外（ENOENT、目录目标等真错误）原样抛出，不把缺陷吞成成功；
// 临时名每次重试重新生成，finally 逐次清理，原子性语义不变。
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// 5 = 首次尝试 + 4 次重试的总 rename 次数（不是「重试 5 次」）
const RENAME_RETRY_ATTEMPTS = 5;
// 同步 IO 路径上的同步等待：Atomics.wait 阻塞当前线程（与所在调用本就同步阻塞一致）
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const atomicWriteFile = (filePath, content, options = {}) => {
  const writeOpts = options.mode ? { mode: options.mode } : undefined;
  for (let attempt = 1; ; attempt++) {
    const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      // options.mode 用于目标文件本身带权限纪律的场景（.env 0600 一类）：权限设在
      // 临时文件上，rename 后目标继承——先写后 chmod 会在中间态留下过宽权限
      fs.writeFileSync(tmpPath, content, writeOpts);
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(err?.code)) throw err;
      sleepSync(10 * attempt + Math.random() * 10);
    } finally {
      // 失败时清理残留临时文件：直接 unlink 并吞掉 ENOENT（未创建/已被 rename 消费），
      // 不做 existsSync 预检——临时名带 UUID 本就是独占的，且 finally 里抛错会盖掉原错误
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
};

// ── 存在性判定纪律（清单 #20：existsSync 的 TOCTOU 收敛）────────────────
// existsSync 只允许用于「判定后不据此变更文件系统」的场景（启动门控、特性开关、
// 回执展示、日志）。「先判定、再变更」的两步写法天然有窗口：判定为「不存在」后
// 窗口内被并发创建/删除，变更就落在错误前提上（POSIX rename 会静默覆盖、
// unlink 会删掉别人刚写的文件、mkdir recursive 会把「已存在」吞成成功）。
// 收敛口径＝让**操作本身**承担判定，按原生错误码分流：
//   · 要「已存在即失败」→ renameNoClobber（独占声明）或 copyFileSync 的 COPYFILE_EXCL
//   · 要「不存在也能成功」→ 直接调用并容忍 ENOENT（rmSync force、读操作 try/catch）
//   · 要「幂等创建」→ ensureDir（mkdir recursive 本就幂等，预检是纯冗余）
// 纯读预检（「不存在则返回默认值 + 读到内容才算数」）不算违规：读操作本身容忍
// ENOENT，预检只影响提前返回，竞态下结果与直接读再 catch 等价。

/** 幂等建目录：mkdirSync recursive 对已存在目录不报错，无需存在性预检 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 无覆盖重命名：目标已存在时抛原生 EEXIST（调用方映射为各自的 409 语义）。
 * 不用「existsSync 预检 + renameSync」——两者之间目标被并发创建时，POSIX 与
 * Windows 的 rename 都会静默覆盖（实测 win32 覆盖），数据直接丢失。
 * 做法是先用独占创建把「目标是否存在」判定与「占位」合并成一个原子动作：
 *   · 文件：`open('wx')` 建空占位 → rename 覆盖的是我们自己的占位文件；
 *   · 目录：`mkdir` 建空占位 → POSIX 允许 rename 替换空目录（仍原子）；
 *     Windows 的 MoveFileEx 不能替换已存在目录（实测 EPERM），故退化为
 *     「释放占位后 rename」——残留窗口为微秒级，且竞争方最多抢到一个空目录，
 *     没有任何数据可丢。
 * 源不存在时抛原生 ENOENT（占位文件会被回收，不留残件）。
 * 与旧写法的已知差异（POSIX）：目标是指向不存在文件的悬空符号链接时，`open('wx')`
 * 按 POSIX 语义一律 EEXIST（→409），而旧的 `existsSync`（跟随链接）判 false 会直接
 * rename 替换该链接。差异只落在「悬空链接作目标」这一病态场景，且 win32 行为与旧版
 * 一致（占位创建成功、链接被替换）。
 */
export function renameNoClobber(src, dst) {
  if (!fs.lstatSync(src).isDirectory()) {
    fs.closeSync(fs.openSync(dst, 'wx'));
    try {
      fs.renameSync(src, dst);
    } catch (err) {
      try { fs.unlinkSync(dst); } catch {}
      throw err;
    }
    return;
  }
  fs.mkdirSync(dst);
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') {
      fs.rmdirSync(dst);
      throw err;
    }
    fs.rmdirSync(dst);
    fs.renameSync(src, dst);
  }
}

// ── 实例文件路径安全（find-006/007/004/extra-1 统一校验模式）────────────
// 路径穿越检测专用错误：code 固定 'EPATHTRAVERSAL'，与 fs 原生错误码
// （'ENOENT'、'EISDIR' 等）互不冲突，路由层据此映射 PATH_TRAVERSAL_DETECTED
export class PathTraversalError extends Error {
  constructor(message = 'Path traversal detected') {
    super(message);
    this.name = 'PathTraversalError';
    this.code = 'EPATHTRAVERSAL';
  }
}

// 统一实例内路径安全校验（四步防线，任一失败抛 PathTraversalError）：
// ① path.resolve 归一化：'./'、'.//'、'a/../b' 等变体先归一化，杜绝字符串
//    includes('..') 检查被 '.'/'./'/'.//' 绕过（归一化后等于 basePath）；
// ② 相等排除 + 严格前缀边界：归一化后与 basePath 相等（即 '.' 等指向实例
//    根目录）一律拒绝——防止 DELETE 递归删除整个实例目录；前缀比较带
//    path.sep 边界（base + sep），杜绝 s1 与 s1-2 等父子目录名互相越界；
// ③ 已存在路径组件逐段 realpathSync：解析符号链接真实路径后再次校验在
//    baseReal 内——实例内符号链接指向外部 = 越界读写删（root 运行时可读
//    /etc/shadow、覆盖任意文件、删除任意文件）；
// ④ 最终目标 lstat（不跟随）为符号链接时拒绝：readFileSync/rmSync 默认
//    跟随链接，即使链接目标解析后仍在实例内也拒绝（防链接替换攻击）。
// 注意：options.allowRoot = true 仅用于"列出实例根目录"（list 接口的 '/'），
// 是归一化后等于 basePath 的唯一合法场景。
// ②③④ 由本仓两个解析面入口共用（resolveSafePath / resolveContainedPath），
// ①的拼接方式各入口自持（见各函数注释）。
function assertPathContained(base, full, options = {}) {
  // ② 相等排除：'.'/ './' / './/' / 'a/../' 归一化后与 base 相等
  if (full === base && !options.allowRoot) {
    throw new PathTraversalError('Path resolves to instance root');
  }

  // ② 严格前缀校验（base + sep 边界）
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new PathTraversalError('Path escapes instance root');
  }

  // ③ 逐段 realpath：从目标向上找到最深的已存在组件，realpath 解析符号
  //    链接后拼接剩余不存在的段，重新校验在 baseReal 内
  let existing = full;
  const missing = [];
  while (!fs.existsSync(existing) && existing !== base) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  // base 不存在时抛原生 ENOENT（路由层 catch 映射 FILE_NOT_FOUND）；
  // baseMustExist=false 是服务层显式选择（备份流程先做包含校验、存在性由
  // 后续步骤判定并给出更精确的业务错误），此时退化为纯前缀校验
  let baseReal;
  try {
    baseReal = fs.realpathSync(base);
  } catch (err) {
    if (err.code === 'ENOENT' && options.baseMustExist === false) return;
    throw err;
  }
  const candidate = path.join(fs.realpathSync(existing), ...missing);
  if (candidate !== baseReal && !candidate.startsWith(baseReal + path.sep)) {
    throw new PathTraversalError('Path escapes instance root via symlink');
  }

  // ④ 最终目标 lstat 为符号链接时拒绝（根目录本身豁免：serverPath 可能
  //    配置为指向实际目录的符号链接，③ 已确保其在 baseReal 内）
  if (full !== base) {
    try {
      if (fs.lstatSync(full).isSymbolicLink()) {
        throw new PathTraversalError('Target is a symlink');
      }
    } catch (err) {
      // 目标不存在（新建文件场景）时无 lstat 可言，③ 的 realpath 校验已兜底
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

export function resolveSafePath(basePath, userPath, options = {}) {
  // ① path.resolve 归一化。注意用 path.join 拼接而非 path.resolve(base, userPath)：
  // path.resolve 会把以 '/' 开头的用户路径当绝对路径处理（Windows 上 '/' 直接落到
  // 盘符根目录，导致列表根目录 '/' 失效），而 join 语义与旧实现一致——按相对实例
  // 目录拼接后统一归一化，跨平台行为不变
  const base = path.resolve(basePath);
  const full = path.resolve(path.join(base, userPath));

  // NUL 字节不可能出现在合法路径：提前拒绝，避免 fs API 抛 TypeError 落 500
  if (full.includes('\0')) {
    throw new PathTraversalError('Path contains NUL byte');
  }

  assertPathContained(base, full, options);

  return full;
}

/**
 * 路径包含校验的解析面——绝对/混合 target 变体（backup 等服务层收敛入口）。
 * 与 resolveSafePath 同一套四步防线（归一化 → 相等排除 + sep 边界 → 逐段
 * realpath → 最终目标 symlink 拒绝），差异只有三点：
 * ① target 用 path.resolve(base, target) 拼接——绝对 target 独立生效（服务层
 *    传入的已是绝对路径），相对 target 按 base 拼接（不依赖进程 CWD）；
 * ② options.allowRoot 允许 target 归一化后等于 base（备份「整个实例」类场景）；
 * ③ options.baseMustExist=false 时基座不存在退化为纯前缀校验（服务层先做
 *    包含校验、存在性由后续业务步骤判定）；缺省 true，基座缺失抛原生 ENOENT。
 * @returns {string} 归一化绝对路径
 * @throws {PathTraversalError} 越界/穿越/symlink 逃逸
 * @throws {Error} 原生 ENOENT（base 目录不存在且未显式选择容忍口径）
 */
export function resolveContainedPath(baseDir, target, options = {}) {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, target);
  if (full.includes('\0')) {
    throw new PathTraversalError('Path contains NUL byte');
  }
  assertPathContained(base, full, options);
  return full;
}

/**
 * 路径包含校验的文本面——内部候选路径过滤（mc_server 启动参数、stats 候选、
 * level-dat 路径等服务器自身产生的路径）。
 * 与解析面的三分歧维度（语义事实源，调用方按维度选面）：
 * ① 相等允许：target 归一化后等于 base 返回 true（「实例根本身」是合法候选）；
 * ② 不做任何 fs 判定：不跟随、也不检测符号链接——管理员的 world 目录 symlink
 *    到数据盘是合法部署形态，文本面必须放行（用户可控路径的攻击面才走解析面）；
 * ③ 前缀比较按字面大小写：候选路径由 path.join(base, …) 构造、与 base 同源，
 *    已存在组件的实际大小写由解析面（realpath）归一，文本面不折叠（Windows 上
 *    大小写不符只会「拒绝合法路径」，不会「放行越界路径」，宁拒绝不误放）。
 * @returns {boolean}
 */
export function isPathContained(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(base, targetPath);
  return target === base || target.startsWith(base + path.sep);
}
