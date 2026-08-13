default:
    just --list --list-submodules

dep:
    nub install

test:
    nub exec vitest run

# PostgreSQL backend contract tests against the compose dev instance.
pg-up:
    docker compose up -d --wait db
pg-down:
    docker compose down
pg-test: pg-up
    TEST_PG_URL="postgres://postgres:postgres@localhost:25433/postgres" nub exec vitest run tests/pg.spec.ts

fmt:
    nub exec oxfmt .

lint:
    nub exec oxlint

clean:
    rm -f nub.lock;
    rm -rf node_modules;

coding:
    zephyr dev
