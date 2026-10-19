/**
 * 游戏规则「当前值」读链路域。
 *
 * **名单与当前值一律由服务器自述**，面板不猜。面板侧的手写规则表只能当文案资源
 * （中文名/分类/描述）：实测它的条数与内容在任何版本上都不等于服务器真实集合
 * （1.21.4 上 57 行里有 7 行真机不存在，同时漏掉从 1.0 就有的 doFireTick），
 * 按它渲染会同时产出「改了必回 Incorrect argument」的死行与看不见的真实规则。
 *
 * 名单只从 `help gamerule` 取，**不从规则表构造候选集**：候选集的补集只能靠「查询回
 * Incorrect argument」逐个排除，等于把「这台服务器有哪些规则」这个事实重新交给面板定义，
 * 而规则表的错误率正是本条链路要修的东西。
 *
 * ## 长回包必须逐包收齐
 *
 * 命令通道一次只交回**一个** RCON 响应包：实测 26.3 的 `help gamerule` 总长 5082 字节，
 * MC 按 4096 字节切包（4096 + 986，两包同一 request id），而 rcon-client 在收到第一个包时
 * 就 resolve 并删掉回调 ⇒ 只按它拿到 4096 字节、解出 47 条，真值 58 条：静默少 11 条规则，
 * 且那 11 条在界面上无从发现（它们不是 missing，是根本没有行）。
 * 故本域自己发请求包、自己收包：同一 id 的响应按序拼接，直到出现**短包**（长度 < 4096）。
 * 终止判据取「短包」而不是「超时」：长回包之后没有空包终止符（实测 26.3 打印完 986 字节
 * 就结束），超时收尾会让每条长回包白等一个超时。写入走的是实例已有的 RCON 连接
 * （rcon-client 自增的请求 id 从 0 起、不会撞上本域选用的高位 id），不新建连接也不改依赖。
 *
 * ## 逐条读值走 sendCommandWithResponse
 *
 * `sendCommand` 会在 finally 里落一条命令史、并向终端回显 `> <cmd>`：一次刷新就把整份
 * 名单的读值命令塞进命令史，把用户真正下发的命令淹掉（读值不是用户的动作）。
 *
 * ## 读值文案逐版本三式（均为实测原文）
 *
 * - 26.3      `Game rule random_tick_speed is currently set to 3`
 * - 1.21.11   `Gamerule random_tick_speed is currently set to: 3`
 * - 1.21.9/10 `Gamerule randomTickSpeed is currently set to: 2147483647`
 * 即「Game rule / Gamerule」与「带冒号 / 不带冒号」两个维度各自都要放宽。回包里的名字不参与
 * 判定：`minecraft:` 前缀会被服务端剥掉，条目名一律取**命令实参名**。
 *
 * 「本版本没有这条规则」有独立回包（`Incorrect argument for commandgamerule <name><--[HERE]`），
 * 与「读失败」必须分成两态：前者是事实，后者是没读到。两者都不许在界面上显示成默认值——
 * 把「没读到」伪装成事实，用户会据此做出错误判断。
 */

import { logger } from '../../utils/logger.js';

/**
 * 单条读值超时：取短值。实测回环链路上单条 0~42ms、58 条串行约 100ms，3s 是给
 * 「前序读值占着队列 / 服务端正在存档」这类排队留的余量；一条卡住只耽误那一条。
 *
 * 边界：这是**调用方级**超时（sendCommandWithResponse 自己计时并 reject），与 rcon-client
 * 的 5s 包超时无关——后者只在请求出队执行后才开始计时，队列滞留期不计时。故单条最坏耗时
 * 是本值与前一包超时之和，而 58 条串行在最坏情况下仍受每一条自己的 3s 约束。
 */
export const GAMERULE_READ_TIMEOUT_MS = 3000;
/**
 * 名单查询超时：回包可达数 KB 且分多包，比单条读值宽松。
 * **必须明显小于命令通道默认的 5000ms**：收集期间命令通道队列是暂停的，这个值同时充当
 * 「一次收集最多挡住命令通道多久」的上限，逼近 5000 就会让并发命令误报超时。
 */
export const GAMERULE_HELP_TIMEOUT_MS = 3000;
/** 等命令通道排空的上限：超过它说明通道已卡住，宁可本次名单失败也不继续占着队列 */
const RCON_BUSY_WAIT_MS = 1000;
/** 多包收齐的空闲判据：短包后仍无后续包即收尾，不按整段时间等 */
const RCON_IDLE_MS = 300;
/** RCON 响应包类型（协议固定值：0=命令响应，2=命令） */
const RCON_TYPE_COMMAND = 2;
const RCON_TYPE_RESPONSE = 0;
/** MC 侧切包长度（字节） */
const RCON_FRAGMENT_BYTES = 4096;
/**
 * 自用请求 id 起点：与 rcon-client 自增 id（从 0 起）分开，避免同一条连接上两套回调撞 id。
 * 取 2^30 量级，任何真实会话的请求数都到不了这里。
 */
const RCON_PRIVATE_REQUEST_ID_START = 0x40000000;
/**
 * 自用 id 逐次递增（到顶回绕）。**不能用固定 id**：两个并发的读快照会各发一条 help，
 * 服务端按 id 回包而两边收的是同一条 socket，固定 id 会让两个收集器收到同一批包——
 * 全量名单满 4096 时批次一交错，拼出来的就是「A 的前半 + B 的后半」。
 */
let _nextPrivateRequestId = RCON_PRIVATE_REQUEST_ID_START;

function nextPrivateRequestId() {
  const id = _nextPrivateRequestId;
  _nextPrivateRequestId =
    _nextPrivateRequestId >= 0x7fffffff ? RCON_PRIVATE_REQUEST_ID_START : _nextPrivateRequestId + 1;
  return id;
}

/**
 * 名单解析：从 `/gamerule <name> [<value>]` 用法行里取名字，剥 `minecraft:` 前缀后去重。
 *
 * **必须要求 `[<value>]` 后缀**：被截断的那一包末尾是半个名字（实测截在
 * `/gamerule minecraft:projectiles_can_brea`），只按 `/gamerule <name>` 提取会把这段残名
 * 当成一条规则，而查询它必然回 `Incorrect argument`——界面上就凭空多出一条「本版本不存在」的规则。
 *
 * 去重是必需的：26.x 与 1.21.11 把每条规则列两遍（裸名 + `minecraft:` 前缀名，实测 26.3
 * 共 116 条用法 / 58 个名字），而 1.21.10 的 `minecraft:` 前缀实参是**非法**的（实测回
 * Incorrect argument）⇒ 命令实参一律用去前缀后的裸名，两套写法在名单里只留一条。
 */
export function parseGameruleRoster(text) {
  const names = [];
  const seen = new Set();
  const re = /\/gamerule\s+(?:minecraft:)?([A-Za-z_][A-Za-z0-9_]*)\s+\[<value>\]/g;
  for (const match of String(text ?? '').matchAll(re)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 单条读值回包 → 契约条目（不含 name）。
 *
 * 值只认布尔与整数两种字面量：两档之外的文本不猜，按 unreadable 返回。类型由值形状判定
 * （`true/false` 为 boolean，其余为 integer），因为命令通道本身不报类型。
 */
export function parseGameruleReply(reply) {
  const text = String(reply ?? '');
  const match = /(?:Game rule|Gamerule)\s+\S+\s+is currently set to:?\s*(true|false|-?\d+)\b/i.exec(
    text,
  );
  if (match) {
    const raw = match[1];
    return {
      status: 'current',
      type: raw === 'true' || raw === 'false' ? 'boolean' : 'integer',
      value: raw,
    };
  }
  if (/incorrect argument/i.test(text)) {
    return { status: 'missing', type: null, value: null };
  }
  return { status: 'unreadable', type: null, value: null };
}

/** 剥命名空间：MSMP 的 key 与 help 的重复项都带 `minecraft:` 前缀 */
function stripNamespace(key) {
  return String(key).replace(/^minecraft:/, '');
}

/** 名字排序：MSMP/名单的返回顺序不保证一致（实测同一实例两次的首条不同），不排序会让规则行每次刷新都重排 */
function sortByName(rules) {
  return rules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 编一个 RCON 包（长度 = 载荷 + 请求 id + 类型 + 两个结尾空字节） */
function encodeRconPacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

/**
 * 发一条命令并**收齐它的全部响应包**（含多包拼接）。
 *
 * 接的是实例已有的 RCON 连接：连接生命周期、重连与密码重读都仍归实例管，本函数只在拿到
 * socket 后自己收发一次请求。响应包按同一 id 过滤，其余包原样留给 rcon-client 的监听器
 * ——它是 stream `data` 的另一个订阅者，不会被本函数的监听器抢占。
 *
 * ## 必须独占连接
 *
 * MC 的 RCON 服务端**不支持流水线**：同一连接上两条命令同时在途会让服务端直接关连接
 * （实测同一 write 里写两包 → 连接立刻 end/close，一条响应都没有；间隔 10ms 分两次写则两条
 * 都正常）。而本函数绕过了 rcon-client 的 `maxPending=1` 队列，直接写 socket ⇒ 与
 * `sendCommandWithResponse` 并发时就会触发这条断连，且连断的是**实例共用的那条连接**
 * （面板其它命令随之全部失败）。
 * 故收集必须独占连接：同一连接上的收集按序排队；写入前先把 rcon-client 的发送队列暂停、
 * 等它排空，写完再恢复——只「等它空」不够，等的一刻为空、下一个命令恰好出队写入，两条命令
 * 仍会同时在途。全程只借库已有的 pause/resume，不改 rcon-client。
 *
 * @returns {Promise<string>} 拼接后的完整响应；连接不可用时抛错（由调用方按不可用处理）
 */
export async function _rconCommandCollect(command, timeoutMs = GAMERULE_HELP_TIMEOUT_MS) {
  // 连接由实例统一管（重连、认证、密码重读都在那里）；首条查询时它可能还没建立
  if (!this._rconClient?.socket && typeof this._rconEnsureConnected === 'function') {
    await this._rconEnsureConnected();
  }
  const socket = this._rconClient?.socket;
  if (!socket) throw new Error('RCON connection unavailable');

  // 单飞：并发调用排队，不并发写同一条 socket。互斥量按**实例**登记而不是按连接——
  // 连接会断、会重建，按连接登记的话断连窗口里排队的调用者会带着旧键落到新连接上并发写。
  const previous = COLLECT_TAIL.get(this) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => (release = resolve));
  COLLECT_TAIL.set(this, current);
  await previous.catch(() => {});
  try {
    return await withExclusiveChannel(this, command, timeoutMs);
  } finally {
    release();
    if (COLLECT_TAIL.get(this) === current) COLLECT_TAIL.delete(this);
  }
}

/** 每个实例一条收集队列（WeakMap：实例被回收时条目随之消失，不留墓碑） */
const COLLECT_TAIL = new WeakMap();

/**
 * 在「命令通道静默」的前提下收发一次。
 *
 * 暂停 rcon-client 自己的发送队列而不是只等它空：只等空是**有竞态**的——等的一刻队列为空，
 * 下一个命令恰好在此刻出队写入，两条命令仍会同时在途。暂停后队列不再出队，静默窗口才真正成立。
 */
async function withExclusiveChannel(instance, command, timeoutMs) {
  const client = instance._rconClient;
  const socket = client?.socket;
  if (!socket) throw new Error('RCON connection unavailable');

  const queue = client.sendQueue;
  queue?.pause?.();
  try {
    await waitForQueueIdle(queue);
    return await sendAndCollect.call(instance, socket, command, timeoutMs);
  } finally {
    // 无条件恢复：暂停后漏掉恢复等于把命令通道永久停摆（之后所有命令挂到各自超时，
    // 面板表现为「所有命令随机超时」）。断连窗口里 rcon-client 会把 authenticated 置 false，
    // 若以此为由跳过恢复，那条队列就再也没人接回来了。恢复对已废弃的队列也只是一次置位，
    // 无害——故不加任何条件。
    queue?.resume?.();
  }
}

/** 等命令通道排空：队列里已有在途请求时写入就是流水线，MC 会直接断连 */
async function waitForQueueIdle(queue) {
  // 库内部结构变了就退回「不等待」：宁可偶发一次流水线，也不让整条读链路卡死在这里
  if (!queue || typeof queue.pendingPromiseCount !== 'number') return;
  const deadline = Date.now() + RCON_BUSY_WAIT_MS;
  while (queue.pendingPromiseCount > 0) {
    if (Date.now() > deadline) throw new Error('RCON command channel busy');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 真正的收发：写一个自用 id 的请求包，把同 id 的响应包按序拼齐 */
function sendAndCollect(socket, command, timeoutMs) {
  const id = nextPrivateRequestId();

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const parts = [];
    let settled = false;
    let idleTimer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onClose);
      if (error) reject(error);
      else resolve(parts.join(''));
    };
    // 断连时立刻失败，不白等整个超时（rcon-client 的 end/error 会同时打到 socket 上）
    const onClose = () => finish(new Error('RCON connection closed'));
    // 长回包之后没有空包终止符（实测 26.3 打印完最后一包就结束），故以「短包 + 短暂空闲」收尾：
    // 只等一个包间距，不按整段超时白等
    const scheduleIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), RCON_IDLE_MS);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < size + 4) break;
        const packet = buffer.subarray(0, size + 4);
        buffer = buffer.subarray(size + 4);
        if (packet.readInt32LE(4) !== id || packet.readInt32LE(8) !== RCON_TYPE_RESPONSE) continue;
        const body = packet.subarray(12, size + 2);
        parts.push(body.toString('utf8'));
        if (body.length < RCON_FRAGMENT_BYTES) {
          // 短包＝这一条命令的最后一包
          finish();
          return;
        }
        scheduleIdle();
      }
    };
    const overallTimer = setTimeout(
      () => finish(new Error(`RCON response timeout for packet id ${id}`)),
      timeoutMs,
    );
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', onClose);
    try {
      socket.write(encodeRconPacket(id, RCON_TYPE_COMMAND, command));
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * 取一份 MSMP 结构化快照。
 *
 * 返回数组里的 type 只有 `boolean|integer` 两档属契约允许的取值；出现第三档说明协议变了，
 * 按 unreadable 处理而不是替它猜一个控件类型——猜错会让界面放行一个服务端不接受的输入。
 * 结果排序：MSMP 的返回顺序不保证稳定，排序后才能让规则行在刷新之间保持原位。
 *
 * @returns {Promise<object[] | null>} 取不到（通道关闭/不可达/返回值不认识）返回 null
 */
export async function _readGamerulesViaMsmp() {
  if (!this.isRunning) return null;
  const result = await this._msmpRequest('minecraft:gamerules', []);
  if (!Array.isArray(result)) return null;

  const rules = [];
  const seen = new Set();
  for (const entry of result) {
    if (!entry || typeof entry.key !== 'string') continue;
    const name = stripNamespace(entry.key);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = entry.type === 'boolean' || entry.type === 'integer' ? entry.type : null;
    const hasValue = typeof entry.value === 'boolean' || typeof entry.value === 'number';
    rules.push(
      type && hasValue
        ? { name, status: 'current', type, value: String(entry.value) }
        : { name, status: 'unreadable', type: null, value: null },
    );
  }
  return rules.length > 0 ? sortByName(rules) : null;
}

/**
 * 取命令实参名单（去前缀去重后的裸名）。
 *
 * 拿不到就抛错：名单是「这台服务器有哪些规则」的唯一来源，空名单会被界面读成「没有规则」。
 * 调用方把异常与空名单一律归为 `rosterFailed`（通道是通的、这一问没答上来），不降级成 `none`。
 */
export async function _fetchGameruleRoster() {
  if (!this.isRconConnected) throw new Error('RCON connection unavailable');
  const text = await this._rconCommandCollect('help gamerule', GAMERULE_HELP_TIMEOUT_MS);
  const names = parseGameruleRoster(text);
  if (names.length === 0) {
    logger.warn(
      `[${this.id}] help gamerule 回包未解析出规则名（${Buffer.byteLength(String(text ?? ''))} 字节）`,
    );
  }
  return names;
}

/**
 * 读一条规则的当前值。
 *
 * 三态判据互不合并：回包解析出值 → current；含 `Incorrect argument` → missing；
 * 抛错/超时/回包不认识 → unreadable。单条失败只影响这一条。
 */
export async function _readGameruleEntry(name) {
  try {
    const reply = await this.sendCommandWithResponse(`gamerule ${name}`, {
      timeout: GAMERULE_READ_TIMEOUT_MS,
    });
    return { name, ...parseGameruleReply(reply) };
  } catch {
    return { name, status: 'unreadable', type: null, value: null };
  }
}

/**
 * 读一份规则快照：MSMP 优先，取不到转 RCON，两条通道都不可用返回 `source: 'none'`。
 *
 * MSMP 失败**不重试**：`_msmpRequest` 的契约就是「失败一律 null」（401、连不上、超时同归），
 * 重试只会把同样的失败再等一遍。
 *
 * RCON 逐条读值**串行**：RCON 客户端本就只有一个待决队列（maxPending=1），显式串行才能让
 * 单条超时只落在那一条上，而不是整批一起等到超时。
 *
 * **不做单飞（in-flight 去重）**：两个页面同时刷新会各跑一份 58 条读值，实测整份约 100~200ms、
 * 单条最大 42ms，重复一次是毫秒级空转，而共享同一个 promise 要引入「谁在等、失败算谁的、
 * 何时失效」这一整套状态——读的是滚动真值，复用一份反而要把「这一份是什么时候的」写进契约。
 *
 * 名单读空时**不归成 `none`**：`none` 的含义是「两条通道都不可用」，而名单超时/回包不认识
 * 时通道明明是通的。两者都表现为空 `rules`，但界面该给的结论相反——前者去查连接，后者
 * 该重试。故此时 source 保持 `rcon` 并置 `rosterFailed`，让「没读到」与「连不上」分开。
 *
 * @returns {Promise<{source: 'msmp'|'rcon'|'none', rules: Array<object>, rosterFailed?: boolean}>}
 */
export async function _readGamerules() {
  const viaMsmp = await this._readGamerulesViaMsmp();
  if (viaMsmp) return { source: 'msmp', rules: viaMsmp };

  if (!this.isRunning || !this.isRconConnected) return { source: 'none', rules: [] };
  const names = await this._fetchGameruleRoster().catch(() => null);
  if (!names || names.length === 0) return { source: 'rcon', rules: [], rosterFailed: true };

  const rules = [];
  let failed = 0;
  for (const name of names) {
    const entry = await this._readGameruleEntry(name);
    if (entry.status === 'unreadable') failed++;
    rules.push(entry);
  }
  // 逐条失败只在末尾汇总一条：RCON 中途断掉时逐条告警会把日志刷成名单长度那么多行
  if (failed > 0) {
    logger.warn(`[${this.id}] ${failed}/${names.length} 条游戏规则读取失败，按未读取返回`);
  }
  return { source: 'rcon', rules };
}
