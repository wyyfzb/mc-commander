# Changelog

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
