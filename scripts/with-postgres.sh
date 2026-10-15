#!/usr/bin/env bash
# Runs a command against a throwaway PostgreSQL cluster, created in a temporary directory and
# deleted afterwards, whatever the command's outcome. The command sees its URL as
# E2E_DATABASE_URL (read by apps/web/playwright.config.ts) and DATABASE_URL.
#
#   pnpm build && scripts/with-postgres.sh pnpm e2e      # or: pnpm e2e:postgres
#
# Needs PostgreSQL's server programs (initdb, pg_ctl, createdb): from PG_BIN, else PATH, else the
# newest /usr/lib/postgresql/*/bin (Debian, Ubuntu). Production runs on Render's PostgreSQL; CI
# runs the end-to-end suite on the same major version (.github/workflows/ci.yml).
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

bin_dir="${PG_BIN:-}"
if [[ -z "$bin_dir" ]]; then
  if command -v initdb >/dev/null 2>&1; then
    bin_dir="$(dirname "$(command -v initdb)")"
  else
    bin_dir="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
  fi
fi
if [[ -z "$bin_dir" || ! -x "$bin_dir/initdb" ]]; then
  echo "PostgreSQL server programs not found: install PostgreSQL or set PG_BIN." >&2
  exit 1
fi

port="${PG_PORT:-55432}"
cluster="$(mktemp -d)"
# initdb refuses to run as root: on a root shell (a container), the cluster belongs to nobody.
as_owner=()
if [[ "$(id -u)" -eq 0 ]]; then
  chown nobody "$cluster"
  as_owner=(runuser -u nobody --)
fi

stop() {
  "${as_owner[@]}" "$bin_dir/pg_ctl" -D "$cluster/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$cluster"
}
trap stop EXIT

"${as_owner[@]}" "$bin_dir/initdb" -D "$cluster/data" -U releve --auth=trust >/dev/null
# The socket in the cluster's directory, so no system directory needs to be writable.
"${as_owner[@]}" "$bin_dir/pg_ctl" -D "$cluster/data" -l "$cluster/server.log" -w \
  -o "-p $port -k $cluster -c listen_addresses=localhost" start >/dev/null
"${as_owner[@]}" "$bin_dir/createdb" -h localhost -p "$port" -U releve releve

version="$("$bin_dir/postgres" --version)"
echo "Throwaway ${version#postgres } on port $port" >&2

export E2E_DATABASE_URL="postgres://releve@localhost:$port/releve"
export DATABASE_URL="$E2E_DATABASE_URL"
"$@"
