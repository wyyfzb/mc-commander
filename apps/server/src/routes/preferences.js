/**
 * 面板偏好读写（跨设备一致的那部分用户数据）。
 *
 * 存服务端的判据是「换一台设备后，用户还该看到同一份吗」：命令预设、公告预设、
 * 礼包、快捷传送点、通知开关是服主对这台服务器的配置，换浏览器就没了是缺陷。
 * 凭据、主题、当前选中实例不进这里——它们要么属设备，要么同步即扩大泄漏面。
 *
 * 写入是整份替换单项：这些偏好都是手写短列表，前端持有完整副本，
 * 逐条 diff 判不准（删掉一条与从未有过无法区分）。
 */
import { Router } from 'express';
import { panelPreferencesSchema, panelPreferencesPatchSchema } from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { PanelPreferenceModel } from '../db/index.js';

export function createPreferenceRoutes() {
  const router = Router();

  router.get('/preferences', (req, res) => {
    res.json(validatedSuccess(panelPreferencesSchema, PanelPreferenceModel.findAll()));
  });

  router.put('/preferences', validateBody(panelPreferencesPatchSchema), (req, res) => {
    res.json(validatedSuccess(panelPreferencesSchema, PanelPreferenceModel.upsertMany(req.body)));
  });

  return router;
}
