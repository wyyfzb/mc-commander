/**
 * 进程输出解析域（issue 494 治理线·服务端第二阶段）：_parseOutput 与玩家进出事件辅助
 * 自 mc_server.js 等价搬移。挂载方式与 level-dat 域一致：由宿主模块 Object.assign
 * 原型注入复用，模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this
 * 绑定实例），全部调用点零改动，对外接口零变化。域外协作方法（_loadPlayerData、
 * _savePlayerData、_todayKey、_emitDeathAggregated、_emitPerformance）留宿主类内，
 * 经 this 按原型链解析。
 */

/**
 * 取日志行的**消息体**（剥掉 `[时间] [线程/级别]: ` 前缀）。
 *
 * 事件解析一律只认消息体、且锚定其行首。理由是**玩家能影响这一行的内容**：
 * 聊天也会落进日志，形如 `<玩家> 文本`。此前事件正则在整个行内任意位置找
 * `名字 + 事件短语`，于是玩家在聊天框打出 `../instance joined the game` 就会被
 * 当成一次真实加入——名字随即被拼进档案路径，可覆盖服务端根目录下的
 * `instance.json` / `ops.json` / `whitelist.json` 等（实测）。
 *
 * 锚定行首后这种伪造不成立：聊天行的行首必然是 `<玩家> ` 或 `* 玩家 `（`/me`），
 * 二者都不满足「行首即事件形态」。裸行（无前缀）剥离是空操作，两种形态都兼容。
 */
function logMessageBody(line) {
  return line.replace(/^(?:\[[^\]]*\]\s*)*:\s*/, '');
}

/**
 * 解析一行结构化日志（面板自带 log4j2 配置产出，见 structured-log-config.js）。
 *
 * 判据是「像我们的日志行」而不只是「能被 JSON 解析」：stdout 上除 log4j 行外还有 JVM 警告、
 * bundler 提示、库直接打到 stderr 的堆栈等任意内容，认错了就会把无关输出当日志渲染。
 * 故要求对象形态且 `msg`/`lvl` 均为字符串，其余字段缺失按空串补。
 */
export function parseStructuredLogLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.msg !== 'string' || typeof parsed.lvl !== 'string') return null;
  return {
    ts: typeof parsed.ts === 'string' ? parsed.ts : '',
    lvl: parsed.lvl,
    thr: typeof parsed.thr === 'string' ? parsed.thr : '',
    logger: typeof parsed.logger === 'string' ? parsed.logger : '',
    msg: parsed.msg,
  };
}

/**
 * 把结构化日志行还原成面板既有的人类可读形态 `[HH:mm:ss] [线程/级别]: 消息`。
 *
 * 这个形态是面板全部下游消费方的契约（噪音过滤、事件正则、`lastOutput` 呈现、日志查看面板），
 * 所以「展示层还原」必须逐字符对齐它而不是另造格式；消息里的换行照原样保留——纯文本通道下
 * 多行消息本就铺成多行，二者行为一致。缺 `ts` 时按当前时刻补，避免出现 `[]` 这种破形态。
 */
export function renderStructuredLogLine(entry) {
  const time = /(\d{2}:\d{2}:\d{2})/.exec(entry.ts || '')?.[1] ?? formatClock(new Date());
  return `[${time}] [${entry.thr}/${entry.lvl}]: ${entry.msg}`;
}

function formatClock(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 把一段进程输出规范成面板既有的纯文本形态：结构化行还原，其余行原样（逐行处理）。
 * 「结构化行与其等价纯文本行的规范结果完全一致」有用例锁住——这是格式切换不回归的依据。
 */
export function normalizeLogText(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const structured = parseStructuredLogLine(line);
      return structured ? renderStructuredLogLine(structured) : line;
    })
    .join('\n');
}

export function _parseOutput(text) {
  const lines = text.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const body = logMessageBody(line);
    const tpsMatch = line.match(/(\d+\.\d+) TPS/);
    if (tpsMatch) {
      this.tps = parseFloat(tpsMatch[1]);
    }

    // MSPT 解析：从 tick query 或 tps 命令输出中提取
    const msptMatch = line.match(/MSPT\s*(?:mean|max|min)?[\s:=]*(\d+\.\d+)/i);
    if (msptMatch) {
      this._mspt = parseFloat(msptMatch[1]);
    }
    // 备用格式: "5.0 ms per tick" 或 "tick time: 5.0ms"
    const msptFallback =
      line.match(/(\d+\.?\d*)\s*ms\s*per\s*tick/i) ||
      line.match(/tick\s*time[\s:]+(\d+\.?\d*)\s*ms/i);
    if (msptFallback) {
      this._mspt = parseFloat(msptFallback[1]);
    }

    const joinMatch = body.match(/^([^\s\]<>[]+) joined the game/);
    if (joinMatch) {
      this._registerPlayerJoin(joinMatch[1]);
    }

    // 解析玩家 IP（登录日志行包含 IP 地址，可能在 join 前到达）
    const loginIpMatch = body.match(/^([^\s\]<>[]+)\[\/?([\d.]+):\d+\] logged in with entity id/);
    if (loginIpMatch) {
      // 如果玩家已存在，直接设 IP；否则缓存等待 join
      const existing = this.players.get(loginIpMatch[1]);
      if (existing) {
        existing.ip = loginIpMatch[2];
      } else {
        this._pendingIps.set(loginIpMatch[1], loginIpMatch[2]);
      }
    }

    const leaveMatch = body.match(/^([^\s\]<>[]+) left the game/);
    if (leaveMatch) {
      this._handlePlayerLeave(leaveMatch[1]);
    }

    // 被动离开（踢出/封禁/IP 封禁/断开连接）：服务器日志输出 "lost connection" 或 "was kicked"，
    // 不输出 "left the game"，也应视为"离开服务器"事件。仅在玩家仍在线时处理，避免重复记录。
    const passiveLeaveMatch =
      body.match(/^([^\s\]<>[]+) lost connection: /) || body.match(/^([^\s\]<>[]+) was kicked /);
    if (passiveLeaveMatch) {
      this._handlePlayerLeave(passiveLeaveMatch[1]);
    }

    // 死亡事件 — 使用更精确的正则避免误匹配
    // MC 26.2 日志格式: "Player was slain by Zombie" / "Player fell from a high place"
    const deathMatch = body.match(
      /^([^\s\]<>[]+) (was slain by|was killed by|was shot by|was fireballed by|was blown up by|was stung by|was pummeled by|was squashed by|was impaled on|fell from a high place|fell off|drowned|blew up|hit the ground too hard|tried to swim in lava|went up in flames|burned to death|was pricked to death|was doomed to fall|was shot off|starved to death|suffocated in a wall|withered away|froze to death|died|was lost|disconnected|experienced kinetic energy)(?:\s+(.+))?/,
    );
    if (deathMatch) {
      const playerName = deathMatch[1];
      const cause = deathMatch[2];
      const killer = deathMatch[3] || '';
      // 简中播报文案映射表
      const deathCauseZh = {
        'was slain by': '被击杀',
        'was killed by': '被杀死',
        'was shot by': '被射杀',
        'was fireballed by': '被火球击中',
        'was blown up by': '被炸死',
        'was stung by': '被蛰死',
        'was pummeled by': '被锤死',
        'was squashed by': '被砸死',
        'was impaled on': '被刺穿',
        'fell from a high place': '从高处摔落',
        'fell off': '从高处掉落',
        drowned: '溺水身亡',
        'blew up': '被炸飞',
        'hit the ground too hard': '重重地摔在地上',
        'tried to swim in lava': '试图在岩浆中游泳',
        'went up in flames': '被烧成灰烬',
        'burned to death': '被烧死',
        'was pricked to death': '被刺死',
        'was doomed to fall': '注定要摔死',
        'was shot off': '被射下',
        'starved to death': '饿死了',
        'suffocated in a wall': '在墙里窒息',
        'withered away': '凋零而死',
        'froze to death': '冻死了',
        died: '死了',
        'was lost': '迷失了',
        disconnected: '断开了连接',
        'experienced kinetic energy': '经历了动能',
      };
      const causeZh = deathCauseZh[cause] || cause;
      const message = killer ? `${causeZh}（by ${killer}）` : causeZh;
      this._addPlayerEvent(playerName, 'death', message);
      // 走聚合通道：团灭等批量场景 5s 窗口合并，多条玩家死亡只广播一条
      this._emitDeathAggregated(playerName, message, killer);
    }

    const achievementMatch = body.match(/^([^\s\]<>[]+) has made the advancement \[(.+)\]/);
    if (achievementMatch) {
      this._addPlayerEvent(achievementMatch[1], 'achievement', `获得成就: ${achievementMatch[2]}`);
      this.emit('achievement', { name: achievementMatch[1], advancement: achievementMatch[2] });
    }

    const challengeMatch = body.match(/^([^\s\]<>[]+) has completed the challenge \[(.+)\]/);
    if (challengeMatch) {
      this._addPlayerEvent(challengeMatch[1], 'achievement', `完成挑战: ${challengeMatch[2]}`);
      this.emit('achievement', {
        name: challengeMatch[1],
        advancement: challengeMatch[2],
        isChallenge: true,
      });
    }

    const respawnMatch = body.match(/^([^\s\]<>[]+) respawned/);
    if (respawnMatch) {
      this._addPlayerEvent(respawnMatch[1], 'respawn', '已重生');
      // 广播复活事件给 WebSocket 客户端
      this.emit('playerRespawn', { name: respawnMatch[1] });
    }

    // ── 聊天事件解析 ──
    // MC 日志格式: "<Player> message"；真实服务端输出行带 "[时间] [线程/级别]: " 前缀，
    // 剥离后再锚定行首——裸聊天行无前缀，剥离为空操作，两种形态均兼容
    // `[Not Secure] ` 是服务端给**未签名**聊天加的前缀（离线模式、未启用安全档案时
    // 全部聊天都带它）。剥离前缀后它仍在消息体里，不认它会让这类聊天的面板事件恒空。
    const chatMatch = body.match(/^(?:\[Not Secure\] )?<([^\s\]<>[]+)>\s+(.+)/);
    if (chatMatch) {
      this.emit('playerChat', { name: chatMatch[1], message: chatMatch[2] });
    }

    // ── 存档事件日志解析 ──
    // "Saving" 是存档开始，"Saved the game" 是存档完成，仅在完成时记录真实时刻
    if (line.includes('Saved the game')) {
      this._lastSaveTime = new Date().toISOString();
      // 存档落盘=世界体积增长点：标记 _getWorldSize 缓存失效（顶层目录 mtime 感知不到子目录写入）
      this._worldSizeDirty = true;
      this.emit('status', { event: 'save' });
    }

    // ── 时间变化日志解析 ──
    // 旧版 MC 日志格式: "Set the time to 1000" (玩家/控制台执行 /time set 时输出)
    // MC 26.1+ 日志格式: "Set the time to 1000" 仍可能输出，但 Time Marker 设置可能无数字
    // 兜底匹配：解析包含 "Set the time to <number>" 的日志行
    const timeLogMatch = line.match(/Set the time to (\d+)/i);
    if (timeLogMatch) {
      this._worldTime = parseInt(timeLogMatch[1], 10) % 24000;
      this._emitPerformance();
    }

    if (line.includes('Done') && line.includes('For help, type')) {
      // 启动完成（世界生成/首次写入结束）：标记存档大小缓存失效
      this._worldSizeDirty = true;
      this.emit('status', { event: 'ready' });
    }

    // ── 天气变化日志解析 ──
    // MC 日志格式: "Changing to clear/rainy/thundering weather" 或 "Set the weather to clear/rain/thunder"
    // 注意：仅命令触发的天气变化会输出日志；自然天气变化无日志，依赖 _collectWorldState 轮询 level.dat
    if (
      line.match(/Changing to (clear|rainy|thundering) weather/i) ||
      line.match(/Set the weather to (clear|rain|thunder)/i)
    ) {
      const lower = line.toLowerCase();
      if (lower.includes('thunder')) {
        this._weather = 'thunder';
      } else if (lower.includes('rain')) {
        this._weather = 'rain';
      } else {
        this._weather = 'clear';
      }
      this.emit('weatherUpdate', { weather: this._weather });
    }

    // ── 玩家睡觉日志解析 ──
    // 注意：Vanilla MC 不输出 "has gone to sleep" 日志，入睡计数依赖 RCON 轮询
    // _collectPlayerStats 每 5 秒查询 SleepTimer 并更新 _sleepingPlayers，此处不再累加
    // Paper 服务器: "Player has gone to sleep" / Vanilla: 无直接日志
    // 睡觉跳过夜晚时天气会恢复晴天（已被上面的天气解析覆盖）

    // ── 玩家离开时减少入睡计数 ──
    // (在 leaveMatch 处理块中已处理)
  }
}

/// 处理玩家加入：载入落盘历史、开新会话、登记在线表并广播。
/// 日志解析与名单对账（roster-sync）共用此唯一入口——加入语义只有一份实现，
/// 免得对账来的玩家在累计时长、会话与事件上与日志来的分叉。
///
/// 幂等：已在在线表里的玩家直接返回既有条目。两个来源都在报同一次加入
/// （名单先到、`joined the game` 行后到，或反之），不设此守卫会重复计一次
/// 今日新增、多记一条 join 事件与通知，并把先登记那次开的会话整段丢掉
/// （每次都从落盘历史重建条目）。
export function _registerPlayerJoin(playerName) {
  const existing = this.players.get(playerName);
  if (existing) return existing;
  const playerIp = this._pendingIps.get(playerName) || '';
  this._pendingIps.delete(playerName);
  // 从持久化文件加载已有总游戏时长与会话历史
  const savedData = this._loadPlayerData(playerName) || {};
  const savedPlayTime = savedData.totalPlayTime || 0;
  const sessions = Array.isArray(savedData.sessions) ? savedData.sessions : [];
  // 若最后一个会话未结束（服务端异常退出），补一个零时长会话，保证会话完整
  const lastSession = sessions[sessions.length - 1];
  if (lastSession && lastSession.end == null) {
    lastSession.end = lastSession.start;
    lastSession.duration = 0;
  }
  // 开启新会话（会话历史用于日志 Tab 的树状时间线）
  sessions.push({ start: Date.now(), end: null, duration: 0 });
  // 限制会话历史数量（保留最近 20 段，避免无限增长）
  if (sessions.length > 20) sessions.splice(0, sessions.length - 20);
  const player = {
    name: playerName,
    joinTime: Date.now(),
    ip: playerIp,
    totalPlayTime: savedPlayTime,
    sessions,
  };
  // 今日新增计数：savedData 无任何历史（时长/会话/事件全空）= 首次加入
  const isFirstJoin =
    !savedData.totalPlayTime && !savedData.sessions?.length && !savedData.events?.length;
  if (isFirstJoin) {
    const key = this._todayKey();
    if (!this._todayNewCache || this._todayNewCache.date !== key) {
      this._todayNewCache = { date: key, count: 0 };
    }
    this._todayNewCache.count++;
  }
  this.players.set(playerName, player);
  this._addPlayerEvent(playerName, 'join', '进入服务器');
  this.emit('playerJoin', player);
  return player;
}

/// 处理玩家离开：保存数据、累计在线时长、关闭会话、记录"离开服务器"事件、移除在线表并广播。
/// 主动离开（left the game）与被动离开（踢出/封禁/断开连接/服务器关闭）共用；
/// 玩家不在在线表时直接返回，避免重复记录。
export function _handlePlayerLeave(playerName) {
  const player = this.players.get(playerName);
  if (!player) return;
  player.lastSeen = Date.now();
  const now = Date.now();
  const sessionSeconds = player.joinTime ? Math.floor((now - player.joinTime) / 1000) : 0;
  if (sessionSeconds > 0) {
    player.totalPlayTime = (player.totalPlayTime || 0) + sessionSeconds;
  }
  // 关闭当前会话（记录结束时间与时长）
  if (Array.isArray(player.sessions) && player.sessions.length > 0) {
    const cur = player.sessions[player.sessions.length - 1];
    if (cur && cur.end == null) {
      cur.end = now;
      cur.duration = sessionSeconds;
    }
  }
  // 必须先记 leave 事件再落盘：_savePlayerData 序列化的是内存 playerEvents，
  // 若先保存，磁盘上永远缺 leave 事件；随后该玩家被移出在线表，
  // 60s 定时保存不会再为其补写，进程退出后 leave 事件将永久丢失。
  this._addPlayerEvent(playerName, 'leave', '离开服务器');
  this._savePlayerData(playerName, player);
  // 减少入睡计数（玩家离开时自动起床）
  if (this._sleepingPlayers > 0) {
    this._sleepingPlayers = Math.max(0, this._sleepingPlayers - 1);
  }
  this.players.delete(playerName);
  this.emit('playerLeave', { name: playerName });
}

export function _addPlayerEvent(playerName, type, message) {
  if (!this.playerEvents.has(playerName)) {
    this.playerEvents.set(playerName, []);
  }
  const events = this.playerEvents.get(playerName);
  events.unshift({
    type,
    message,
    timestamp: Date.now(),
  });
  if (events.length > 50) {
    events.pop();
  }
}
