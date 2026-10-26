#!/usr/bin/env bash
# Runs setup.sql (twice, to prove it is safe to re-run) and the access checks
# against a throwaway local PostgreSQL. Needs PostgreSQL 15 or newer
# (initdb, pg_ctl and psql on PATH, or PG_BIN set). Never touches Supabase.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
supa="$(dirname "$here")"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PATH="$PG_BIN:$PATH"

tmp="$(mktemp -d)"
port="${PGPORT_TEST:-54329}"
as_pg=()
# initdb refuses to run as root; use the postgres account when we are root.
if [ "$(id -u)" = 0 ]; then
  chown postgres "$tmp"
  as_pg=(runuser -u postgres --)
fi
cleanup() { "${as_pg[@]}" pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

"${as_pg[@]}" initdb -D "$tmp/data" -U postgres -A trust >/dev/null
"${as_pg[@]}" pg_ctl -D "$tmp/data" -o "-p $port -k $tmp -c listen_addresses=''" -l "$tmp/log" -w start >/dev/null

export PGOPTIONS="-c client_min_messages=warning"
psql=(psql -X -q -v ON_ERROR_STOP=1 -h "$tmp" -p "$port" -U postgres -d postgres)
"${psql[@]}" -f "$here/stubs.sql"
"${psql[@]}" -f "$supa/setup.sql"
"${psql[@]}" -f "$supa/setup.sql"
sed "s/person@example.com/member@example.com/" "$supa/add-team-member.sql" | "${psql[@]}" >/dev/null
"${psql[@]}" -f "$here/checks.sql"
