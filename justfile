default:
    just --list --list-submodules

dep:
    nub install

test:
    nub exec vitest run

fmt:
    nub exec oxfmt .

lint:
    nub exec oxlint

clean:
    rm -f nub.lock;
    rm -rf node_modules;

coding:
    zephyr dev
