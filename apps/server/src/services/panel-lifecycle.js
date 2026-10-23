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
    return { key: item.key, label: item.label, path: item.dir, entries, bytes };
  });
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
  for (const [dir, name] of [
    [config.serversDir, 'servers'],
    [config.backupsDir, 'backups'],
  ]) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) sources.push({ dir, name });
    } catch {}
  }
  return sources;
}
