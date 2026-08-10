# session-persistence-rdb 日常命令。
#
# 用法（仓库根执行）：
#   just sync        同步 vendored deepseek-harness（委托 vendor/justfile）
#   just dep         安装依赖（workspace 匹配正常版本 → 链接 vendored 编译产物）
#   just build-dsh   构建 vendored deepseek-harness 的 host 面 lib 产物（委托 vendor/justfile）
#   just test        vitest 测试（含 vendored 契约测试）
#   just lint        oxlint（含 tsgolint 类型规则，即类型检查）
#   just clean       清理本包 node_modules 与 lock
#
# vendored deepseek-harness 在 vendor/deepseek-harness/（gitignore），其管理命令
# 见 vendor/justfile；依赖解析见 pnpm-workspace.yaml（精确闭包 + linkWorkspacePackages）。

mod vendor 'vendor/justfile'

default:
    just --list --list-submodules

dep:
    nub install

test:
    nub exec vitest run

lint:
    nub exec oxlint

clean:
    rm -f nub.lock;
    rm -rf node_modules;
