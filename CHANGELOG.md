# Changelog

## [0.7.5](https://github.com/wyyfzb/mc-commander/compare/v0.7.4...v0.7.5) (2026-10-07)


### Bug Fixes

* 立事件「状态 vs 事件」口径，并修世界格式升级进度与三条自愈缺口 ([a3d8f78](https://github.com/wyyfzb/mc-commander/commit/a3d8f78aae04c1c60293a48f9d8cb54cc3a8b694))

## [0.7.4](https://github.com/wyyfzb/mc-commander/compare/v0.7.3...v0.7.4) (2026-10-07)


### Bug Fixes

* 补齐世界格式升级进度可见性，并收敛版本解析与依赖锁 ([#645](https://github.com/wyyfzb/mc-commander/issues/645)) ([5023cf1](https://github.com/wyyfzb/mc-commander/commit/5023cf1cdee40e9c4489fd74ff4501fbcd5c4472))

## [0.7.3](https://github.com/wyyfzb/mc-commander/compare/v0.7.2...v0.7.3) (2026-10-06)


### Bug Fixes

* **deps:** bump @modelcontextprotocol/sdk from 1.30.0 to 1.32.1 in /mc_manager_web ([#638](https://github.com/wyyfzb/mc-commander/issues/638)) ([8029a09](https://github.com/wyyfzb/mc-commander/commit/8029a09f481b8ac5e20fa3ce2cef8eb13267770e))

## [0.7.2](https://github.com/wyyfzb/mc-commander/compare/v0.7.1...v0.7.2) (2026-10-06)


### Bug Fixes

* **deps:** bump source-map-js from 1.2.1 to 1.2.2 in /mc_commander_server ([#633](https://github.com/wyyfzb/mc-commander/issues/633)) ([45a7849](https://github.com/wyyfzb/mc-commander/commit/45a78496d2cfed825ca4a5f2072878807c0e1759))
* **deps:** bump source-map-js from 1.2.1 to 1.2.2 in /mc-schemas ([#632](https://github.com/wyyfzb/mc-commander/issues/632)) ([2243ec2](https://github.com/wyyfzb/mc-commander/commit/2243ec23b98d39a37953f94553f9f35aa59bef44))
* **deps:** 修 proxy-addr 的 IP 欺骗漏洞（2.0.7 → 2.0.8） ([#630](https://github.com/wyyfzb/mc-commander/issues/630)) ([3d4f43d](https://github.com/wyyfzb/mc-commander/commit/3d4f43df7696aa00e70cb2f666e98d8176e1449e))
* **web:** 世界格式升级的进度就地更新成进度条 ([#628](https://github.com/wyyfzb/mc-commander/issues/628)) ([d89ae46](https://github.com/wyyfzb/mc-commander/commit/d89ae46f24bc7ad9b240303a49b95cff87712b31))
* **web:** 按实测边界收起低版本的「新建数据包」入口 ([#629](https://github.com/wyyfzb/mc-commander/issues/629)) ([72be018](https://github.com/wyyfzb/mc-commander/commit/72be018d085b68cd3980951bb9f40784abc1a6a8))

## [0.7.1](https://github.com/wyyfzb/mc-commander/compare/v0.7.0...v0.7.1) (2026-10-05)


### Bug Fixes

* **deps:** bump rolldown from 1.2.11 to 1.2.12 in /mc-schemas in the minor-and-patch group across 1 directory ([#617](https://github.com/wyyfzb/mc-commander/issues/617)) ([3dcd98e](https://github.com/wyyfzb/mc-commander/commit/3dcd98e739a612caa748436f30165271dbc70237))
* **deps:** bump the minor-and-patch group across 1 directory with 2 updates ([#623](https://github.com/wyyfzb/mc-commander/issues/623)) ([fd85328](https://github.com/wyyfzb/mc-commander/commit/fd8532865cd02c677fbc579424eaf12b95884f05))
* **deps:** bump the minor-and-patch group across 1 directory with 5 updates ([#624](https://github.com/wyyfzb/mc-commander/issues/624)) ([1dffc0d](https://github.com/wyyfzb/mc-commander/commit/1dffc0d6a27ac204b57431284be9c70b46017c74))
* **deps:** msw 升级到 3.0.2 并适配其 API 变更 ([#626](https://github.com/wyyfzb/mc-commander/issues/626)) ([3bf6b64](https://github.com/wyyfzb/mc-commander/commit/3bf6b6408e8c0afd92aab50a40d8a1d635fb7a8a))

## [0.7.0](https://github.com/wyyfzb/mc-commander/compare/v0.6.1...v0.7.0) (2026-10-05)


### Features

* 台账批次收口（玩家名判据、崩溃产物呈现、数据包面板、MSMP 推送通道） ([#621](https://github.com/wyyfzb/mc-commander/issues/621)) ([254696a](https://github.com/wyyfzb/mc-commander/commit/254696a141bc74550dd417e57a29741c4fdfd7f3))

## [0.6.1](https://github.com/wyyfzb/mc-commander/compare/v0.6.0...v0.6.1) (2026-10-04)


### Bug Fixes

* 修复实机走查第二轮缺陷，并移除 got 根治审计门禁 ([#614](https://github.com/wyyfzb/mc-commander/issues/614)) ([6b912ff](https://github.com/wyyfzb/mc-commander/commit/6b912ffc868f331fb3437e400fbd4ccefc62cf04))

## [0.6.0](https://github.com/wyyfzb/mc-commander/compare/v0.5.4...v0.6.0) (2026-10-02)


### Features

* 修复实机走查发现的部署与检测缺陷，并新增 Gitee 产物同步 ([61cac13](https://github.com/wyyfzb/mc-commander/commit/61cac13e7306b476e399368b5df7e76686dbe905))

## [0.5.4](https://github.com/wyyfzb/mc-commander/compare/v0.5.3...v0.5.4) (2026-10-01)


### Bug Fixes

* **ci:** 修 dependabot.yml 重复 ignore 键（jsdom 被静默吃掉），并撤除已失效的 jsdom 钉版 ([#611](https://github.com/wyyfzb/mc-commander/issues/611)) ([64b0620](https://github.com/wyyfzb/mc-commander/commit/64b0620290fde4444bc82fd4b3673c5fd51b2032))
* **deps:** bump oxlint from 1.85.0 to 1.86.0 in /mc-schemas in the minor-and-patch group ([#609](https://github.com/wyyfzb/mc-commander/issues/609)) ([4165fe1](https://github.com/wyyfzb/mc-commander/commit/4165fe1056fd5be2d0cf2dc9de5ac9f412617093))
* **deps:** bump the minor-and-patch group in /mc_manager_web with 2 updates ([#610](https://github.com/wyyfzb/mc-commander/issues/610)) ([e30aefe](https://github.com/wyyfzb/mc-commander/commit/e30aefe2afed032b020e63d7d08ea7afdca3358c))
* **deps:** 三包 vitest 与 coverage-v8 成对升到 5.0.3，并登记为 dependabot 已知例外 ([#607](https://github.com/wyyfzb/mc-commander/issues/607)) ([0bd4b06](https://github.com/wyyfzb/mc-commander/commit/0bd4b06f78c9f567104dd454cf0d1aad94145544))

## [0.5.3](https://github.com/wyyfzb/mc-commander/compare/v0.5.2...v0.5.3) (2026-10-01)


### Bug Fixes

* **ci:** dependabot 把 vitest 与其 coverage 同伴归入同一分组，解开 peer 死锁 ([#601](https://github.com/wyyfzb/mc-commander/issues/601)) ([0d98e61](https://github.com/wyyfzb/mc-commander/commit/0d98e6145f8f6ac3a5cd11c7fda2563ae894a324))
* **ci:** dependabot 的依赖升级前缀改 fix(deps)，安全修复不再静默不发版 ([#588](https://github.com/wyyfzb/mc-commander/issues/588)) ([1fd5440](https://github.com/wyyfzb/mc-commander/commit/1fd544042c698191624a54806de425cef4afbed2))
* **ci:** 修发版触发面——packages 改用根键，前端/契约包改动不再被丢弃 ([#585](https://github.com/wyyfzb/mc-commander/issues/585)) ([422f7b0](https://github.com/wyyfzb/mc-commander/commit/422f7b044337545871a0f3b2021939e7f31da8ae))
* **deps:** bump dotenv from 17.4.2 to 18.0.4 in /mc_commander_server ([#593](https://github.com/wyyfzb/mc-commander/issues/593)) ([873f1ec](https://github.com/wyyfzb/mc-commander/commit/873f1eca0e05e1fcd5a2da0b55fd3fd4ac5e1949))
* **deps:** bump got from 15.1.0 to 16.0.0 in /mc_commander_server ([#592](https://github.com/wyyfzb/mc-commander/issues/592)) ([604435c](https://github.com/wyyfzb/mc-commander/commit/604435cc0f5aecfe04708298dcc566f374e33002))
* **deps:** bump the minor-and-patch group across 1 directory with 2 updates ([#591](https://github.com/wyyfzb/mc-commander/issues/591)) ([2f07008](https://github.com/wyyfzb/mc-commander/commit/2f070087985e70624a452ceeb66206796fd6f7b4))
* **deps:** bump the minor-and-patch group across 1 directory with 3 updates ([#589](https://github.com/wyyfzb/mc-commander/issues/589)) ([5af5b57](https://github.com/wyyfzb/mc-commander/commit/5af5b5796d9524df2b4f2d10316cec5aba7cdaa7))
* **deps:** dompurify 收紧到 &gt;=3.4.16，清掉运行时 XSS（GHSA-p98j-92pf-mc4p） ([#602](https://github.com/wyyfzb/mc-commander/issues/602)) ([6b389f3](https://github.com/wyyfzb/mc-commander/commit/6b389f32d7196dd093b718a974b25cb1b1e11440))
* **deps:** jsdom 钉在 30.0.1 并落地 [#597](https://github.com/wyyfzb/mc-commander/issues/597) 的其余 43 项升级，解开 msw 兼容死锁 ([#604](https://github.com/wyyfzb/mc-commander/issues/604)) ([a80f741](https://github.com/wyyfzb/mc-commander/commit/a80f7411c94d22d124ec3331e019277e20e6c2a4))
* **deps:** 前端 6 条依赖 advisory 清零 + 补生产依赖漏洞门禁 ([#582](https://github.com/wyyfzb/mc-commander/issues/582)) ([32fa26d](https://github.com/wyyfzb/mc-commander/commit/32fa26d860372f9e9fd40542b043cac808d937f2))
* **schemas:** zod 3 → 4 迁移，逐字保留用户可见的错误文案契约 ([#603](https://github.com/wyyfzb/mc-commander/issues/603)) ([fc79475](https://github.com/wyyfzb/mc-commander/commit/fc79475f6b7925568c4e40eb6f04256a52566192))

## [0.5.2](https://github.com/wyyfzb/mc-commander/compare/v0.5.1...v0.5.2) (2026-09-30)


### Bug Fixes

* **deps:** 服务端 7 条高危 advisory 清零（multer / adm-zip） ([6b57d53](https://github.com/wyyfzb/mc-commander/commit/6b57d5395f6633adb1c7059181b59dc3a09c99bf))
* **deps:** 服务端 7 条高危 advisory 清零（multer / adm-zip） ([4af2c55](https://github.com/wyyfzb/mc-commander/commit/4af2c551c50596b3f44337db8f5c3f8695c45022))

## [0.5.1](https://github.com/wyyfzb/mc-commander/compare/v0.5.0...v0.5.1) (2026-09-29)


### Bug Fixes

* 收口工作流重构的遗留——悬空注释、失效文档与 deploy 脚本的错误 sudo 用法 ([fa65136](https://github.com/wyyfzb/mc-commander/commit/fa65136fd9555f5c683f893a906d6e33a66e9df0))
* 收口工作流重构的遗留——悬空注释、失效文档与 deploy 脚本的错误 sudo 用法 ([c1b1a20](https://github.com/wyyfzb/mc-commander/commit/c1b1a20f18f15cb48b4ee0c9dac73b2f37faf66f))

## [0.5.0](https://github.com/wyyfzb/mc-commander/compare/v0.4.0...v0.5.0) (2026-09-29)


### Features

* 接通 highMemory 告警——走整机内存口径，不做 JVM 堆采集 ([b3bda44](https://github.com/wyyfzb/mc-commander/commit/b3bda4461a8703c1822c054f8bc10b46801e7e9e))
* 接通 highMemory 告警——走整机内存口径，不做 JVM 堆采集 ([f98443d](https://github.com/wyyfzb/mc-commander/commit/f98443d8358899c5bbf0e007ea142346b291dae2))


### Bug Fixes

* **server:** 指标保留期 24h→48h，使「昨日」在一天内任意时刻都可完整计算 ([44a5153](https://github.com/wyyfzb/mc-commander/commit/44a5153389a8e02dc1a041b8b4d1ac6319b487ae))
* **server:** 指标保留期 24h→48h，使「昨日」在一天内任意时刻都可完整计算 ([dbce349](https://github.com/wyyfzb/mc-commander/commit/dbce349a426c361cfc07ada8e0257e658a224368))

## [0.4.0](https://github.com/wyyfzb/mc-commander/compare/v0.3.0...v0.4.0) (2026-09-29)


### Features

* **server:** mods 目录抽象化（含审查修复）+ Modrinth 条目类型参数化 ([0aa32c4](https://github.com/wyyfzb/mc-commander/commit/0aa32c40ec8277ff3f74fa34ee7fd5cb40b7ad8d))
* **server:** 机器凭据作用域地基（一期只发放只读作用域） ([3a9f5ff](https://github.com/wyyfzb/mc-commander/commit/3a9f5ff462387539e6728604ec23cbc31765cc8b))
* **server:** 机器凭据作用域地基（一期只发放只读作用域） ([b0edc42](https://github.com/wyyfzb/mc-commander/commit/b0edc422c0867b75bd136620c04e86fb2ab77ca0))
* **server:** 模组管理（mods 目录抽象化 + Modrinth 条目类型参数化） ([5b9d174](https://github.com/wyyfzb/mc-commander/commit/5b9d174925bcd3e5ece7c0970bae9570491f7e87))
* **server:** 模组管理（mods/ 复用插件模型：列表 / 上传 / 删除） ([0c88b1f](https://github.com/wyyfzb/mc-commander/commit/0c88b1fc83124e4c1547a4a37635ad95140e08ea))
* **web:** 命令历史支持行内重发（二次确认 + 来源标记） ([578ecc0](https://github.com/wyyfzb/mc-commander/commit/578ecc0827db6b6532b3000646e832f5b395143a))
* **web:** 命令历史支持行内重发（二次确认 + 来源标记） ([60d91fe](https://github.com/wyyfzb/mc-commander/commit/60d91fe9a341ba1fd794e40dd5d5242e8c5c6738))
* **web:** 接通磁盘告警——阈值随契约下发，两档按档位跃迁 ([9cf9d90](https://github.com/wyyfzb/mc-commander/commit/9cf9d907075455fc3a16142dfdaf743cc3945bc1))
* **web:** 接通磁盘告警——阈值随契约下发，两档按档位跃迁 ([1f3b893](https://github.com/wyyfzb/mc-commander/commit/1f3b8933a92163c381f9993c7a3230ed0c1b6332))


### Bug Fixes

* **server:** jar 下载完整性校验字段错位，部署与升级两条路径恒零校验 ([0259f7d](https://github.com/wyyfzb/mc-commander/commit/0259f7d6477607363813a49a9fb68d1e21c6a5f2))
* **server:** jar 下载完整性校验字段错位，部署与升级两条路径恒零校验 ([0e57986](https://github.com/wyyfzb/mc-commander/commit/0e57986d7bc2da8e9682c4461d841786b5427440))
* **server:** RCON 物品栏提取丢掉 SNBT 外层 [，致实时背包恒降级为存档快照 ([2c2d6d8](https://github.com/wyyfzb/mc-commander/commit/2c2d6d8346a9434a493b5ca4ad7bbf168ac44777))
* **server:** RCON 物品栏提取丢掉 SNBT 外层 `[`，致实时背包恒降级为存档快照 ([3ec2313](https://github.com/wyyfzb/mc-commander/commit/3ec2313e70ce63c73b59cf1322f4b704c7af4ab4))

## [0.3.0](https://github.com/wyyfzb/mc-commander/compare/v0.2.1...v0.3.0) (2026-09-28)


### Features

* **audit:** 实例部署接入操作审计——deploy 写操作补 INSTANCE_CREATE 记录 ([#373](https://github.com/wyyfzb/mc-commander/issues/373)) ([dad03d4](https://github.com/wyyfzb/mc-commander/commit/dad03d4090ae44bebb0ff4f4752d953e894810e5))
* **audit:** 实例配置更新接入操作审计——INSTANCE_UPDATE 枚举 + detail.fields 变更字段清单 ([#380](https://github.com/wyyfzb/mc-commander/issues/380)) ([6ffe490](https://github.com/wyyfzb/mc-commander/commit/6ffe490e3d781a0abe1ce7c80f97ca534426d34d))
* **audit:** 审计日志时间排序切换——支持正序追溯事件链 ([#383](https://github.com/wyyfzb/mc-commander/issues/383)) ([#386](https://github.com/wyyfzb/mc-commander/issues/386)) ([a451ec5](https://github.com/wyyfzb/mc-commander/commit/a451ec5a6321995b29361330e2371a98df628f52))
* **audit:** 封禁记录解封 + 白名单移除接入操作审计——补齐玩家写操作盲区 ([#377](https://github.com/wyyfzb/mc-commander/issues/377)) ([6691b1e](https://github.com/wyyfzb/mc-commander/commit/6691b1e726c2f7ad1a20cbe1b4d88540b3abc20b))
* **auth:** API Key 定位为 break-glass 机器凭据 + 部署能力探测端点 ([6ccc961](https://github.com/wyyfzb/mc-commander/commit/6ccc961419d1ff2e9f3c601a7fe4f2a51b80a862))
* **ci:** 引入 release-please 发版流程——Release PR 自动 bump 双包与 CHANGELOG ([#522](https://github.com/wyyfzb/mc-commander/issues/522)) ([ac9411a](https://github.com/wyyfzb/mc-commander/commit/ac9411af645d4c494da62d84878c49491f6db9cd))
* **ci:** 覆盖率门禁（70%）+ Windows 实验性标注 + WS 上限说明 ([#362](https://github.com/wyyfzb/mc-commander/issues/362)) ([6fa3c8f](https://github.com/wyyfzb/mc-commander/commit/6fa3c8f506a7bd7836e502d99368ffc16f360312))
* **files:** 文件列表虚拟化 + 移动，并收口路径口径 ([bcc39cd](https://github.com/wyyfzb/mc-commander/commit/bcc39cd97e03c9db18c7fc5c4a5403a102229f4d))
* **instances:** 长任务进度恢复与完成通知兜底——部署/升级状态断点续联 ([#354](https://github.com/wyyfzb/mc-commander/issues/354)) ([543754e](https://github.com/wyyfzb/mc-commander/commit/543754ee98739917b08e36d3b72ff9fdec303053))
* **market:** 市场安装链路接入 Modrinth sha512 完整性校验 ([#538](https://github.com/wyyfzb/mc-commander/issues/538)) ([9dbc277](https://github.com/wyyfzb/mc-commander/commit/9dbc277c417eb4a07808c89ea2cc5d6a7a272eca)), closes [#537](https://github.com/wyyfzb/mc-commander/issues/537)
* **notify:** Webhook 投递失败主动通知（功能闭环） ([#274](https://github.com/wyyfzb/mc-commander/issues/274)) ([2566f4e](https://github.com/wyyfzb/mc-commander/commit/2566f4e787f48da6a4088f9c3d25f2cf68c02d43))
* **scheduler+web:** append-only 表保留清理接线 + player-table 排序行序修复 ([#472](https://github.com/wyyfzb/mc-commander/issues/472)) ([#477](https://github.com/wyyfzb/mc-commander/issues/477)) ([8ea6a67](https://github.com/wyyfzb/mc-commander/commit/8ea6a6726cf2d0059973ff3851f1eb6d13b2b7b4))
* **scheduler:** command_history 表保留策略接线——append-only 洼地收口 ([#484](https://github.com/wyyfzb/mc-commander/issues/484)) ([fe0f0ad](https://github.com/wyyfzb/mc-commander/commit/fe0f0ad3a72b8a49393b7248aaa6d65a0421140e)), closes [#479](https://github.com/wyyfzb/mc-commander/issues/479)
* **server,ui:** /auth/setup 首访设密所有权证明——一次性 SETUP_TOKEN 全链路 ([#313](https://github.com/wyyfzb/mc-commander/issues/313)) ([79db8a8](https://github.com/wyyfzb/mc-commander/commit/79db8a815f8fc9844f8f94074a778222c862a218)), closes [#309](https://github.com/wyyfzb/mc-commander/issues/309)
* **server,ui:** 定时任务执行历史——task_run_history 表 + 查询接口 + 对话框时间线 ([#301](https://github.com/wyyfzb/mc-commander/issues/301)) ([a6ded43](https://github.com/wyyfzb/mc-commander/commit/a6ded4392f925ea368765110c2afd5441e818828))
* **server,web,security:** 服务端签发 API Key + STRIDE 一页纸 + 401 定向文案（②组 [#32](https://github.com/wyyfzb/mc-commander/issues/32)/[#19](https://github.com/wyyfzb/mc-commander/issues/19)） ([afe9156](https://github.com/wyyfzb/mc-commander/commit/afe91566514af571594f4e0397e92c23e618edb7))
* **server,web:** H2-4b WS 首帧鉴权替代 subprotocol（兼容双通道） ([d795f07](https://github.com/wyyfzb/mc-commander/commit/d795f078d8bac14c52ef2f66b81b2b3b24f08a0a))
* **server,web:** 升级可取消（复用可取消任务注册表 + 取消端点 + 回滚口径）（清单 [#94](https://github.com/wyyfzb/mc-commander/issues/94)） ([12d2f5c](https://github.com/wyyfzb/mc-commander/commit/12d2f5ced6b4a44bdc4158cff72bf453b967afc8))
* **server,web:** 只读角色 Phase 2——WS 事件级过滤（清单 [#21](https://github.com/wyyfzb/mc-commander/issues/21)） ([5f65f51](https://github.com/wyyfzb/mc-commander/commit/5f65f517442a527873d4864c5ef35a036684e23d))
* **server,web:** 备份/恢复可取消 + rsync 字节进度（清单 [#16](https://github.com/wyyfzb/mc-commander/issues/16)） ([53a1642](https://github.com/wyyfzb/mc-commander/commit/53a16428a0f50fbc96d28b64241e67ab01b22c46))
* **server,web:** 失败事件纳入关键事件无订阅全局播报（备份/任务/Webhook 投递失败） ([c5e5bc9](https://github.com/wyyfzb/mc-commander/commit/c5e5bc94104512f651f373a3b48590d86e55f751))
* **server,web:** 归档快照可见与挂载（跨实例恢复）（清单 [#27](https://github.com/wyyfzb/mc-commander/issues/27)） ([2b6ec5f](https://github.com/wyyfzb/mc-commander/commit/2b6ec5f60a25ff003586e9b28d8bb8f9c9a9d0d0))
* **server,web:** 部署可取消——可取消任务注册表 + 取消端点 + 前端取消入口（清单 [#18](https://github.com/wyyfzb/mc-commander/issues/18)） ([d54c880](https://github.com/wyyfzb/mc-commander/commit/d54c880d1d55c3ac96bcd215f777981e62d8f551))
* **server:** H2-2 面板备份纳入 .env 伴生副本 ([9b04d7d](https://github.com/wyyfzb/mc-commander/commit/9b04d7dc6145f7468937ee33943029d56726aa6c))
* **server:** H2-4a WS 认证失败 IP 临时封禁 + 401 补日志 ([89a077f](https://github.com/wyyfzb/mc-commander/commit/89a077f674966d3786aa1d8f2a8882fcfa5d8398))
* **server:** H2-5 cron 停机错过补偿（catch-up） ([5349c44](https://github.com/wyyfzb/mc-commander/commit/5349c449ad68683911fbfed0df8879d9f4de69e1))
* **server:** JAR 下载落地校验——流式体积上限 512MB + 上游 sha 摘要强校验（S-P1-1） ([#326](https://github.com/wyyfzb/mc-commander/issues/326)) ([4abf5ce](https://github.com/wyyfzb/mc-commander/commit/4abf5cedf884c7e9aade826e3042f884656a05d9)), closes [#316](https://github.com/wyyfzb/mc-commander/issues/316)
* **server:** macOS 备份 openrsync 兼容探测与三级降级 + README 表述下调 ([4fdfc88](https://github.com/wyyfzb/mc-commander/commit/4fdfc88ce91f50c069d8c886e3b2b1f8c3690472))
* **server:** TOTP 双因素（Phase 1+2）与 API Key 通道开关 ([8abee49](https://github.com/wyyfzb/mc-commander/commit/8abee49d47420d5615717e2783444c130bdc12ae))
* **server:** 卸载实例保留备份 + 服务端强制实例名确认（阶段② D2） ([8d9c9df](https://github.com/wyyfzb/mc-commander/commit/8d9c9df2ff2d8217434ce459524c2e3bd15f4088))
* **server:** 只读机器凭据与 fail-closed 角色门（阶段② D3-c Phase 1） ([770e20e](https://github.com/wyyfzb/mc-commander/commit/770e20e3c2e392c6a6e36f229c0c5bbe2ea69b61))
* **server:** 实例启动时 tempban 对账同步 ([#221](https://github.com/wyyfzb/mc-commander/issues/221)) ([7aae61f](https://github.com/wyyfzb/mc-commander/commit/7aae61f10197a58d6966d04d9f606b8ecb1bb872))
* **server:** 接管实例日志续读 latest.log ([7c6e72b](https://github.com/wyyfzb/mc-commander/commit/7c6e72b71b50f55e3b31bef83a44983aaee1bcc0))
* **server:** 服务端指标链路——通知落库批量队列 + 无订阅停采 + /api/v1/metrics 端点 ([82dde6d](https://github.com/wyyfzb/mc-commander/commit/82dde6d0114c18377fdc7d698054730d4aa6f8b5))
* **server:** 轻量结构化日志系统——console 包装器四级日志 + error 分流 + 简单轮转 ([#325](https://github.com/wyyfzb/mc-commander/issues/325)) ([#332](https://github.com/wyyfzb/mc-commander/issues/332)) ([dcdc167](https://github.com/wyyfzb/mc-commander/commit/dcdc1672b2455bc4c3ee4f6fd2f40ed19886986a))
* **server:** 进程级异常兜底——uncaughtException/unhandledRejection 收口纵深防线 ([#458](https://github.com/wyyfzb/mc-commander/issues/458)) ([210b093](https://github.com/wyyfzb/mc-commander/commit/210b0936c184c9270aebf2bbf9af7957356ecbb9))
* **server:** 部署进度兜底端点与重复部署门控 ([eefec90](https://github.com/wyyfzb/mc-commander/commit/eefec90620edd46c7f92179674e6bcbc37220901))
* **server:** 面板停机不停实例 ([eb12fdb](https://github.com/wyyfzb/mc-commander/commit/eb12fdbef5970fd56c79690cfd28042b15b3167b))
* **server:** 面板自身数据纳入备份——SQLite 每日在线快照 + .env 处置留档 ([#292](https://github.com/wyyfzb/mc-commander/issues/292)) ([827d313](https://github.com/wyyfzb/mc-commander/commit/827d313be3d464ea56dcd6ad2c71f81085b436ad))
* **web,server,schemas:** 设置页只读监控凭据管理（②组 [#23](https://github.com/wyyfzb/mc-commander/issues/23)） ([035e8b6](https://github.com/wyyfzb/mc-commander/commit/035e8b6ae28137d3ff837e8b1feb4f9687b96693))
* **webhook:** 测试投递落历史记录 + 测试后投递面板即时刷新 ([#361](https://github.com/wyyfzb/mc-commander/issues/361)) ([64f758a](https://github.com/wyyfzb/mc-commander/commit/64f758a79f07e4815d6680ba2fab8dd25d360224))
* **ws:** 全局指标 WS 推送替代 5s 轮询 ([#254](https://github.com/wyyfzb/mc-commander/issues/254)) ([#255](https://github.com/wyyfzb/mc-commander/issues/255)) ([73657a1](https://github.com/wyyfzb/mc-commander/commit/73657a10908138acddfaf711dc2af1e4d72f72f6))


### Bug Fixes

* **api-key:** API Key 哈希存储替代明文存储 ([#236](https://github.com/wyyfzb/mc-commander/issues/236)) ([13ccd02](https://github.com/wyyfzb/mc-commander/commit/13ccd0243ad04b1a86a68c4f1da454bb508ddaa4))
* **auth:** loginFailures 加 LRU 容量上限防内存无界增长 ([#235](https://github.com/wyyfzb/mc-commander/issues/235)) ([2880d04](https://github.com/wyyfzb/mc-commander/commit/2880d04bd4e663cbf5ca5d20d45f9d1752bbb7bb)), closes [#230](https://github.com/wyyfzb/mc-commander/issues/230)
* **ci:** release tag 与双包 version 一致性校验——版本链对齐 1.1.0 ([#474](https://github.com/wyyfzb/mc-commander/issues/474)) ([9017624](https://github.com/wyyfzb/mc-commander/commit/90176240b7ff3b02629ab6ec6e17d09f448ade2d))
* **ci:** release 组装树隔离与回写链路收窄，dispatch 兜底断链补跑 ([6ed6ed8](https://github.com/wyyfzb/mc-commander/commit/6ed6ed89c3616bd705cdb26bf3de97a42414e60d))
* **config:** 数值环境变量统一收口——非法值启动 fail-fast 拒绝启动 ([#536](https://github.com/wyyfzb/mc-commander/issues/536)) ([09fb554](https://github.com/wyyfzb/mc-commander/commit/09fb55412f04948420f9649f20359645080b24e8)), closes [#535](https://github.com/wyyfzb/mc-commander/issues/535)
* **deps:** 双端生产依赖漏洞清零——上线安全闸收口 ([#456](https://github.com/wyyfzb/mc-commander/issues/456)) ([fb50bed](https://github.com/wyyfzb/mc-commander/commit/fb50beddde9fcac4afddb746e95e9fece3b6c387))
* **server,web:** existsSync 的 TOCTOU 收敛 + 只读裁剪清单哨兵 + 恢复码告警阈值（②组 [#20](https://github.com/wyyfzb/mc-commander/issues/20)/[#24](https://github.com/wyyfzb/mc-commander/issues/24)/[#31](https://github.com/wyyfzb/mc-commander/issues/31)） ([19acdad](https://github.com/wyyfzb/mc-commander/commit/19acdad27fb87eef08aeb1ae499b7fb19cbee017))
* **server,web:** 备份恢复与实例卸载的服务端强制确认（②组 [#25](https://github.com/wyyfzb/mc-commander/issues/25)/[#26](https://github.com/wyyfzb/mc-commander/issues/26)/[#28](https://github.com/wyyfzb/mc-commander/issues/28)/[#29](https://github.com/wyyfzb/mc-commander/issues/29)） ([8ec05e0](https://github.com/wyyfzb/mc-commander/commit/8ec05e06775c1cb7b2f2b1c87f9a37ed09b99813))
* **server,web:** 收口交叉复核 P2——会话时间解析、下发口径、回归防线与超时 ([66ce452](https://github.com/wyyfzb/mc-commander/commit/66ce45202de4a98be1efcee055c2f74555bc9934))
* **server,web:** 系统统计推送接线 + 实例状态字段口径（清单 [#98](https://github.com/wyyfzb/mc-commander/issues/98) [#99](https://github.com/wyyfzb/mc-commander/issues/99) + 升级守卫） ([3234cbd](https://github.com/wyyfzb/mc-commander/commit/3234cbd35209db1eb6d0aa72011743ff98fe3b92))
* **server:** [#397](https://github.com/wyyfzb/mc-commander/issues/397) 回归修复——上传 400 路径临时文件清理（validateQuery onError 钩子） ([#401](https://github.com/wyyfzb/mc-commander/issues/401)) ([15e3500](https://github.com/wyyfzb/mc-commander/commit/15e3500ccae77b9ee88e4d65d2cd2cdb0953bda6))
* **server:** atomicWriteFile 对 Windows 瞬时共享冲突做有界重试 ([58cf501](https://github.com/wyyfzb/mc-commander/commit/58cf5019a3fed8436d11ce9dbf003bdd33125c18))
* **server:** MC 版本改以服务端 JAR 内 version.json 为权威 ([e178fe2](https://github.com/wyyfzb/mc-commander/commit/e178fe2809d47703632672ef0b58b1eef5b8c95c))
* **server:** P2 安全小批打包——scrypt 加固 + safeEqual 归一化 + body 收口 + /health 精简 + Key 掩码 + 会话生命周期（P2-5~11） ([#331](https://github.com/wyyfzb/mc-commander/issues/331)) ([5589d78](https://github.com/wyyfzb/mc-commander/commit/5589d7852dafb68f95210d3f1d07f949346800c4)), closes [#324](https://github.com/wyyfzb/mc-commander/issues/324)
* **server:** properties/world 路由 readDifficulty 意外异常兜底 ([#297](https://github.com/wyyfzb/mc-commander/issues/297)) ([5db9132](https://github.com/wyyfzb/mc-commander/commit/5db9132ac19192c9f3b424e38eb84e46d615acfe))
* **server:** RCON_UNAVAILABLE 专用错误码 + world gameDays null 降级 ([#238](https://github.com/wyyfzb/mc-commander/issues/238)) Closes [#238](https://github.com/wyyfzb/mc-commander/issues/238) ([#245](https://github.com/wyyfzb/mc-commander/issues/245)) ([b7c379f](https://github.com/wyyfzb/mc-commander/commit/b7c379f0e3a2e64cef074cdb7b862e7d69f5efe3))
* **server:** toIsoUtc 一并按时刻处理 Date 入参 ([b1113ce](https://github.com/wyyfzb/mc-commander/commit/b1113ce477fa42042c1504d87376ef5a3d55a7c6))
* **server:** toIsoUtc 的数值入参按 epoch 毫秒处理，不再原样透传 ([6b53648](https://github.com/wyyfzb/mc-commander/commit/6b536485714545dff1eeba96df817085b6ad1710))
* **server:** toIsoUtc 越界有限数值一并返回 null ([baf05f6](https://github.com/wyyfzb/mc-commander/commit/baf05f6970472a8b30b0997b20d7e3aeb76dc320))
* **server:** upgrade.service.js 升级成功旧 jar 残留清理 + 备份/回滚复制异步化 ([#525](https://github.com/wyyfzb/mc-commander/issues/525)) ([3f3c1cb](https://github.com/wyyfzb/mc-commander/commit/3f3c1cbe772e5431af8abf0dfba6aee1ea0f5f4a))
* **server:** webhook SSRF 私网黑名单 + helmet 最小安全响应头 ([#217](https://github.com/wyyfzb/mc-commander/issues/217)) ([851fc13](https://github.com/wyyfzb/mc-commander/commit/851fc13971b28481d3dcc6cb514c2c45145786dc)), closes [#215](https://github.com/wyyfzb/mc-commander/issues/215)
* **server:** webhook 背压跳过事件落投递记录——丢弃事件可观测 ([#528](https://github.com/wyyfzb/mc-commander/issues/528)) ([7f2c88d](https://github.com/wyyfzb/mc-commander/commit/7f2c88db6fddf02240977638f3a5c325fe0037dd))
* **server:** Windows 实例内存/CPU 采集改用 PowerShell（wmic 已随 Win11 24H2 移除） ([35edea0](https://github.com/wyyfzb/mc-commander/commit/35edea0ff23729ed42b19a702d4a9ac2514b4dde))
* **server:** 保留清理 cutoff 与 naive 列同口径，并根除测试临时目录竞态 ([d3b62cc](https://github.com/wyyfzb/mc-commander/commit/d3b62ccd570ad79ea307e4e2237aebdb013a4de9))
* **server:** 修复 mcVersion 版本传播断链，运行时恒返回 unknown ([#234](https://github.com/wyyfzb/mc-commander/issues/234)) ([472a69f](https://github.com/wyyfzb/mc-commander/commit/472a69fea497934acf1c4c228f0ad0e1d7880295)), closes [#227](https://github.com/wyyfzb/mc-commander/issues/227)
* **server:** 修复 Paper 服务端下载链路整条断裂 ([e4554d8](https://github.com/wyyfzb/mc-commander/commit/e4554d8a03afd3ba27f56985a0f926158ad990ea))
* **server:** 修正 SQLite UTC 时间被按本地时区解析的偏移 ([7018a8b](https://github.com/wyyfzb/mc-commander/commit/7018a8b3109e427fa093de78283d266061a947e3))
* **server:** 升级接口 mcVersion 白名单 + JAR 路径收口（S-P0-2 安全加固） ([#314](https://github.com/wyyfzb/mc-commander/issues/314)) ([bff1b53](https://github.com/wyyfzb/mc-commander/commit/bff1b539ac3898c47a9d9bde80464e41a4cce91b))
* **server:** 备份默认命名改用服务器本地日期，与列表展示同口径 ([04bb87a](https://github.com/wyyfzb/mc-commander/commit/04bb87a1692f4832b5aa11c65ce6b2482c37d8c3))
* **server:** 收口 J47 复审建议——新运行复位采集告警位、解析失败留 debug ([58e7b28](https://github.com/wyyfzb/mc-commander/commit/58e7b2845415b7610d18bcbb859999474bbcb733))
* **server:** 收口 Windows 采集审查应修项——恢复 emit 错误隔离与告警 ([2342da5](https://github.com/wyyfzb/mc-commander/commit/2342da5deeef97004f72f91d68ee3164f4567840))
* **server:** 改密不再静默清空 totp_secret 与重置 created_at ([21408de](https://github.com/wyyfzb/mc-commander/commit/21408dee639e6c43cbcaea4c2cd0ab53302ea214))
* **server:** 清理部署路由手写 type 校验死代码 ([#286](https://github.com/wyyfzb/mc-commander/issues/286)) ([1c4e21d](https://github.com/wyyfzb/mc-commander/commit/1c4e21d9c3af7e87cd8c4d3c9bc59b77afe3466b))
* **server:** 移除首帧鉴权测试的死导入，恢复服务端 lint ([35301e9](https://github.com/wyyfzb/mc-commander/commit/35301e93b1c47b0db116394595c4303c07869797))
* **server:** 网络暴露收口——rcon.port 派生 + HOST 可配 + 弱 Key 生产阻断（S-P0-5） ([#319](https://github.com/wyyfzb/mc-commander/issues/319)) ([9e1e14b](https://github.com/wyyfzb/mc-commander/commit/9e1e14bf812a9654dd6031e971f004c775964545)), closes [#315](https://github.com/wyyfzb/mc-commander/issues/315)
* **server:** 认证通道收口——锁定键对齐 + trust proxy 可配 + WS 会话复验（S-P0-3 残留） ([#323](https://github.com/wyyfzb/mc-commander/issues/323)) ([bfc8282](https://github.com/wyyfzb/mc-commander/commit/bfc8282829cb6488067e1f8e7a63852401e7d7f1)), closes [#320](https://github.com/wyyfzb/mc-commander/issues/320)
* **server:** 部署死快照判据收敛为单一出口 ([c168db4](https://github.com/wyyfzb/mc-commander/commit/c168db4dff6094a9cff0826c2c56c7f3d74b8daa))
* **server:** 部署终态事件不再写回 activeDeploys 注册表——WS 补发过滤失效修复 ([#422](https://github.com/wyyfzb/mc-commander/issues/422)) ([6a9c087](https://github.com/wyyfzb/mc-commander/commit/6a9c0873cf4f57ddd223dce127dfb8930825bee2)), closes [#420](https://github.com/wyyfzb/mc-commander/issues/420)
* **server:** 面板重启后接管孤儿实例进程——pid 文件+验活+看门狗（UXT-15 根修） ([1af5257](https://github.com/wyyfzb/mc-commander/commit/1af525727074a4f30209bf2c4cf08cc17843d678))
* **status:** 实例卸载增加备份进行中互斥检查，防恢复竞争致数据事故 ([#533](https://github.com/wyyfzb/mc-commander/issues/533)) ([067b1b1](https://github.com/wyyfzb/mc-commander/commit/067b1b1c96f7e2747232b1057bad82afd7a3f8df)), closes [#530](https://github.com/wyyfzb/mc-commander/issues/530)
* **upgrade:** 升级回滚路径 jarFile 名实一致化（DB 回写+错位副本清理+内存同步） ([#540](https://github.com/wyyfzb/mc-commander/issues/540)) ([1722778](https://github.com/wyyfzb/mc-commander/commit/1722778e1952d933a4a526418266c364b433ca4e)), closes [#539](https://github.com/wyyfzb/mc-commander/issues/539)
* **web,server:** 修复设计审查 P1 四项 ([8f8a2ed](https://github.com/wyyfzb/mc-commander/commit/8f8a2ed50ea3487ff90da623c40a1750d8ab90fc))
* **web,server:** 契约与出参一致性一次对齐（四处漂移 + 告警聚合 + 分页收口） ([4d8b0fe](https://github.com/wyyfzb/mc-commander/commit/4d8b0fe1e95ccb0a742d63f57365084546d2264b))
* **web,server:** 门控注释订正 + 兜底真值新鲜期 + 死快照判龄硬化 + R19 视口断言 ([8f79ebe](https://github.com/wyyfzb/mc-commander/commit/8f79ebed92ca6b09006573a57b11d96a94be0d0a))
* **web,server:** 降级档文案据实 + 42900 限流独立文案 + 测试夹具目录按年龄回收（清单 [#88](https://github.com/wyyfzb/mc-commander/issues/88)/[#84](https://github.com/wyyfzb/mc-commander/issues/84)/[#91](https://github.com/wyyfzb/mc-commander/issues/91)） ([9fe0940](https://github.com/wyyfzb/mc-commander/commit/9fe0940a8b23dd2c12f6f5c512ff9771ca6ea6a0))
* **web+server:** 终端停止标记改 DOM 状态条 + latest.log 回填当次运行日志（UXT-24） ([af7244d](https://github.com/wyyfzb/mc-commander/commit/af7244d1d338e9ad6bf2932c5760fba676c33fdb))
* **web:** 375 计数折行、反馈级别口径与 CPU 告警口径 ([2975c8d](https://github.com/wyyfzb/mc-commander/commit/2975c8d43a69a78606372892e9223acf34554d97))
* **web:** 详情面板承载门槛改回 lg，修复 768–1023px 表格被压坏 ([0d77222](https://github.com/wyyfzb/mc-commander/commit/0d77222e489726b5524868de226121ddc33312ca))
* **ws,web:** crash/熔断跨实例投递 + 通知跨标签收敛 + 游标字段名对齐契约（清单 [#16](https://github.com/wyyfzb/mc-commander/issues/16)/[#17](https://github.com/wyyfzb/mc-commander/issues/17)） ([daace0c](https://github.com/wyyfzb/mc-commander/commit/daace0c30b7975e99d5bd5bd0984387022fbd9c2))
* 掩码 MSMP 凭据型属性，堵住 server.properties 明文回显 ([4e6b07f](https://github.com/wyyfzb/mc-commander/commit/4e6b07f6ba79141cd75cc3b6349c2fb6646e6b56))
* 本地测试基线全绿 + local-check.sh 接入设计 token 守门 ([#378](https://github.com/wyyfzb/mc-commander/issues/378)) ([7532282](https://github.com/wyyfzb/mc-commander/commit/7532282b9f8e50a621e14b41d0701ef4ca91c46e))
* 重建 9/7–9/8 实测修复批次——.git 对象损毁后的合并重建提交 ([a8f62a9](https://github.com/wyyfzb/mc-commander/commit/a8f62a98d04b5cff0aabce184df41f004e0d3834))

## [1.2.1](https://github.com/wyyfzb/mc-commander/compare/v1.2.0...v1.2.1) (2026-09-05)


### Bug Fixes

* **server:** upgrade.service.js 升级成功旧 jar 残留清理 + 备份/回滚复制异步化 ([#525](https://github.com/wyyfzb/mc-commander/issues/525)) ([3f3c1cb](https://github.com/wyyfzb/mc-commander/commit/3f3c1cbe772e5431af8abf0dfba6aee1ea0f5f4a))
* **server:** webhook 背压跳过事件落投递记录——丢弃事件可观测 ([#528](https://github.com/wyyfzb/mc-commander/issues/528)) ([7f2c88d](https://github.com/wyyfzb/mc-commander/commit/7f2c88db6fddf02240977638f3a5c325fe0037dd))

## [1.2.0](https://github.com/wyyfzb/mc-commander/compare/v1.1.0...v1.2.0) (2026-09-05)


### Features

* **audit:** 实例部署接入操作审计——deploy 写操作补 INSTANCE_CREATE 记录 ([#373](https://github.com/wyyfzb/mc-commander/issues/373)) ([dad03d4](https://github.com/wyyfzb/mc-commander/commit/dad03d4090ae44bebb0ff4f4752d953e894810e5))
* **audit:** 实例配置更新接入操作审计——INSTANCE_UPDATE 枚举 + detail.fields 变更字段清单 ([#380](https://github.com/wyyfzb/mc-commander/issues/380)) ([6ffe490](https://github.com/wyyfzb/mc-commander/commit/6ffe490e3d781a0abe1ce7c80f97ca534426d34d))
* **audit:** 审计日志时间排序切换——支持正序追溯事件链 ([#383](https://github.com/wyyfzb/mc-commander/issues/383)) ([#386](https://github.com/wyyfzb/mc-commander/issues/386)) ([a451ec5](https://github.com/wyyfzb/mc-commander/commit/a451ec5a6321995b29361330e2371a98df628f52))
* **audit:** 封禁记录解封 + 白名单移除接入操作审计——补齐玩家写操作盲区 ([#377](https://github.com/wyyfzb/mc-commander/issues/377)) ([6691b1e](https://github.com/wyyfzb/mc-commander/commit/6691b1e726c2f7ad1a20cbe1b4d88540b3abc20b))
* **ci:** 引入 release-please 发版流程——Release PR 自动 bump 双包与 CHANGELOG ([#522](https://github.com/wyyfzb/mc-commander/issues/522)) ([ac9411a](https://github.com/wyyfzb/mc-commander/commit/ac9411af645d4c494da62d84878c49491f6db9cd))
* **ci:** 覆盖率门禁（70%）+ Windows 实验性标注 + WS 上限说明 ([#362](https://github.com/wyyfzb/mc-commander/issues/362)) ([6fa3c8f](https://github.com/wyyfzb/mc-commander/commit/6fa3c8f506a7bd7836e502d99368ffc16f360312))
* feat-4 Webhook 外部通知全链路（roadmap 工程基建第 3 项灾后重实现） ([#42](https://github.com/wyyfzb/mc-commander/issues/42)) ([76fb84e](https://github.com/wyyfzb/mc-commander/commit/76fb84e4f6e0002301f058f270888d3f9b876170))
* **instances:** 长任务进度恢复与完成通知兜底——部署/升级状态断点续联 ([#354](https://github.com/wyyfzb/mc-commander/issues/354)) ([543754e](https://github.com/wyyfzb/mc-commander/commit/543754ee98739917b08e36d3b72ff9fdec303053))
* Modrinth 插件市场服务端——代理搜索/版本列表/一键安装（缓存+CDN白名单+zip校验+审计） ([#61](https://github.com/wyyfzb/mc-commander/issues/61)) ([552414b](https://github.com/wyyfzb/mc-commander/commit/552414b3b678d4ad60019037aceec3f2d5217ffc))
* **notify:** Webhook 投递失败主动通知（功能闭环） ([#274](https://github.com/wyyfzb/mc-commander/issues/274)) ([2566f4e](https://github.com/wyyfzb/mc-commander/commit/2566f4e787f48da6a4088f9c3d25f2cf68c02d43))
* **scheduler+web:** append-only 表保留清理接线 + player-table 排序行序修复 ([#472](https://github.com/wyyfzb/mc-commander/issues/472)) ([#477](https://github.com/wyyfzb/mc-commander/issues/477)) ([8ea6a67](https://github.com/wyyfzb/mc-commander/commit/8ea6a6726cf2d0059973ff3851f1eb6d13b2b7b4))
* **scheduler:** command_history 表保留策略接线——append-only 洼地收口 ([#484](https://github.com/wyyfzb/mc-commander/issues/484)) ([fe0f0ad](https://github.com/wyyfzb/mc-commander/commit/fe0f0ad3a72b8a49393b7248aaa6d65a0421140e)), closes [#479](https://github.com/wyyfzb/mc-commander/issues/479)
* **server,ui:** /auth/setup 首访设密所有权证明——一次性 SETUP_TOKEN 全链路 ([#313](https://github.com/wyyfzb/mc-commander/issues/313)) ([79db8a8](https://github.com/wyyfzb/mc-commander/commit/79db8a815f8fc9844f8f94074a778222c862a218)), closes [#309](https://github.com/wyyfzb/mc-commander/issues/309)
* **server,ui:** 定时任务执行历史——task_run_history 表 + 查询接口 + 对话框时间线 ([#301](https://github.com/wyyfzb/mc-commander/issues/301)) ([a6ded43](https://github.com/wyyfzb/mc-commander/commit/a6ded4392f925ea368765110c2afd5441e818828))
* **server:** JAR 下载落地校验——流式体积上限 512MB + 上游 sha 摘要强校验（S-P1-1） ([#326](https://github.com/wyyfzb/mc-commander/issues/326)) ([4abf5ce](https://github.com/wyyfzb/mc-commander/commit/4abf5cedf884c7e9aade826e3042f884656a05d9)), closes [#316](https://github.com/wyyfzb/mc-commander/issues/316)
* **server:** 定时任务失败通知闭环——taskFailed 事件落库广播 + 前端通知展示 ([#76](https://github.com/wyyfzb/mc-commander/issues/76)) ([d87b0bc](https://github.com/wyyfzb/mc-commander/commit/d87b0bc35d3188dc3c3c64bde572e066bccbadc9)), closes [#75](https://github.com/wyyfzb/mc-commander/issues/75)
* **server:** 实例启动时 tempban 对账同步 ([#221](https://github.com/wyyfzb/mc-commander/issues/221)) ([7aae61f](https://github.com/wyyfzb/mc-commander/commit/7aae61f10197a58d6966d04d9f606b8ecb1bb872))
* **server:** 轻量结构化日志系统——console 包装器四级日志 + error 分流 + 简单轮转 ([#325](https://github.com/wyyfzb/mc-commander/issues/325)) ([#332](https://github.com/wyyfzb/mc-commander/issues/332)) ([dcdc167](https://github.com/wyyfzb/mc-commander/commit/dcdc1672b2455bc4c3ee4f6fd2f40ed19886986a))
* **server:** 进程级异常兜底——uncaughtException/unhandledRejection 收口纵深防线 ([#458](https://github.com/wyyfzb/mc-commander/issues/458)) ([210b093](https://github.com/wyyfzb/mc-commander/commit/210b0936c184c9270aebf2bbf9af7957356ecbb9))
* **server:** 面板自身数据纳入备份——SQLite 每日在线快照 + .env 处置留档 ([#292](https://github.com/wyyfzb/mc-commander/issues/292)) ([827d313](https://github.com/wyyfzb/mc-commander/commit/827d313be3d464ea56dcd6ad2c71f81085b436ad))
* **tasks:** 定时任务失败时展示错误原因 ([#198](https://github.com/wyyfzb/mc-commander/issues/198)) ([1e3b499](https://github.com/wyyfzb/mc-commander/commit/1e3b4995fac91386248372781b50517400159d19)), closes [#197](https://github.com/wyyfzb/mc-commander/issues/197)
* **webhook:** 测试投递落历史记录 + 测试后投递面板即时刷新 ([#361](https://github.com/wyyfzb/mc-commander/issues/361)) ([64f758a](https://github.com/wyyfzb/mc-commander/commit/64f758a79f07e4815d6680ba2fab8dd25d360224))
* WS 握手支持管理员会话令牌（双通道鉴权对齐 HTTP Bearer） ([#55](https://github.com/wyyfzb/mc-commander/issues/55)) ([b7b479b](https://github.com/wyyfzb/mc-commander/commit/b7b479b909bd809e381784a8d46f5bf0c65c831e))
* **ws:** 全局指标 WS 推送替代 5s 轮询 ([#254](https://github.com/wyyfzb/mc-commander/issues/254)) ([#255](https://github.com/wyyfzb/mc-commander/issues/255)) ([73657a1](https://github.com/wyyfzb/mc-commander/commit/73657a10908138acddfaf711dc2af1e4d72f72f6))
* 插件上传接口（multipart + zip 魔数校验 + 显式覆盖）与元数据扩展 ([#58](https://github.com/wyyfzb/mc-commander/issues/58)) ([fa4db58](https://github.com/wyyfzb/mc-commander/commit/fa4db5870eeb12d3e9a0bfbe05e883673d971789))
* 插件更新检测（已装插件 vs Modrinth 最新版） ([#67](https://github.com/wyyfzb/mc-commander/issues/67)) ([bde85f3](https://github.com/wyyfzb/mc-commander/commit/bde85f3aceb291356e1f291ae0aedd917569ce42))
* 文件下载端点 + 文件操作审计 + 二进制编辑保护 ([#66](https://github.com/wyyfzb/mc-commander/issues/66)) ([9771af4](https://github.com/wyyfzb/mc-commander/commit/9771af40e29e1584ce4a69ea9146032fab8a3c68))
* 灾后重实现 R2-R4 汇总（feat-1 备份下载 + feat-2 审计/命令历史 + feat-3 文件管理服务端） ([4c8f660](https://github.com/wyyfzb/mc-commander/commit/4c8f6606b43fcaf61c6054119e0af2e5e8d0f2c6))
* 灾后重实现汇总 R2-R4（feat-1 备份下载 + feat-2 审计 + feat-3 文件管理服务端） ([3e9c245](https://github.com/wyyfzb/mc-commander/commit/3e9c24532cb1050829b082b6cec4a6bedbb8a0e3))
* 管理员密码登录安全主线——服务端（设密/登录/会话/踢单设备） ([#54](https://github.com/wyyfzb/mc-commander/issues/54)) ([f6f1506](https://github.com/wyyfzb/mc-commander/commit/f6f150611a95cd59c8f8d9296c52aa8774e4988c))


### Bug Fixes

* **api-key:** API Key 哈希存储替代明文存储 ([#236](https://github.com/wyyfzb/mc-commander/issues/236)) ([13ccd02](https://github.com/wyyfzb/mc-commander/commit/13ccd0243ad04b1a86a68c4f1da454bb508ddaa4))
* **auth:** loginFailures 加 LRU 容量上限防内存无界增长 ([#235](https://github.com/wyyfzb/mc-commander/issues/235)) ([2880d04](https://github.com/wyyfzb/mc-commander/commit/2880d04bd4e663cbf5ca5d20d45f9d1752bbb7bb)), closes [#230](https://github.com/wyyfzb/mc-commander/issues/230)
* **ci:** release tag 与双包 version 一致性校验——版本链对齐 1.1.0 ([#474](https://github.com/wyyfzb/mc-commander/issues/474)) ([9017624](https://github.com/wyyfzb/mc-commander/commit/90176240b7ff3b02629ab6ec6e17d09f448ade2d))
* **ci:** 首轮 CI 失败修复——lint 欠账 + 版本/协议 UI 同步 ([9a704fa](https://github.com/wyyfzb/mc-commander/commit/9a704fa6268bbc68b0a8d853e44cf1ef814bd4c6))
* **deps:** 双端生产依赖漏洞清零——上线安全闸收口 ([#456](https://github.com/wyyfzb/mc-commander/issues/456)) ([fb50bed](https://github.com/wyyfzb/mc-commander/commit/fb50beddde9fcac4afddb746e95e9fece3b6c387))
* **files:** 上传文件目标改为当前浏览目录 ([#199](https://github.com/wyyfzb/mc-commander/issues/199)) ([52ad5be](https://github.com/wyyfzb/mc-commander/commit/52ad5be24c3b055b967c948680bb76a58daf6669))
* **server,web:** 错误码契约测试 + 40003 碰撞消除 + 僵尸码清理 + 前端对齐 ([#178](https://github.com/wyyfzb/mc-commander/issues/178)) ([c5914c2](https://github.com/wyyfzb/mc-commander/commit/c5914c27084bb3f18372b8749b05914374d3026c))
* **server:** [#397](https://github.com/wyyfzb/mc-commander/issues/397) 回归修复——上传 400 路径临时文件清理（validateQuery onError 钩子） ([#401](https://github.com/wyyfzb/mc-commander/issues/401)) ([15e3500](https://github.com/wyyfzb/mc-commander/commit/15e3500ccae77b9ee88e4d65d2cd2cdb0953bda6))
* **server:** P2 安全小批打包——scrypt 加固 + safeEqual 归一化 + body 收口 + /health 精简 + Key 掩码 + 会话生命周期（P2-5~11） ([#331](https://github.com/wyyfzb/mc-commander/issues/331)) ([5589d78](https://github.com/wyyfzb/mc-commander/commit/5589d7852dafb68f95210d3f1d07f949346800c4)), closes [#324](https://github.com/wyyfzb/mc-commander/issues/324)
* **server:** properties/world 路由 readDifficulty 意外异常兜底 ([#297](https://github.com/wyyfzb/mc-commander/issues/297)) ([5db9132](https://github.com/wyyfzb/mc-commander/commit/5db9132ac19192c9f3b424e38eb84e46d615acfe))
* **server:** RCON_UNAVAILABLE 专用错误码 + world gameDays null 降级 ([#238](https://github.com/wyyfzb/mc-commander/issues/238)) Closes [#238](https://github.com/wyyfzb/mc-commander/issues/238) ([#245](https://github.com/wyyfzb/mc-commander/issues/245)) ([b7c379f](https://github.com/wyyfzb/mc-commander/commit/b7c379f0e3a2e64cef074cdb7b862e7d69f5efe3))
* **server:** webhook SSRF 私网黑名单 + helmet 最小安全响应头 ([#217](https://github.com/wyyfzb/mc-commander/issues/217)) ([851fc13](https://github.com/wyyfzb/mc-commander/commit/851fc13971b28481d3dcc6cb514c2c45145786dc)), closes [#215](https://github.com/wyyfzb/mc-commander/issues/215)
* **server:** 优雅退出补全 wss.close 和 db.close ([#144](https://github.com/wyyfzb/mc-commander/issues/144)) ([4c64d1a](https://github.com/wyyfzb/mc-commander/commit/4c64d1a48381f87213c3555ac43655945f87ef68))
* **server:** 修复 mcVersion 版本传播断链，运行时恒返回 unknown ([#234](https://github.com/wyyfzb/mc-commander/issues/234)) ([472a69f](https://github.com/wyyfzb/mc-commander/commit/472a69fea497934acf1c4c228f0ad0e1d7880295)), closes [#227](https://github.com/wyyfzb/mc-commander/issues/227)
* **server:** 升级接口 mcVersion 白名单 + JAR 路径收口（S-P0-2 安全加固） ([#314](https://github.com/wyyfzb/mc-commander/issues/314)) ([bff1b53](https://github.com/wyyfzb/mc-commander/commit/bff1b539ac3898c47a9d9bde80464e41a4cce91b))
* **server:** 清理部署路由手写 type 校验死代码 ([#286](https://github.com/wyyfzb/mc-commander/issues/286)) ([1c4e21d](https://github.com/wyyfzb/mc-commander/commit/1c4e21d9c3af7e87cd8c4d3c9bc59b77afe3466b))
* **server:** 端口占用时友好报错替代裸崩溃 ([#140](https://github.com/wyyfzb/mc-commander/issues/140)) ([86d17fc](https://github.com/wyyfzb/mc-commander/commit/86d17fc58a5a6645e90f6757e71ec9dfc9a22da2))
* **server:** 网络暴露收口——rcon.port 派生 + HOST 可配 + 弱 Key 生产阻断（S-P0-5） ([#319](https://github.com/wyyfzb/mc-commander/issues/319)) ([9e1e14b](https://github.com/wyyfzb/mc-commander/commit/9e1e14bf812a9654dd6031e971f004c775964545)), closes [#315](https://github.com/wyyfzb/mc-commander/issues/315)
* **server:** 认证通道收口——锁定键对齐 + trust proxy 可配 + WS 会话复验（S-P0-3 残留） ([#323](https://github.com/wyyfzb/mc-commander/issues/323)) ([bfc8282](https://github.com/wyyfzb/mc-commander/commit/bfc8282829cb6488067e1f8e7a63852401e7d7f1)), closes [#320](https://github.com/wyyfzb/mc-commander/issues/320)
* **server:** 适配 express 5——无 body 请求的 req.body 可选链访问（closes [#20](https://github.com/wyyfzb/mc-commander/issues/20)） ([#34](https://github.com/wyyfzb/mc-commander/issues/34)) ([7ee8c11](https://github.com/wyyfzb/mc-commander/commit/7ee8c11277135715005f88281b381329de539458))
* **server:** 部署终态事件不再写回 activeDeploys 注册表——WS 补发过滤失效修复 ([#422](https://github.com/wyyfzb/mc-commander/issues/422)) ([6a9c087](https://github.com/wyyfzb/mc-commander/commit/6a9c0873cf4f57ddd223dce127dfb8930825bee2)), closes [#420](https://github.com/wyyfzb/mc-commander/issues/420)
* **server:** 静态资源补充 7 天缓存策略 ([#151](https://github.com/wyyfzb/mc-commander/issues/151)) ([fd9bd8d](https://github.com/wyyfzb/mc-commander/commit/fd9bd8db721e6848a76880806ef07355f29b7747))
* **test:** CI Linux 环境失败修复 + 内部缺陷跟踪编号清理 ([e1bc60e](https://github.com/wyyfzb/mc-commander/commit/e1bc60e8386eaf2d4b781feb6ca5d49e576fdcb9))
* worldSpawn 变更检测撤销 TTL+stat 快速路径，内容级字节对比为唯一判定 ([#50](https://github.com/wyyfzb/mc-commander/issues/50)) ([779bb10](https://github.com/wyyfzb/mc-commander/commit/779bb103b0fa922ac21c0657dc9a6f6e1ca1da0c))
* 全栈设计审计整改——错误态/危险操作分级/token铁律/无障碍/后端可靠性 ([#159](https://github.com/wyyfzb/mc-commander/issues/159)) ([58fada3](https://github.com/wyyfzb/mc-commander/commit/58fada35ade3f958ea66ffe7dfff2c83fa93b063))
* 市场空关键词浏览模式（热门插件排序） ([#63](https://github.com/wyyfzb/mc-commander/issues/63)) ([0060d10](https://github.com/wyyfzb/mc-commander/commit/0060d10d97d096c2b079e72b25020d25e665eea4))
* 本地测试基线全绿 + local-check.sh 接入设计 token 守门 ([#378](https://github.com/wyyfzb/mc-commander/issues/378)) ([7532282](https://github.com/wyyfzb/mc-commander/commit/7532282b9f8e50a621e14b41d0701ef4ca91c46e))
* 移除 got v15 不支持的 isResponseOk 选项（安装下载 50301 根因） ([#64](https://github.com/wyyfzb/mc-commander/issues/64)) ([d161fb2](https://github.com/wyyfzb/mc-commander/commit/d161fb221ca5434fe6d511b09b1dd6876a2b7c12))
