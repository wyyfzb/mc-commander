import { getDb } from './database.js';
import { PANEL_PREFERENCE_KEYS } from '@mc-commander/schemas';

/**
 * 面板级偏好台账（键值）。
 *
 * 值一律 JSON 字符串：偏好项的形状归契约包声明，本层不解析内容，
 * 只做「按 key 存取」。这样新增一类偏好不必改这里，也不会出现
 * 「服务端按旧形状校验、前端已升级」的漂移。
 *
 * 写入是整份替换：这些偏好都是手写短列表，前端持有完整副本，
 * 逐条 diff 既无必要也判不准（删掉一条与从未有过无法区分）。
 */
export class PanelPreferenceModel {
  /** 读出全部偏好，返回 { [key]: 已解析值 }；损坏项跳过而非整体失败 */
  static findAll() {
    const rows = getDb().prepare('SELECT key, value FROM panel_preferences').all();
    const out = {};
    for (const row of rows) {
      if (!PANEL_PREFERENCE_KEYS.includes(row.key)) continue;
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        // 单条损坏只丢这一项，其余照常返回
      }
    }
    return out;
  }

  /** 整份写入若干项；未出现的键保持原值 */
  static upsertMany(patch) {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO panel_preferences (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    );
    const entries = Object.entries(patch).filter(([key]) => PANEL_PREFERENCE_KEYS.includes(key));
    db.transaction(() => {
      for (const [key, value] of entries) stmt.run(key, JSON.stringify(value));
    })();
    return this.findAll();
  }
}
