import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { initDatabase } from '../src/db/database.js';
import { getDb } from '../src/db/database.js';
import { PanelPreferenceModel } from '../src/db/panel_preference.model.js';
import { createPreferenceRoutes } from '../src/routes/preferences.js';
import { errorHandler } from '../src/middleware/error_handler.js';

/**
 * 面板偏好读写：跨设备一致的那部分用户数据落服务端。
 *
 * 覆盖三件容易错的事：未写过的项不出现在响应里（调用方据此回退默认值）、
 * 写入是整份替换单项而非合并、未知键不进库。
 */
describe('面板偏好', () => {
  let app;

  beforeEach(() => {
    initDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/v1', createPreferenceRoutes());
    app.use(errorHandler);
    getDb().exec('DELETE FROM panel_preferences');
  });

  afterEach(() => {
    getDb().exec('DELETE FROM panel_preferences');
  });

  it('未写入任何偏好时返回空对象（不是全量默认值）', async () => {
    const res = await request(app).get('/api/v1/preferences');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
  });

  it('写入后读回同一份数据', async () => {
    const payload = {
      commandPresets: ['time set day', 'gamemode creative'],
      announcementPresets: [{ name: '重启预告', content: '服务器将在 5 分钟后重启' }],
      kits: [{ name: '新手包', icon: '🌱', desc: '起步用', items: [{ id: 'bread', count: 16 }] }],
      quickTeleports: { hideOrigin: true, items: [{ name: '出生点', x: 0, y: 64, z: 0 }] },
      notificationPreferences: { chat: { toast: false } },
    };

    const put = await request(app).put('/api/v1/preferences').send(payload);
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/v1/preferences');
    expect(get.body.data).toEqual(payload);
  });

  it('只写一项时其余项保持原值（写入按项整份替换，不是整体覆盖）', async () => {
    await request(app)
      .put('/api/v1/preferences')
      .send({ commandPresets: ['say hi'] });
    await request(app).put('/api/v1/preferences').send({ kits: [] });

    const get = await request(app).get('/api/v1/preferences');
    expect(get.body.data.commandPresets).toEqual(['say hi']);
    expect(get.body.data.kits).toEqual([]);
  });

  it('重复写入同一项是整份替换（删掉一条不会被旧值合并回来）', async () => {
    await request(app)
      .put('/api/v1/preferences')
      .send({ commandPresets: ['a', 'b', 'c'] });
    await request(app)
      .put('/api/v1/preferences')
      .send({ commandPresets: ['a'] });

    const get = await request(app).get('/api/v1/preferences');
    expect(get.body.data.commandPresets).toEqual(['a']);
  });

  it('未知键被契约剥离，不落库', async () => {
    await request(app)
      .put('/api/v1/preferences')
      .send({ commandPresets: ['say hi'], evilKey: 'payload' });

    expect(PanelPreferenceModel.findAll()).toEqual({ commandPresets: ['say hi'] });
  });

  it('超长条目被拒（400），不静默截断', async () => {
    const res = await request(app)
      .put('/api/v1/preferences')
      .send({ commandPresets: ['x'.repeat(600)] });

    expect(res.status).toBe(400);
  });

  it('模型层直接写入未知键时也不落库（路由层已剥离，这层防绕过契约的调用）', () => {
    PanelPreferenceModel.upsertMany({ commandPresets: ['say hi'], arbitraryKey: { evil: true } });

    const stored = getDb()
      .prepare('SELECT key FROM panel_preferences')
      .all()
      .map((r) => r.key);
    expect(stored).toEqual(['commandPresets']);
  });

  it('库里损坏的 JSON 只丢该项，其余照常返回', async () => {
    await request(app)
      .put('/api/v1/preferences')
      .send({ commandPresets: ['say hi'] });
    getDb()
      .prepare('INSERT INTO panel_preferences (key, value) VALUES (?, ?)')
      .run('kits', '{bad json');

    const res = await request(app).get('/api/v1/preferences');
    expect(res.body.data.commandPresets).toEqual(['say hi']);
    expect(res.body.data.kits).toBeUndefined();
  });
});
