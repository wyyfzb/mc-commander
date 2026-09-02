# ADR-0005：面板自身数据纳入备份（SQLite 快照 + .env 处置）

- 状态：accepted
- 日期：2026-09-02
- 关联：issue #284 / audit-2026-08-31.md D-P1-1 / ADR-0003（实例备份）

## 背景

面板备份体系此前仅覆盖实例数据（世界/plugins/mods/config + jar），面板自身
SQLite 数据库（管理员账号、实例配置、tempban、定时任务、webhook、审计日志等）
零备份——实例备份可恢复，面板配置丢失即永久丢失。audit D-P1-1 建议每日
`db.backup()` 快照至 `backups/panel/` 并纳入保留策略。

## 决策

- **快照方式**：better-sqlite3 backup API（SQLite online backup，逐页拷贝，
  源库可继续读写，WAL 模式安全）。禁止直接复制 db 文件（锁/半写风险）。
  快照失败时清理半写目标文件，避免被保留清理误认为有效快照
- **快照位置**：`backups/panel/panel-<ISO 时间戳>.db`，与实例备份
  （`backups/<instanceId>/`）命名空间区分。**不入 backups 表**：
  该表 `instance_id NOT NULL` 外键约束面向实例备份，面板快照无实例归属，
  强行入库需破坏约束且污染实例备份的 API/前端列表——按文件系统独立管理
- **调度**：TaskScheduler 内挂独立 croner 实例（`PANEL_BACKUP_CRON`，
  默认每日 04:00），不进用户定时任务体系——面板库故障时用户任务仍可正常
  增删执行；快照失败仅记日志，不干扰调度主循环。`PANEL_BACKUP_ENABLED=false`
  可整体关闭
- **保留策略**：与实例备份语义一致（数量 + 天数双上限，超出最旧先删）。
  默认继承 `BACKUP_RETENTION_MAX` / `BACKUP_RETENTION_DAYS`，
  可用 `PANEL_BACKUP_RETENTION_MAX` / `PANEL_BACKUP_RETENTION_DAYS` 独立覆盖。
  时间判定按文件 mtime（本机生成文件无迁移语义）

### .env 处置结论：不纳入自动备份，文档化手动备份指引

依据：

1. `.env` 含 `API_KEY` / `API_KEY_HASH` 等认证凭据，备份产物可经面板 API
   下载——纳入备份等于为凭据增加一条网络可达的泄露路径（面板凭证泄露或
   会话劫持可间接读取 API Key），风险大于收益
2. `.env` 变更频率极低（部署时写一次，升级偶发调整），手动备份成本可忽略
3. 手动备份仅需复制单个小文件，无需脚本化

## 恢复步骤（面板库快照还原）

1. **停止面板进程**（systemd `stop` 或结束进程）——运行中覆盖会导致
   WAL 半写，恢复后数据损坏
2. 留存现场：将 `data/mc_commander.db` 及 `-wal` / `-shm` 残留文件
   移出 `data/`（不要覆盖旧快照目录）
3. 将 `backups/panel/` 中目标快照复制为 `data/mc_commander.db`
4. 确认 `data/` 下无 `mc_commander.db-wal` / `mc_commander.db-shm` 残留
   （有则删除——旧 WAL 与恢复的库不匹配）
5. 启动面板，验证登录与实例列表完整性
6. 确认无误后清理第 2 步留存的现场文件

注意：快照恢复的是**面板配置**；实例世界数据请用实例备份恢复（ADR-0003），
两者相互独立。
