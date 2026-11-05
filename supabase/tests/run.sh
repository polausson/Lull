#!/usr/bin/env bash
# Spins up a throwaway Postgres, applies stubs + migration, runs tests.sql.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="$(ls -d /usr/lib/postgresql/*/bin | tail -1)"
tmp="$(mktemp -d)"; chmod 777 "$tmp"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
run "$bin/initdb -D $tmp/db -A trust -U postgres >/dev/null"
run "$bin/pg_ctl -D $tmp/db -o '-k $tmp -p 55432 -c listen_addresses=' -l $tmp/log start >/dev/null"
trap 'run "$bin/pg_ctl -D $tmp/db stop -m immediate >/dev/null"; rm -rf "$tmp"' EXIT
psql=(psql -h "$tmp" -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
"${psql[@]}" -f "$here/supabase_stubs.sql"
"${psql[@]}" -f "$here/../migrations/20261104000000_init.sql"
"${psql[@]}" -f "$here/tests.sql"
echo "ALL SQL TESTS PASSED"
