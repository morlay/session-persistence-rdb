# session-persistence-rdb 日常命令。
#
# 用法（仓库根执行）：
#   just dep         安装依赖（@deepseek-ai/* 从 npm registry 安装）
#   just test        vitest 测试（含上游契约测试）
#   just lint        oxlint（含 tsgolint 类型规则，即类型检查）
#   just clean       清理本包 node_modules 与 lock

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
