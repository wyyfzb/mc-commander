import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

/**
 * 面板自身的去留：数据清点、导出、停用。
 *
 * 三种用户意图必须分开，因为它们对数据的处置相反：暂时不用（全留）、
 * 换机器（全留且要能带走）、彻底不玩（全删）。压成一个动作时，用户无法
 * 从名字判断存档会不会没。
 */

/** 逐项核实每个数据目录里**真实**有多少东西：写死「数据已保留」在空目录上就是假话 */
export function surveyData() {
  const items = [
    { key: 'servers', label: '服务器实例与存档', dir: config.serversDir },
    { key: 'data', label: '面板数据库', dir: config.dataDir },
    { key: 'backups', label: '备份快照', dir: config.backupsDir },
  ];
  return items.map((item) => {
    let entries = 0;
    let bytes = 0;
    try {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            entries++;
            try {
              bytes += fs.statSync(full).size;
            } catch {}
          }
        }
      };
      if (fs.existsSync(item.dir)) walk(item.dir);
    } catch {}
    // 所在文件系统的余量：用户问「要不要清理」时唯一能回答这个问题的数字，
    // 只报占用不报余量等于让他自己想办法
    let freeBytes = -1;
    let mountPoint = '';
    try {
      const st = fs.statfsSync(item.dir);
      freeBytes = st.bavail * st.bsize;
      mountPoint = mountOf(item.dir);
    } catch {
      /* 目录不存在或平台不支持：留 -1，前端显示「未知」而不是 0 */
    }
    return {
      key: item.key,
      label: item.label,
      path: item.dir,
      entries,
      bytes,
      freeBytes,
      mountPoint,
    };
  });
}

/** 逐级上溯找挂载点：读 /proc/mounts 里出现的最长前缀 */
function mountOf(dir) {
  try {
    const mounts = fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter(Boolean)
      .map((p) => p.replace(/\\040/g, ' '));
    let best = '';
    for (const m of mounts) {
      if ((dir === m || dir.startsWith(m.endsWith('/') ? m : `${m}/`)) && m.length > best.length) {
        best = m;
      }
    }
    return best;
  } catch {
    return '';
  }
}

/** 有内容的目录才算「会被删掉的数据」；全空时如实说没有数据，不虚报 */
export function hasAnyData(survey) {
  return survey.some((s) => s.entries > 0);
}

/**
 * 把实例目录与备份打成单个压缩包。低代码用户换机器时要的是一个文件，
 * 不是让他理解 var/servers 与 var/backups 的关系再分别拷。
 */
export function collectExportSources() {
  const sources = [];
  for (const dir of [config.serversDir, config.backupsDir]) {
    try {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) continue;
      // 成员名必须取目录自己的名字：数据目录可被用户改到任意位置，
      // 打包时按「父目录 + 成员名」定位，写死名字会 stat 不到而打出一个空包
      sources.push({ dir, name: path.basename(dir) });
    } catch {}
  }
  return sources;
}
