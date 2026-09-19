/**
 * 进程输出解析域（issue 494 治理线·服务端第二阶段）：_parseOutput 与玩家进出事件辅助
 * 自 mc_server.js 等价搬移。挂载方式与 level-dat 域一致：由宿主模块 Object.assign
 * 原型注入复用，模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this
 * 绑定实例），全部调用点零改动，对外接口零变化。域外协作方法（_loadPlayerData、
 * _savePlayerData、_todayKey、_emitDeathAggregated、_emitPerformance）留宿主类内，
 * 经 this 按原型链解析。
 */

export function _parseOutput(text) {
  const lines = text.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const responseMatch = line.match(/\[mcsmp_response:(\d+)\]/);
    if (responseMatch) {
      const commandId = parseInt(responseMatch[1]);
      const promiseInfo = this._commandResponsePromises.get(commandId);
      if (promiseInfo) {
        promiseInfo.buffer.push(line.replace(/\[mcsmp_response:\d+\]\s*/, ''));
      }
      continue;
    }

    const responseEndMatch = line.match(/\[mcsmp_end:(\d+)\]/);
    if (responseEndMatch) {
      const commandId = parseInt(responseEndMatch[1]);
      const promiseInfo = this._commandResponsePromises.get(commandId);
      if (promiseInfo) {
        promiseInfo.resolve(promiseInfo.buffer.join('\n'));
      }
      continue;
    }

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

    const joinMatch = line.match(/([^\s\]<>[]+) joined the game/);
    if (joinMatch) {
      const playerIp = this._pendingIps.get(joinMatch[1]) || '';
      this._pendingIps.delete(joinMatch[1]);
      // 从持久化文件加载已有总游戏时长与会话历史
      const savedData = this._loadPlayerData(joinMatch[1]) || {};
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
        name: joinMatch[1],
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
      this.players.set(joinMatch[1], player);
      this._addPlayerEvent(joinMatch[1], 'join', '进入服务器');
      this.emit('playerJoin', player);
    }

    // 解析玩家 IP（登录日志行包含 IP 地址，可能在 join 前到达）
    const loginIpMatch = line.match(/([^\s\]<>[]+)\[\/?([\d.]+):\d+\] logged in with entity id/);
    if (loginIpMatch) {
      // 如果玩家已存在，直接设 IP；否则缓存等待 join
      const existing = this.players.get(loginIpMatch[1]);
      if (existing) {
        existing.ip = loginIpMatch[2];
      } else {
        this._pendingIps.set(loginIpMatch[1], loginIpMatch[2]);
      }
    }

    const leaveMatch = line.match(/([^\s\]<>[]+) left the game/);
    if (leaveMatch) {
      this._handlePlayerLeave(leaveMatch[1]);
    }

    // 被动离开（踢出/封禁/IP 封禁/断开连接）：服务器日志输出 "lost connection" 或 "was kicked"，
    // 不输出 "left the game"，也应视为"离开服务器"事件。仅在玩家仍在线时处理，避免重复记录。
    const passiveLeaveMatch =
      line.match(/([^\s\]<>[]+) lost connection: /) || line.match(/([^\s\]<>[]+) was kicked /);
    if (passiveLeaveMatch) {
      this._handlePlayerLeave(passiveLeaveMatch[1]);
    }

    // 死亡事件 — 使用更精确的正则避免误匹配
    // MC 26.2 日志格式: "Player was slain by Zombie" / "Player fell from a high place"
    const deathMatch = line.match(
      /([^\s\]<>[]+) (was slain by|was killed by|was shot by|was fireballed by|was blown up by|was stung by|was pummeled by|was squashed by|was impaled on|fell from a high place|fell off|drowned|blew up|hit the ground too hard|tried to swim in lava|went up in flames|burned to death|was pricked to death|was doomed to fall|was shot off|starved to death|suffocated in a wall|withered away|froze to death|died|was lost|disconnected|experienced kinetic energy)(?:\s+(.+))?/,
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

    const achievementMatch = line.match(/([^\s\]<>[]+) has made the advancement \[(.+)\]/);
    if (achievementMatch) {
      this._addPlayerEvent(achievementMatch[1], 'achievement', `获得成就: ${achievementMatch[2]}`);
      this.emit('achievement', { name: achievementMatch[1], advancement: achievementMatch[2] });
    }

    const challengeMatch = line.match(/([^\s\]<>[]+) has completed the challenge \[(.+)\]/);
    if (challengeMatch) {
      this._addPlayerEvent(challengeMatch[1], 'achievement', `完成挑战: ${challengeMatch[2]}`);
      this.emit('achievement', {
        name: challengeMatch[1],
        advancement: challengeMatch[2],
        isChallenge: true,
      });
    }

    const respawnMatch = line.match(/([^\s\]<>[]+) respawned/);
    if (respawnMatch) {
      this._addPlayerEvent(respawnMatch[1], 'respawn', '已重生');
      // 广播复活事件给 WebSocket 客户端
      this.emit('playerRespawn', { name: respawnMatch[1] });
    }

    // ── 聊天事件解析 ──
    // MC 日志格式: "<Player> message"；真实服务端输出行带 "[时间] [线程/级别]: " 前缀，
    // 剥离后再锚定行首——裸聊天行无前缀，剥离为空操作，两种形态均兼容
    const chatLine = line.replace(/^(?:\[[^\]]*\]\s*)*:\s*/, '');
    const chatMatch = chatLine.match(/^<([^\s\]<>[]+)>\s+(.+)/);
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
