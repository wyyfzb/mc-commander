/**
 * 世界存档数据读取域 —— 自 mc_server.js McServer 类纯搬移（issue 490 治理线·服务端第一阶段）
 * 职责：level.dat / world_gen_settings.dat / weather.dat 的 NBT 解析（新旧 MC 版本兼容）、
 *       世界目录定位（level-name 服务层兜底校验）、存档大小与保存时间读取。
 * 挂载方式：mc_server.js 顶部 import 后经 Object.assign(MCServerManager.prototype, levelDat)
 * 注入原型——函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
 * 全部调用点零改动，对外接口零变化；isPathContained 采用 utils/player-utils.js 全仓公共实现
 * （与 mc_server.js 本地副本逐字相同，双份重复公共化）。
 */
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { parseUncompressed as parseNbtSync } from 'prismarine-nbt';
import { logger } from '../../utils/logger.js';
import { isPathContained } from '../../utils/player-utils.js';

/// level-name 服务层兜底校验（extra-1，与 status-route 路由层白名单双保险）：
/// ①正则 ^[A-Za-z0-9_-]+$（不含路径分隔符/..，杜绝路径穿越）；
/// ②resolve 后必须位于 serverPath 内（路径边界前缀校验）。
/// 非法/越界时告警并回退 'world'（合法世界名恒在 serverPath 内），
/// 避免恶意/损坏的 level-name 使本服务的文件读写越出实例目录。
export function _getSafeLevelName() {
  const raw = this.properties?.['level-name'] || 'world';
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    logger.warn(`[Instance ${this.id}] 非法 level-name '${raw}'（仅允许字母/数字/_/-），回退 'world'`);
    return 'world';
  }
  if (!isPathContained(this.serverPath, raw)) {
    logger.warn(`[Instance ${this.id}] level-name '${raw}' 越出实例目录，回退 'world'`);
    return 'world';
  }
  return raw;
}

export function _getWorldSize() {
  // 使用 server.properties 的 level-name 而非硬编码 'world'，
  // 兼容自定义世界目录名的实例（服务层兜底校验防路径穿越）
  const levelName = this._getSafeLevelName();
  const worldPath = path.join(this.serverPath, levelName);
  if (!fs.existsSync(worldPath)) return 0;

  // 带失效机制的缓存（与 _readSeedFromLevelDat 同型）：记录世界目录的
  // mtimeMs/size，每次调用仅对该目录做一次 statSync 校验，目录结构或存档
  // 变化（mtime/size 变化）才重算。worldSize 是低频变化数据（仅存档落盘
  // 时变），若每次轮询都对全树做 readdirSync+statSync 同步遍历，数万文件
  // 目录单次遍历约 3 秒，会同步阻塞 Node 事件循环（HTTP/WS/RCON/定时器
  // 全部延迟）。目录被删除/替换（恢复备份、版本升级等）后 mtime/size 变化
  // 即自动失效重算，对新旧 MC 版本目录结构差异（含 26.x 新增 dimension/
  // minecraft:* 层级）同样生效，无需版本特判。仅成功时缓存：世界目录
  // 不存在/遍历失败不缓存，便于世界生成后立即重算。
  if (this._worldSizeCache !== undefined) {
    const { value, mtimeMs, size } = this._worldSizeCache;
    try {
      const st = fs.statSync(worldPath);
      if (st.mtimeMs === mtimeMs && st.size === size) return value;
    } catch {
      // 世界目录被删除/替换 → 缓存失效，重新计算
    }
    this._worldSizeCache = undefined;
  }

  try {
    // 遍历前先取目录 stat 作缓存键：若遍历期间目录发生变化，下次调用
    // 校验失效触发重算，保证展示值收敛到最新大小。
    const st = fs.statSync(worldPath);
    // 递归累加所有文件大小（region/、playerdata/、data/ 等子目录
    // 占据世界数据主体，仅遍历顶层文件会严重低估存档大小）
    let size = 0;
    const stack = [worldPath];
    while (stack.length > 0) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          try {
            size += fs.statSync(fullPath).size;
          } catch {}
        }
      }
    }
    this._worldSizeCache = {
      value: Math.round(size / (1024 * 1024 * 1024) * 100) / 100,
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    return this._worldSizeCache.value;
  } catch (err) {
    logger.warn(`[Instance ${this.id}] 计算存档大小失败:`, err.message);
    return 0;
  }
}

/// 读取世界种子（NBT 格式），兼容新旧 MC 版本。
/// MC 26.1+  : WorldGenSettings 从 level.dat 拆分到独立的 world_gen_settings.dat（优先读取）
/// MC 1.16+  : Data.WorldGenSettings.seed（level.dat）
/// 旧版      : Data.RandomSeed（level.dat）
/// server.properties 的 level-seed 在世界创建后通常为空，无法反映真实种子。
export function _readSeedFromLevelDat() {
  // 缓存带失效机制：记录读取源文件的路径、修改时间与大小，每次调用先校验，
  // 源文件被替换（恢复备份、手动替换世界目录等）后 mtime/size 变化即自动
  // 失效重读，避免仪表盘永久显示旧种子。仅成功时缓存：若存档尚未生成或
  // 解析失败，不缓存，便于世界生成/版本升级后重试。
  if (this._seedCache !== undefined) {
    const { value, sourcePath, mtimeMs, size } = this._seedCache;
    try {
      const st = fs.statSync(sourcePath);
      if (st.mtimeMs === mtimeMs && st.size === size) return value;
    } catch {
      // 源文件不存在（世界目录被删除/替换）→ 缓存失效，重新读取
    }
    this._seedCache = undefined;
  }

  // 优先 MC 26.1+ 拆分出的 world_gen_settings.dat
  const genSeed = this._readSeedFromWorldGenSettings();
  if (genSeed != null) {
    this._seedCache = {
      value: genSeed.seed,
      sourcePath: genSeed.path,
      mtimeMs: genSeed.mtimeMs,
      size: genSeed.size,
    };
    return genSeed.seed;
  }

  // 回退旧版 level.dat
  const levelName = this._getSafeLevelName();
  const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
  if (!fs.existsSync(levelDatPath)) return null;

  try {
    const raw = fs.readFileSync(levelDatPath);
    const decompressed = zlib.gunzipSync(raw);
    const parsed = parseNbtSync(decompressed);

    const data = parsed?.value?.Data?.value || parsed?.value || {};
    // 1.16+ 的 WorldGenSettings.seed
    const worldGenSeed = data.WorldGenSettings?.value?.seed?.value;
    if (worldGenSeed != null) {
      this._seedCache = this._makeSeedCache(String(worldGenSeed), levelDatPath);
      return String(worldGenSeed);
    }
    // 旧版的 RandomSeed
    const randomSeed = data.RandomSeed?.value;
    if (randomSeed != null) {
      this._seedCache = this._makeSeedCache(String(randomSeed), levelDatPath);
      return String(randomSeed);
    }
    return null;
  } catch (err) {
    logger.warn(`[Instance ${this.id}] 读取世界种子失败:`, err.message);
    return null;
  }
}

/// 从 MC 26.1+ 的 world_gen_settings.dat 读取世界种子
/// 26.1 起 WorldGenSettings 从 level.dat 拆分到独立文件，真实路径为
/// <world>/<dimension>/data/minecraft/world_gen_settings.dat（主世界用 level-name 对应目录），
/// 保留世界根目录 world_gen_settings.dat 作为兜底。
/// 文件根为 { data: {...}, DataVersion }，seed 在 data 子节点；兼容直接以
/// WorldGenSettings 内容为根的拆分结构。
export function _readSeedFromWorldGenSettings() {
  const levelName = this._getSafeLevelName();
  const genPaths = [
    path.join(this.serverPath, levelName, 'data', 'minecraft', 'world_gen_settings.dat'),
    path.join(this.serverPath, levelName, 'world_gen_settings.dat'),
  ];
  const genPath = genPaths.find((p) => fs.existsSync(p));
  if (!genPath) return null;

  try {
    const raw = fs.readFileSync(genPath);
    const decompressed = zlib.gunzipSync(raw);
    const parsed = parseNbtSync(decompressed);
    const root = parsed?.value || {};
    const data = root.data?.value || root;

    const candidates = [
      data.seed,
      data.WorldGenSettings?.value?.seed,
      root.WorldGenSettings?.value?.seed,
      root.seed,
    ];
    for (const c of candidates) {
      if (c?.value != null) {
        const st = fs.statSync(genPath);
        return { seed: String(c.value), path: genPath, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    return null;
  } catch (err) {
    logger.warn(`[Instance ${this.id}] 读取 world_gen_settings.dat 种子失败:`, err.message);
    return null;
  }
}

/// 构造种子缓存条目（含源文件 mtime/size，用于校验缓存是否失效）
export function _makeSeedCache(value, sourcePath) {
  const st = fs.statSync(sourcePath);
  return { value, sourcePath, mtimeMs: st.mtimeMs, size: st.size };
}

/// 获取运行中的真实难度（多端同步用）。
/// 游戏内 /difficulty 只改 level.dat，不写回 server.properties，因此：
/// 优先 RCON 实时查询 /difficulty（内存值，无延迟）；
/// RCON 不可用/失败时回退解析 level.dat
/// （MC 26.x difficulty_settings.difficulty 字符串 / 旧版 Difficulty 字节）。
/// 返回 'peaceful'|'easy'|'normal'|'hard'，解析失败返回 null（由调用方回退文件值）。
export async function readDifficulty() {
  if (this.isRunning && this.isRconConnected) {
    try {
      const resp = await this.sendCommandWithResponse('difficulty', {
        timeout: 3000,
      });
      const m = String(resp || '').match(/difficulty is\s+(\w+)/i);
      if (m && m[1]) return m[1].toLowerCase();
    } catch {}
  }
  return this._readDifficultyFromLevelDat();
}

/// 从 level.dat 读取默认游戏模式（GameType: 0=生存/1=创造/2=冒险/3=旁观）。
/// 游戏内 /defaultgamemode 修改 level.dat 的 GameType，不写回 server.properties。
/// 返回 'survival'|'creative'|'adventure'|'spectator'，解析失败返回 null。
export function _readGameTypeFromLevelDat() {
  const data = this._readLevelDatData();
  if (!data) return null;
  const num = data.GameType?.value;
  if (typeof num === 'number' && num >= 0 && num <= 3) {
    return ['survival', 'creative', 'adventure', 'spectator'][num];
  }
  return null;
}

/// 从 level.dat 读取难度。
/// MC 26.x：Data.difficulty_settings.difficulty（字符串 peaceful/easy/normal/hard）；
/// 旧版：Data.Difficulty（字节 0-3）。返回小写难度词或 null。
export function _readDifficultyFromLevelDat() {
  const data = this._readLevelDatData();
  if (!data) return null;
  const ds = data.difficulty_settings?.value;
  if (ds?.difficulty?.value) {
    const v = String(ds.difficulty.value).toLowerCase();
    if (['peaceful', 'easy', 'normal', 'hard'].includes(v)) return v;
  }
  const num = data.Difficulty?.value;
  if (typeof num === 'number' && num >= 0 && num <= 3) {
    return ['peaceful', 'easy', 'normal', 'hard'][num];
  }
  return null;
}

/// 读取并解压 level.dat，返回 Data 子节点（无/解析失败返回 null）。
/// 26.x 仍把 difficulty_settings/GameType 存于 Data 子节点。
export function _readLevelDatData() {
  const levelName = this._getSafeLevelName();
  const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
  if (!fs.existsSync(levelDatPath)) return null;
  try {
    const parsed = parseNbtSync(
      zlib.gunzipSync(fs.readFileSync(levelDatPath)),
    );
    return parsed?.value?.Data?.value || parsed?.value || null;
  } catch (err) {
    logger.warn(`[Instance ${this.id}] 读取 level.dat 失败:`, err.message);
    return null;
  }
}

export function _getLastSaveTime() {
  // 优先返回真实存档时刻（来自 "Saved the game" 日志解析）
  if (this._lastSaveTime) return this._lastSaveTime;
  // 回退：世界目录最后修改时间（服务器未输出存档日志或刚启动尚未存档时）
  const levelName = this._getSafeLevelName();
  const worldPath = path.join(this.serverPath, levelName);
  if (!fs.existsSync(worldPath)) return null;
  try {
    const stat = fs.statSync(worldPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

/// 从存档文件读取天气状态（NBT 格式），兼容新旧 MC 版本。
/// MC 26.x   : 天气已从 level.dat 移出，存于 <world>/data/minecraft/weather.dat 的 data 子节点
/// 旧版      : level.dat 的 Data.raining / Data.thundering（含 isRaining/isThundering 兼容）
/// 返回 'clear' / 'rain' / 'thunder'，读取失败返回 null
export function _readWeatherFromLevelDat() {
  const levelName = this._getSafeLevelName();

  // 优先 MC 26.x：weather.dat
  const weatherPath = path.join(this.serverPath, levelName, 'data', 'minecraft', 'weather.dat');
  if (fs.existsSync(weatherPath)) {
    try {
      const parsed = parseNbtSync(zlib.gunzipSync(fs.readFileSync(weatherPath)));
      const root = parsed?.value || {};
      const data = root.data?.value || root;
      const isRaining = data.raining?.value === 1 || data.raining?.value === true;
      const isThundering = data.thundering?.value === 1 || data.thundering?.value === true;

      if (isThundering) return 'thunder';
      if (isRaining) return 'rain';
      return 'clear';
    } catch {
      // weather.dat 读取失败，回退旧版 level.dat
    }
  }

  // 回退旧版 level.dat
  const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
  if (!fs.existsSync(levelDatPath)) return null;

  try {
    const raw = fs.readFileSync(levelDatPath);
    // level.dat 是 gzip 压缩的 NBT 数据
    const decompressed = zlib.gunzipSync(raw);
    const parsed = parseNbtSync(decompressed);

    // NBT 结构: { Data: { raining, thundering, clearWeatherTime, rainTime, thunderTime, ... } }
    const data = parsed?.value?.Data?.value || parsed?.value || {};
    // MC 真实字段名为 raining/thundering；保留 isRaining/isThundering 兼容旧实现
    const isRaining = data.raining?.value === 1 || data.raining?.value === true
      || data.isRaining?.value === 1 || data.isRaining?.value === true;
    const isThundering = data.thundering?.value === 1 || data.thundering?.value === true
      || data.isThundering?.value === 1 || data.isThundering?.value === true;

    if (isThundering) return 'thunder';
    if (isRaining) return 'rain';
    return 'clear';
  } catch {
    // level.dat 读取失败
    return null;
  }
}

/// 从 level.dat 读取世界出生点坐标（NBT 格式）
/// 旧版      : Data.SpawnX, Data.SpawnY, Data.SpawnZ（三个顶层 Int）
/// MC 1.21+  : Data.spawn compound（含坐标与出生维度），坐标在 pos 列表或 SpawnX/Y/Z 字段中
export function _readWorldSpawnFromLevelDat(rawOverride) {
  const levelName = this._getSafeLevelName();
  const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
  if (!fs.existsSync(levelDatPath)) return;

  try {
    // rawOverride：get _worldSpawn 已读取过原始字节时直接复用，避免重复读盘
    const raw = rawOverride ?? fs.readFileSync(levelDatPath);
    const decompressed = zlib.gunzipSync(raw);
    const parsed = parseNbtSync(decompressed);

    const data = parsed?.value?.Data?.value || parsed?.value || {};
    let spawnX, spawnY, spawnZ;
    // 新版（1.21+）：Data.spawn compound，优先 pos 数组，其次 SpawnX/Y/Z 字段
    const spawn = data.spawn?.value;
    if (spawn) {
      // prismarine-nbt 的 pos 可能是两种类型：
      // - intArray: { type: 'intArray', value: [x, y, z] }（实测 26.x 真实格式，value 直接是数组）
      // - list:     { type: 'list', value: { type, value: [x, y, z] } }
      const posVal = spawn.pos?.value;
      const posArr = Array.isArray(posVal) ? posVal : posVal?.value;
      if (Array.isArray(posArr) && posArr.length >= 3) {
        spawnX = posArr[0];
        spawnY = posArr[1];
        spawnZ = posArr[2];
      } else {
        spawnX = spawn.SpawnX?.value;
        spawnY = spawn.SpawnY?.value;
        spawnZ = spawn.SpawnZ?.value;
      }
    }
    // 旧版兜底：Data.SpawnX/SpawnY/SpawnZ
    if (spawnX == null) spawnX = data.SpawnX?.value;
    if (spawnY == null) spawnY = data.SpawnY?.value;
    if (spawnZ == null) spawnZ = data.SpawnZ?.value;

    if (spawnX != null && spawnY != null && spawnZ != null) {
      this._worldSpawn = { x: spawnX, y: spawnY, z: spawnZ };
      // 记录本次成功解析的原始字节，供 get _worldSpawn 做运行期变更检测；
      // 仅在成功解析后更新，解析失败时下次访问会重试
      this._worldSpawnRaw = raw;
      logger.info(`[${this.id}] World spawn initialized from level.dat: ${spawnX}, ${spawnY}, ${spawnZ}`);
    }
  } catch (e) {
    logger.warn(`[${this.id}] Failed to read world spawn from level.dat:`, e.message);
  }
}
