# 本地 API v1

所有路径同源 `/api`，成功返回裸 JSON 对象；错误为 `{error: string, message: string}`，HTTP 400/403/404/409/413/500。`shared/contracts.ts` 为载荷/返回类型。前端 api.ts 首先 GET bootstrap，缓存 csrfToken；其后所有变更携带 `X-Workbench-Token`，fetch credentials=same-origin；服务设置HttpOnly会话cookie。不要将凭据放URL或localStorage。

## 当前页面使用的原生只读接口

类型见 `shared/native-contracts.ts`。与旧接口共用同源检查和 HttpOnly 会话校验；未启用或无法读取原生数据时返回 HTTP 503，绝不退回示例目录。

`projects` 仅含 Codex 当前已创建项目，以及有未匹配记录时的 `native:archived`（“已归档”）展示集合。无项目、过期项目归属及无法匹配当前项目的主任务进入该集合，不再生成历史目录项目。该展示分类不改写原始 `archived` 标志。

| 方法/路径 | 请求 | 返回 |
|---|---|---|
| GET /api/native/catalog | 可选 `refresh=1` 立即检查源文件变化 | NativeCatalog：全部项目和任务摘要、覆盖信息；不附带完整正文 |
| GET /api/native/tasks/:id | 原生线程 ID | NativeTaskDetail：按轮次关联的需求、最终输出与状态；ID不存在返回404 |
| GET /api/native/search | `q`，最多150字符 | NativeSearchResult：完整正文模糊命中，含摘要及 `matchTurnId`；无结果数截断 |
| POST /api/native/export/markdown | NativeExportRequest：`projectId`、`scope: project/tasks`、`includeRelated`，`tasks` 模式需非空 `taskIds` | NativeExportResult：`filename`、完整 `markdown`、`readAt`、`taskCount` |
| POST /api/native/export/exchange | NativeExchangeExportRequest：`taskId`、`exchangeId` | NativeExportResult：只包含指定任务的这一轮需求与全部对应输出，`taskCount` 为 1 |

单轮导出沿用相同 POST / 会话 / CSRF 保护。服务端在一次快照中按任务 ID 与轮次 ID 定位，不接受客户端正文、轮序或其他字段；未知任务或不匹配的轮次返回 404，正文不可完整读取返回 503。主任务、子任务与审查均可使用，文档保留任务来源与原始轮次编号，不自动带入相邻轮或关联任务。

Markdown 导出虽然不写入持久化数据，但使用 POST JSON 接收选择列表，必须携带会话 cookie 和 `X-Workbench-Token`，沿用 Host/Origin 校验。`project` 模式不接收 `taskIds`；`tasks` 模式只接受该项目的用户主任务并去重，拒绝未知、跨项目及子任务 ID。`includeRelated` 控制是否将明确归属的子任务与审查嵌入主任务；默认 UI 为 false。导出读取同一内存快照中的完整正文；所选范围有正文不可用时返回明确错误，未选任务不影响结果。响应为 `no-store` JSON，由浏览器生成 UTF-8 Markdown 下载，不接受输出路径、不在服务端落盘。

归档、子任务和历史目录均包含在索引中。`projects[].taskCount` 仅统计 `source === 'user'` 的用户任务；`tasks` 与 `coverage` 保留原始全部记录，供详情展开和覆盖核对。前端依据 `parentId` 沿祖先链把子任务与审查任务归入用户主任务，卡片、页脚和搜索结果统一只展示用户任务；命中子任务时进入主任务并展开对应子任务。界面的分批展示只限制 DOM 数量，不限制搜索范围。服务端仅内存缓存；常规请求5秒内复用快照，之后检查数据库/WAL和项目归属文件签名。原始 Codex 库只读打开。接口不接受源文件路径，不能通过任务ID读取任意文件。

## 保留兼容的旧工作台接口

| 方法/路径 | 请求 | 返回 |
|---|---|---|
| GET /api/bootstrap | — | `{application:'codex-task-workbench',csrfToken, allowedRoots:string[], dataDirectory, version, capabilities:{historyMode:'jsonl',mcp:false}}` |
| GET /api/overview | — | Overview |
| GET /api/projects | — | Project[] |
| POST /api/projects | `{name,rootPath?}` | Project |
| POST /api/sources/import | `{projectId,paths:string[]}`；路径必须位于bootstrap给出的allowedRoots内 | ImportResult |
| GET /api/search | q/projectId/scope/archived/attribution/limit/offset | SearchResult；archived=true含归档，不是只搜归档 |
| GET /api/records/:id | — | SourceRecord（含raw） |
| GET /api/records/:id/context | — | SourceRecord[]：同项目、同会话命中前4条+命中本身+后6条，按顺序返回 |
| GET /api/sessions/:id/records | limit/offset | SourceRecord[] |
| POST /api/records/:id/attribution | `{attribution}` | SourceRecord |
| GET /api/tasks | projectId/archived/q | TaskListItem[]；archived=true含归档，默认false仅活动 |
| POST /api/tasks | CreateTaskInput | TaskDetail；创建初始草稿，currentRevisionId=null，lockVersion=1 |
| GET /api/tasks/:id | — | TaskDetail |
| PUT /api/tasks/:id/draft | SaveDraftInput | TaskDetail |
| POST /api/tasks/:id/activate | `{expectedVersion}` | TaskDetail；激活草稿，v1从这里产生 |
| POST /api/tasks/:id/archive | `{archived,expectedVersion}` | TaskDetail |
| POST /api/handoffs | `{purpose:'organize'|'execute',taskId?,revisionId?,sourceIds?}` | Handoff；页面可下载JSON和复制instruction |
| POST /api/receipts | ReceiptInput | Receipt；文件中不得混入acceptance或assessment等字段 |
| POST /api/assessments | AssessmentInput；仅页面明确人工操作 | Assessment |
| POST /api/acceptances | AcceptInput；仅页面明确人工操作 | Acceptance |
| GET /api/tasks/:id/export | — | `{markdown:string,json:TaskDetail}`；前端生成下载文件 |
| GET /api/backup | — | BackupData；一致性全库快照，含来源和证据文本 |
| POST /api/restore | BackupData | `{projects,tasks,records, restoredDirectory:string, restartRequired:true}`；恢复到新目录，不替换运行中的库；提示用启动器/命令指定新目录验证 |

saveDraft/activate/archive 每次增加 lockVersion，expectedVersion不匹配409。编辑后要刷新detail，不能凭本地缓存沿用版本号。选旧revision只查看/导出，不静默改当前版本。scope=tasks检索所有任务版本，高亮current标志；scope=instructions仅user message，未知来源依然显示并可筛选。

默认只允许已配置的历史目录（.codex/sessions、archived_sessions、前期测试副本）。网页不自动读取认证文件、不执行历史命令、不直接调用模型。首次整理结果通过CreateTaskInput+handoffId/adoptedSuggestions创建草稿；绑定任务的整理结果通过SaveDraftInput导入。两者均完整保留包内来源，拒绝包外来源。同一包同内容重复导入幂等，异内容返回409。初期手工内容也是工作台输入。

启动器使用 POST /api/shutdown（空对象、会话cookie与CSRF令牌）关闭服务；仅服务入口配置了关闭回调时可用。cookie名称按服务端口区分，允许独立目录在不同端口并行验证。静态GET/HEAD允许从其他应用点击链接进入，但仍检查Host和文件路径；数据API始终检查来源和会话。

备份文件包含真实历史，请显示本地文件属性；恢复按钮必须明确说明“验证恢复到新目录，现有工作数据保持原样”。支持导出JSON和Markdown，不依赖笔记软件或外部HTML。
