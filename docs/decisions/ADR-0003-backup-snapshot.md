# ADR-0003：备份采用目录快照 + 硬链接增量

- 状态：accepted
- 日期：2026-08-11

## 背景

Minecraft 世界目录（region 文件）内部已是 zlib 压缩，通用 zip 二次压缩
增益仅约 23-30%，且全量压缩在大世界下耗时不可接受。业界主流备份方案
（docker-mc-backup / rsnapshot）均已转向不压缩的增量快照路线。

## 决策

- 备份 = **目录快照 + 增量传输**：
  - Linux：`rsync -a --link-dest=<上一快照绝对路径>`，未变化文件硬链接零拷贝；
    退出码 0/24 视为成功；快照模式严禁 `--delete`
  - Windows：优先 MSYS2 rsync，ENOENT 时自动降级 `robocopy /MIR /MT:16 /R:2 /W:5`；
    robocopy 退出码 ≤7 均为成功（位标志），**绝不能按 `code === 0` 判定**
- 快照目录：`backups/<instanceId>/<名称>-<时间戳>/`（无压缩扩展名）；
  备份 size 语义 = 单快照逻辑大小（同 `du -sb`）
- 恢复 = 目录复制（**禁止 mv** —— 会把共享 inode 移交出去污染快照链）：
  rsync `-a --delete` 或 robocopy `/MIR`；恢复前有 rename 双保险与快照预检
  （level.dat 存在性），jar 文件单独还原
- 大世界子进程超时按预估规模动态计算（每 MB 4s，上下限 5min–60min）

## 后果

- 首次快照为全量，后续增量接近零拷贝，大世界备份从小时级降到分钟级
- 依赖：Linux 需安装 rsync（部署脚本已包含）；实例目录与备份目录须在同一
  文件系统（跨设备 EXDEV 会退化为全量复制，部署时校验告警）
- 旧 zip 格式备份保留可下载、可删除，恢复时返回 40904 不支持
