default:
    just --list

dep *args:
    nub install {{ args }}

clean:
    rm -f nub.lock;
    rm -rf node_modules;

fmt:
    nub exec oxfmt .

lint:
    nub exec oxlint

build:
    nub exec tsdown

test:
    nub exec vitest run

mod pg 'tool/pg/justfile'
