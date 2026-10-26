# 历史导入边界

`importHistoryPaths(paths, projectId)` 是本项目独立实现的 Node JSONL 适配器，没有复制 History Viewer 源码或依赖 VS Code。曾核对 History Viewer 2.19.0 的元数据、上下文及 FileChange 封装规则；上游的 60 项检查不等同于本模块测试。

支持显式选定 JSONL 文件/目录；不读认证文件或 Codex 内部数据库，不执行日志内容。递归跳过符号链接，校验真实路径边界；每文件读取前后 SHA-256 一致才提交。限制为 2000 个文件、单文件 64 MiB、单批 256 MiB，超限明确诊断。

保存每条有效物理记录的原文、原始行哈希、文件路径、行号、字节位置、解析器版本及首条元数据指纹。`raw` 不含行分隔符，`hash` 对应原始行 UTF-8 字节；`files[].hash` 对应完整文件字节。半条 JSON/UTF-8 或损坏行诊断后留待后续扫描，不伪造消息。未知的有效 JSON 对象保留为 context 并诊断。

首条 session_meta 决定当前会话身份和来源。所有 user 消息的作者初始为 unknown；子代理来源不被当成人类或每条消息的作者证明。内嵌不同 session_meta 后的记录标为继承，遇到 inter_agent_communication_metadata 的 trigger_turn 或显式当前 thread_id 回到当前会话；显式外部 thread_id 只影响该条。边界无法确认时显示诊断。此规则只覆盖已验证的日志封装。

记录 ID 对同会话同元数据、同事件保持稳定，追加和归档移动不变；相同文字的不同无 ID 事件用出现次数区分。不同会话的继承呈现不会贸然合并为一个原始事件；缺少元数据时路径身份的移动稳定性不保证，另有诊断。若源数据被截断/改写，保留已入库历史，不在导入器中擅自删除旧记录。

FileChange/旧 patch_apply_end 需显式 completed 或 success=true 才为 confirmed；显式失败优先降为 attempted，其余为 unknown。只有 apply_patch 输入的记录是 attempted。普通工具参数/输出出现路径不代表已修改。输出 `confirmed` 仅说明日志报告成功，不等同于当前工作区状态或人工验收。

当前不支持 `.jsonl.zst`、history_base 跨文件边界补齐、回滚历史投影或官方分页导入。物理 JSONL、父引用缺失/歧义/循环和未验证覆盖范围分别诊断；不能把读取到文件称为全量历史。原始调用和新版完成事件都保留，不将不同调用 ID 猜测合并。

验证：`node --test tests/history-import.test.ts`。真实样本测试仅在显式设置 `WORKBENCH_SAMPLE_MANIFEST` 时读取对应的10份本机副本，未配置时明确跳过；私有样本不随仓库分发，测试结果与合成边界用例一同报告。官方能力探针：`node scripts/probe-history.ts <codex.exe完整路径>`，仅创建隔离空 CODEX_HOME；运行后生成本地 `evidence/probe-history.json`，该目录不提交到仓库。
