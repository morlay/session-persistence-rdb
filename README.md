# @morlay/session-persistence-rdb

RDB（SQLite / PostgreSQL）持久会话后端（`ctx.sessionPersistence`）：通过 drizzle
实现 `PersistenceBackend<number>`，复用上游 `PersistenceCoordinator` 与契约测试套件，
支持配置选择 SQLite 或 PostgreSQL 后端。设计细节（表结构、delta 过滤、并发写、
方言差异、仓库结构）见 [docs/design.md](docs/design.md)。

## 安装

从 git 安装到 dsh profile（示例：web）：

```sh
dsh plugin --profile=web add "@morlay/session-persistence-rdb@https://github.com/dsh-external/session-persistence-rdb.git"
```

## 配置

配置写在 `${DSH_HOME}/settings.yaml`，settings namespace 为插件短名
`session-persistence-rdb`（与 cordis 插件 `name` 一致）：

```yaml
session-persistence-rdb:
  type: sqlite
  # path 省略时回落 cordis.patch.yml 的默认（$DSH_HOME/sessions/session.db，
  # 由 bundle patch 的 !!js 表达式求值）；自定义路径请用绝对路径字符串。
  path: /absolute/path/to/sessions.sqlite
  journalMode: wal
  busyTimeout: 5000
```

> settings.yaml 是纯 YAML（settings-local 用 `yaml` 库解析），**不支持 `!!js`
> JS 表达式**——`!!js dshHomePath(...)` 会被当作字面字符串。`!!js` 只在
> `cordis.patch.yml`（bundle patch 层，loader 求值）有效。

字段即 Config 判别联合（见下）；未写出的字段回落到 bundle patch / cordis.yml 的
config 默认值。PostgreSQL：

```yaml
session-persistence-rdb:
  type: postgres
  connectionString: postgres://user:pass@localhost:5432/sessions
```

Config 类型：

```ts
type Config =
  | {
      type: "sqlite";
      /** SQLite 数据库文件路径；`:memory:` 用于测试。 */
      path: string;
      /** journal_mode：`wal`（默认）/ `delete` / `truncate` / `persist`。 */
      journalMode?: "wal" | "delete" | "truncate" | "persist";
      /** 写锁竞争等待毫秒数（默认 5000）。 */
      busyTimeout?: number;
    }
  | {
      type: "postgres";
      /** node-postgres 连接串；首次打开自动建表并写入 store 身份。 */
      connectionString: string;
    };
```

## 开发

```sh
# 同步 vendored deepseek-harness（git clone 到 vendor/deepseek-harness/，
# 同 desktop 模式；DEEPSEEK_HARNESS_REPO / DEEPSEEK_HARNESS_REPO_BRANCH 环境变量）
just sync
# 构建 vendored 的 host 面 lib 产物（依赖闭包内的包需 lib/ + lib/types）
just build-dsh
# 安装依赖（workspace 匹配正常版本 → 链接 vendored 编译产物）
just dep
# lint（oxlint + tsgolint 类型规则，即类型检查）
just lint
# 测试（vitest，含 vendored 契约测试）
just test
```
