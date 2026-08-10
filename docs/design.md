# 设计说明

本文件记录 `@morlay/session-persistence-rdb` 的设计与实现细节；使用方式见
[README](../README.md)。

## 仓库结构与依赖解析

```
session-persistence-rdb/
├── pnpm-workspace.yaml          # monorepo：本包 + vendored deepseek-harness 依赖闭包
├── vendor/deepseek-harness/     # vendored deepseek-harness（gitignore；git clone 或复制，
│                                #   同 desktop 模式，见 just sync / vendor/justfile）
├── cordis.patch.yml             # bundle 声明：dsh plugin 装配本插件
├── src/                         # 只 import 官方包（cordis / @deepseek-ai/dsh-*）
└── tests/                       # 含 vendored 官方契约测试
```

依赖解析：`pnpm-workspace.yaml` 以**正常版本号 + workspace 匹配**
（`linkWorkspacePackages: true`）把依赖解析到 vendored deepseek-harness 编译好的
`lib/` 产物——无需发布、无需 registry、无需 `link:` 路径。packages 列表是依赖闭包
（14 个包），由 deepseek-harness 各包 package.json 的 dependencies +
peerDependencies + devDependencies 中的 workspace 引用 BFS 收集而来；闭包变动时按
同一规则重跑收集。

## 与上游实现的差异

### 表结构：三表事件存储（参考 playpen-session store）

命名统一：表一律 `t_` 前缀、字段一律 `f_` 前缀；**实体在 `src/entities/`
纯定义**（每张表一个文件，方言无关的描述；无任何实现逻辑），SQLite
（`sqliteTable`）与 PostgreSQL（`pgTable`）的 drizzle 表对象以及建表 DDL
由 `src/adapters/` 从这些实体转化生成——无手写 DDL、无迁移工具链。另有
单例表 `t_persistence_state`（`f_singleton` / `f_store_id`，store 身份）与
PG 专用的 `t_schema_meta`。除键列外各表另带 `f_id` serial 自增主键
（`t_persistence_state` 以 `f_singleton`、`t_schema_meta` 以 `f_key` 为键列，
无 `f_id`）。**多表关联一律用业务键、不用 `f_id`**：`t_session_events` 的
`f_session_id` / `f_event_id` 外键（ON DELETE CASCADE）分别引用
`t_sessions.f_session_id` / `t_events.f_event_id`；查询与 join 也只走业务键
（`t_sessions`/`t_events` 按各自 UNIQUE 列，`t_session_events` 按
`UNIQUE(f_session_id, f_sequence)`），不为不可达查询维护额外索引。

| 表                 | 说明                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t_sessions`       | 会话元数据（`SessionHeader` 列）+ playpen 风格 head 游标（`f_head_event_id` / `f_head_sequence`，事务内维护，append 时提供 parent 链与下一个 seq）                                                                                                                                                                                                                               |
| `t_events`         | **全局事件实体**：`f_event_id`（UUID 唯一）、`f_parent_id`（事件链，空串表示 root）、`f_kind`（= 上游 `type`）、`f_role` / `f_name` / `f_action_id`（playpen 事件维度，从事件分类提取）、`f_encoding`（`json`）、`f_data`（JSON 文本）、`f_created_at`（= `time`）、`f_original_seq`（上游原始 seq）、`f_source_event_seqs` / `f_surface_op`（surface 元数据，JSON 文本或 NULL） |
| `t_session_events` | 会话事件桥接表：`(f_session_id, f_event_id, f_sequence)`，`UNIQUE(f_session_id, f_sequence)`，按 `f_sequence` 排序读取；删除尾部只删桥接行，事件作为全局实体保留                                                                                                                                                                                                                 |

`f_role` / `f_name` / `f_action_id` 映射：`turn/*`/`step/*`/`session/end-seed` → `turn`；
`user/message`/`steering/message`/`request/*` → `user`；`assistant/message` → `model`；
`tool/call` → `function` + `f_name=name` + `f_action_id=callId`；`tool/result` → `function`

- `f_action_id=message.content[0].toolCallId`；`todo/write` → `state` + `f_name=todos`；
  未知（插件扩展）事件类型保持 playpen 默认空值。

### delta 内容不入库（`assistant/chunk` 被过滤）

`EPHEMERAL_EVENT_TYPES = ['assistant/chunk']`：写入时 delta 事件**整行丢弃**（内容与
行都不落库），非 delta 事件按持久化计数**压缩重编号**（`f_sequence` 稠密连续，
`f_original_seq` 保留上游 seq）。读取时 `sourceEventSeqs` 经 `buildSeqMap` 重映射回稠密
seq 空间。由此：

- 库内 seq 始终连续，`scanRows` 的崩溃尾部语义（last `turn/end` 切割、torn tail 截断）不变；
- reload 后以 `load` 结果重建会话（`ctx.sessions.create(id, { seed })`），seed 稠密连续，
  后续 append 从稠密 cursor 继续——持久化侧"重新创建"了自己的 seq 体系，不依赖上游
  修改 session 层（上游 `Session.seq = log.length` 仍含 chunk）；
- 只含 delta 的批次是 no-op：不建行、不 bump revision；
- 契约测试（`runPersistenceContract` / `runCoordinatorContract`）不含 delta 事件，原样通过。

**`sourceEventSeqs` 写路径清理**：上游 `assistant/message` 的 `sourceEventSeqs` 引用的是
**上游 seq**（`agent-loop` 用产生该消息的 chunk seq 列表填充）。被过滤的 chunk 没有持久化
行，若原样落库，读取时 `buildSeqMap` 无法重映射这些引用（map 里没有对应项），重放 seed
时 `assertProvenance` 会报 `sourceEventSeqs must reference earlier events`（引用值 ≥ 当前
稠密 seq），会话显示损坏。因此写路径（`appendBatch`）按 session 记录被丢弃的 delta 上游
seq，写 `assistant/message` 时把 `sourceEventSeqs` 中命中这些 seq 的引用**剔除**（同批与
跨批都生效；剔除后为空则存 NULL，即无 provenance）。引用持久化事件（user/message、
tool/call 等）的部分原样保留并在读取时重映射。

已知代价：同一会话的库内 seq 与上游内存 seq 不同（差一个已过滤的 delta 计数）；上游
未来按提案给 chunk 分配独立通道（不占 seq）后，两套 seq 将自然合一。

### 并发写入者检测（多个实例/进程共享同一数据库）

本后端的事件按**稠密 seq** 重编号（delta 过滤后），而每个
`PersistenceCoordinator` 实例只在内存里维护自己的**上游 seq** 游标。因此两个
后端实例（另一个 `dsh` 进程、或同一进程内重复加载的持久化插件）共享同一
`sessions.sqlite` 时，**同一个 session id 只能有一个写入者**：

- 后端记录每个 session「本实例最后确认的稠密 head」（来自本实例的写入或
  `loadStored` 观察）；`appendBatch` 在事务内校验磁盘 head 与该记录一致。
- 磁盘 head 已被其他实例推进（另一写入者提交过）、或本实例从未读过该 session
  却遇到已有行时，append **fail loud 拒绝**（`modified by another writer` /
  `has a persisted log this instance has not read`），而不是把本批次静默重编号到
  对方尾部——后者会把两组独立 turn 拼接成同一个 log，**事件内容与 seq 语义
  全部错位**（log 级损坏，`UNIQUE(f_session_id, f_sequence)` 无法拦截，因为
  稠密重编号天然无冲突）。
- 不同 session id 的并发写不受影响（各自独立 head），两个实例各写各的 session
  是受支持的多进程部署（`busy_timeout` 只负责让写锁竞争排队）。
- 一个实例 `load`（或 HMR adopt）过某 session 后可以继续 append——那是一次
  明确授权、基于最新磁盘状态的续接；同 id 双实例「都 load 过再各自写」仍不
  支持（需要跨实例协调器，超出本后端职责）。

### 其余保留的上游语义

- `t_persistence_state`（f_store_id 单例）、`SCHEMA_VERSION`（新实现从 1 起）、
  `application_id = 0x44534850`、`openDatabase` 的 BEGIN IMMEDIATE 校验
  （unversioned / 版本不匹配 / 外来 application id 拒绝且不迁移）
- 懒实体化（t_sessions 行 = materialized 信号）、崩溃尾部 on-load 修复（torn tail 截断 +
  合成 closers，head 游标同步回退/前进）、revision/incarnation 快照语义、
  文件与目录 owner-only 权限（0o600 / 0o700）、WAL 默认 `journal_mode`、
  `locate()` 返回 `undefined`（无独立 per-session 文件）

### 方言差异（PostgreSQL 后端）

- `f_created_at` 用 `BIGINT`（毫秒时间戳超出 PG `INTEGER` 的 int32 范围）；
- schema 版本 / 应用身份校验用 `t_schema_meta` 键值表（`schema_version` /
  `application_id` 两行），替代 SQLite 的 `PRAGMA user_version` /
  `application_id`（PG 无等价 pragma）；无迁移工具链，版本不匹配同样拒绝而非迁移；
- 事务：SQLite `BEGIN IMMEDIATE` 提前取写锁（busy_timeout 排队，进程内事务
  全局串行）；PG 依赖事务行锁 + `UNIQUE(f_session_id, f_sequence)` 拒绝冲突批次。

## 伴随插件（invariant）

`./invariant` 子路径导出伴随插件（`src/invariant.ts`）：在 `ctx.invariants` 服务上
以 `@morlay/session-persistence-rdb` 注册包所有权（当前安装器为空实现——持久化
正确性依赖后端往返与崩溃尾部测试，无可观测的进程内不变量）。
