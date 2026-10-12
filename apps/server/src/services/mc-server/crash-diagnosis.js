/**
 * 崩溃诊断映射：把崩溃报告的键映射成人能看懂的结论与处置建议。
 *
 * 为什么要有它：崩溃卡片此前只呈现产物原文与已核实字段，用户拿到一屏英文堆栈仍要自己判断
 * 「这是什么问题、我该做什么」。词条把**已核实过的**键映射成结论 + 处置动作。
 *
 * 键只锚三处（这三处是崩溃报告自身的语义字段，不随 MC 的日志文案改写而漂移）：
 * - `description`：崩溃报告的 `Description:`，取值是**固定词表**（26.3 的取值与来源类见各条注释）
 * - `fault`：JVM 崩溃日志（hs_err）故障行的**行首**，写 JVM 的标准故障串（`SIGSEGV`/`SIGBUS`…
 *   信号族用共同前缀 `SIG`）。这是 hs_err 唯一可锚的键——它没有 `Description:`，也不是
 *   Java 异常。⚠️ 非信号的故障行（`Internal Error (...)`、OOM 型）**刻意不锚**：手上没有
 *   真实样本，凭印象写词条就是把猜测当结论（未命中仍按原样展示 + 出路处理）
 * - `exception`：顶层异常行**行首前缀**——写类名（`java.lang.OutOfMemoryError`）即可，
 *   写「类名: 消息开头」则更精确。⚠️ 只锚类名**不足以**区分同类异常：本仓两个真实样本
 *   （MSMP 密钥非法 / TLS 未配 keystore）类名同为 `java.lang.IllegalStateException`，
 *   只能靠消息区分，故前缀允许写到消息；行中片段不算（不做子串猜测）
 * - `logger`：日志 logger 全等（崩溃报告没有该字段，供日志侧诊断接入后使用）
 *
 * **不锚 MC 的 INFO/WARN 文案**：那是随版本改写的展示文本，锚它等于把一次性文案当契约。
 *
 * 匹配语义：`match` 里的键是**与**关系（都命中才算），表内**顺序即优先级**（从具体到泛化），
 * 取第一条命中的——泛化条目（如 `Exception in server tick loop`）排在最后，否则它会抢走
 * 具体条目的结论。命中后 `entry.matchedBy` 报「固定键序（description→exception→fault→logger）里
 * 第一个被声明的键」，用于向用户解释结论靠什么锚定。
 *
 * 未命中**不猜**：返回 `matched: false` 与空词条，由呈现层原样展示原始字段并给出路。
 * 三种产物类型各有各的键：崩溃报告看 `description`/`exception`，hs_err 看 `fault`，两者不会
 * 互相抢条目（另一侧的键为 null ⇒ 判定不通过），故表序不受产物类型影响。
 *
 * 每条都标 `verifiedVersions`（该结论在哪些 MC 版本上核实过）与 `evidence`（实测样本 /
 * 从该版本 jar 静态提取）。`verifiedForInstance` 由呈现层用来提示「本条在别的版本上验证」，
 * **版本不符不否定键的命中**——键命中本身仍是证据，只是结论的适用范围要讲清楚。
 */

/** 词条表：顺序即优先级，从具体到泛化 */
export const CRASH_DIAGNOSIS_TABLE = [
  {
    id: 'jvm-native-signal',
    // 信号族共用前缀：SIGSEGV/SIGBUS/SIGILL/SIGFPE 对用户的结论与处置是同一件事
    // （进程在 JVM/本地库层被信号打死），拆成四条只会得到四份同样的文案
    match: { fault: 'SIG' },
    title: 'JVM 在原生层崩溃（收到致命信号）',
    detail:
      '服务端进程收到 SIGSEGV 一类致命信号，崩溃点在 JVM 或本地库（「问题帧」里的 C/Java 帧就是落点），不是普通的 Java 异常。常见来源：模组带的本地库、与 JDK 不匹配的 JVM 参数、内存问题。',
    actions: [
      '看「问题帧」落在哪：本地库名指向具体组件，`libc.so.6` 这类系统库多指向系统层',
      '故障行带 `(sent by kill)` 时信号来自**外部**：先查内核有没有因内存不足杀掉进程（`dmesg`），并核对实例内存上限与机器可用内存',
      '换用与服务器版本匹配的 JDK，并去掉非必需的 `-XX`/`-D` 参数后重试',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['实测'],
  },
  {
    id: 'msmp-invalid-secret',
    match: { exception: 'java.lang.IllegalStateException: Invalid management server secret' },
    title: '管理协议（MSMP）密钥格式不合法',
    detail:
      '服务端启动时校验 management-server-secret 失败：该值必须是 40 位字母数字，否则服务端在初始化阶段直接崩溃。',
    actions: [
      // 面板侧唯一入口：实例设置里的「实时推送」开关。关一次再打开会重写自洽三项；
      // 由面板启动的实例，启动前也会自动修正这组配置（仍崩 ⇒ 多半不是面板启动的）
      '到实例设置 →「实时推送」把它关一次再重新开启（面板会一次写对 enabled/secret/TLS 三项）',
      '确认 server.properties 的 management-server-secret 不是手工填写的短串',
    ],
    verifiedVersions: ['26.1'],
    evidence: ['实测'],
  },
  {
    id: 'msmp-tls-without-keystore',
    match: { exception: 'java.lang.IllegalStateException: Failed to configure TLS' },
    title: '管理协议（MSMP）开了 TLS 但没配 keystore',
    detail: '服务端按配置启用管理协议 TLS，却找不到可用的 keystore，于是启动阶段抛错退出。',
    actions: [
      '到实例设置 →「实时推送」先关闭再开启（不配证书时面板会把 TLS 一并关掉，内网/本机自用通常不需要 TLS）',
      '或补齐 keystore 与口令后再开启 TLS',
    ],
    verifiedVersions: ['26.1'],
    evidence: ['实测'],
  },
  {
    id: 'watchdog-hang',
    match: { description: 'Watching Server' },
    title: '看门狗判定服务端卡死并强制关闭',
    detail:
      '单个服务端刻的耗时超过 max-tick-time 限制，看门狗线程认定服务端已卡死，导出线程转储后强制关服。机器过载、磁盘卡顿或某个模组死循环都会造成它。',
    actions: [
      '看崩溃报告的 `-- Thread Dump --` 段，找长时间停在同一个调用上的线程',
      '检查这段时间的机器负载与磁盘 IO（面板仪表盘可看）',
      '确认 max-tick-time 没有被改得过小（默认 60000 毫秒）',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['实测'],
  },
  {
    id: 'ticking-entity',
    match: { description: 'Ticking entity' },
    title: '刻实体时抛异常',
    detail:
      '某个实体在 tick 中抛了未捕获异常，通常是模组/插件的实体逻辑，或该实体所在区块的数据异常。',
    actions: [
      '看下方顶层异常与 `Caused by:` 链里的模组包名',
      '若最近新增过模组或数据包，回退到上次正常配置再试',
      '把崩溃报告全文留档后回报模组作者',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'ticking-block-entity',
    match: { description: 'Ticking block entity' },
    title: '刻方块实体时抛异常',
    detail:
      '某个方块实体（容器、机器、刷怪笼等）在 tick 中抛异常，常见于模组机器或数据包自定义方块。',
    actions: [
      '看下方顶层异常与 `Caused by:` 链定位具体模组',
      '若知道是哪个方块，可用 `/setblock` 覆盖或移除该方块后再启动',
      '回退最近新增的模组/数据包',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'ticking-player',
    match: { description: 'Ticking player' },
    title: '刻玩家时抛异常',
    detail: '某个在线玩家在 tick 中触发异常，常见于该玩家的物品/属性数据异常或模组对玩家的处理。',
    actions: [
      '看下方顶层异常与 `Caused by:` 链定位具体模组',
      '必要时先用面板封禁或清空该玩家的部分数据再让其进入',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'exception-generating-chunk',
    match: { description: 'Exception generating new chunk' },
    title: '生成新区块时抛异常',
    detail: '世界生成阶段抛异常，常见于自定义世界生成器、生物群系数据包或模组的生成器代码。',
    actions: [
      '看下方顶层异常与 `Caused by:` 链定位生成器来源',
      '回退最近改动的数据包/模组；若是世界损坏，考虑从备份恢复',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'feature-placement',
    match: { description: 'Feature placement' },
    title: '放置地物时抛异常',
    detail:
      '世界生成里的地物（树木、矿物、结构部件等）放置阶段抛异常，通常与数据包/模组的生成配置有关。',
    actions: [
      '看下方顶层异常与 `Caused by:` 链定位具体地物',
      '回退最近改动的数据包/模组后再生成新区块',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'loading-entity-nbt',
    match: { description: 'Loading entity NBT' },
    title: '读取实体存档数据（NBT）时抛异常',
    detail: '从存档读实体数据时失败，通常是模组实体在版本升级/模组移除后留下了不兼容的数据。',
    actions: [
      '若刚从旧版本升级，先确认模组已全部升级到对应版本',
      '用备份回退该区域，或移除引发问题的实体后再启动',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'saving-oversized-chunk',
    match: { description: 'Saving oversized chunk' },
    title: '区块数据超过上限，存档失败',
    detail: '单个区块的序列化数据超过服务端上限，无法写入区域文件。',
    actions: ['定位并清理该区块里的异常实体/方块实体', '确认没有模组往单区块塞入超量数据'],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    id: 'exception-ticking-world',
    match: { description: 'Exception ticking world' },
    title: '刻世界时抛异常',
    detail: '世界维度的 tick 抛出未捕获异常，范围比「刻实体/刻区块」更大，需结合异常链判断。',
    actions: [
      '看下方顶层异常与 `Caused by:` 链定位来源',
      '结合「崩溃前最后一次改动」缩小范围（模组、数据包、指令）',
    ],
    verifiedVersions: ['26.3'],
    evidence: ['静态提取'],
  },
  {
    // 泛化条目：必须排在所有具体条目之后，否则会抢走它们的结论
    id: 'tick-loop-exception',
    match: { description: 'Exception in server tick loop' },
    title: '刻循环里抛了未捕获异常',
    detail:
      '服务端刻循环因未捕获异常而终止。这条本身只说明「崩在刻循环里」，具体原因要看下方的顶层异常与 `Caused by:` 链。',
    actions: [
      '看下方顶层异常行的类名与消息，以及 `Caused by:` 链',
      '对照崩溃前最后一次改动（模组、数据包、指令、配置）',
      '若反复在同一位置崩溃，用备份回退该世界',
    ],
    verifiedVersions: ['26.1', '26.3'],
    evidence: ['实测', '静态提取'],
  },
];

/** 逐键判定：`description`/`logger` 全等，`exception` 取「锚是异常行的行首前缀」 */
function keyMatches(key, expected, input) {
  if (key === 'description') return input.description === expected;
  if (key === 'logger') return input.logger === expected;
  // exception / fault 都是「行首前缀」：写类名或故障串即可，写更长则更精确
  if (key === 'fault') return String(input.fault ?? '').startsWith(expected);
  return String(input.exception ?? '').startsWith(expected);
}

/**
 * 命中判定：`match` 里声明的键**都要**满足（与关系）；全部满足才算命中，
 * 并以表里声明的第一个键作为 `matchedBy`（解释结论靠什么锚定）。
 */
function matchedByOf(match, input) {
  const keys = ['description', 'exception', 'fault', 'logger'].filter((k) => match[k] != null);
  for (const key of keys) {
    if (!keyMatches(key, match[key], input)) return null;
  }
  return keys[0] ?? null;
}

/**
 * 诊断一次崩溃。输入里的键按可用性给（崩溃报告给 `description` 与 `exception`；
 * hs_err 两类键都没有，于是必然未命中——**不猜**，由呈现层原样展示已解析字段）。
 *
 * `table` 可注入：供用例覆盖尚未上线的键类型（logger），从而不必在正式表里放没人命中的词条。
 * `verifiedForInstance`：拿「崩溃报告自己写的 MC 版本」与词条的已验证版本比；
 * 版本未知时为 null（既不说适用也不说不适用）。
 */
export function diagnoseCrash(input = {}, table = CRASH_DIAGNOSIS_TABLE) {
  const { mcVersion = null } = input;
  let hit = null;
  for (const entry of table) {
    const matchedBy = matchedByOf(entry.match, input);
    if (matchedBy) {
      hit = { ...entry, matchedBy };
      break;
    }
  }
  const instanceVersion = mcVersion || null;
  return {
    matched: hit !== null,
    entry: hit,
    instanceVersion,
    verifiedForInstance:
      hit && instanceVersion ? hit.verifiedVersions.includes(instanceVersion) : null,
  };
}

export default { CRASH_DIAGNOSIS_TABLE, diagnoseCrash };
