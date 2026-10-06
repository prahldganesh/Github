#!/usr/bin/env bash
#
# Create the local development role and database (idempotent).
#
# WHY a role separate from the macOS user: production connects to Supabase as a
# dedicated role with a password. Creating one locally means the same connection
# shape is used everywhere, instead of developing as a superuser and discovering
# the difference in production.
#
# Idempotent: safe to run repeatedly. Existing objects are left alone.
#
# On this machine PostgreSQL comes from miniconda (not Homebrew) because
# /opt/homebrew is not writable by this user. The script finds the binaries
# either way.
set -euo pipefail

DB_NAME="${DB_NAME:-gotham_renewal}"
DB_ROLE="${DB_ROLE:-gotham}"
DB_PASSWORD="${DB_PASSWORD:-gotham}"
PGDATA="${PGDATA:-$HOME/.local/share/pgdata/gotham}"

# Locate psql, preferring miniconda, then Homebrew.
if ! command -v psql >/dev/null 2>&1; then
  if [ -x "$HOME/miniconda3/bin/psql" ]; then
    export PATH="$HOME/miniconda3/bin:$PATH"
  else
    export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:$PATH"
  fi
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install PostgreSQL, then re-run. Options:"
  echo "  conda install -y postgresql        # works without sudo (this machine)"
  echo "  brew install postgresql@17         # needs /opt/homebrew to be writable"
  exit 1
fi

if ! pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
  echo "PostgreSQL is not accepting connections on 127.0.0.1:5432. Start it with:"
  echo "  export PATH=\"\$HOME/miniconda3/bin:\$PATH\""
  echo "  pg_ctl -D \"$PGDATA\" -l \"$PGDATA/server.log\" start"
  echo
  echo "If no cluster exists yet, create one:"
  echo "  initdb -D \"$PGDATA\" -U postgres --auth-local=trust --auth-host=trust -E UTF8"
  exit 1
fi

# The bootstrap superuser in a freshly initdb'd cluster is 'postgres'.
psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_ROLE}') THEN
    CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${DB_PASSWORD}' CREATEDB;
  ELSE
    ALTER ROLE ${DB_ROLE} CREATEDB;
  END IF;
END
\$\$;
SQL

if ! psql -h 127.0.0.1 -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  createdb -h 127.0.0.1 -U postgres -O "${DB_ROLE}" "${DB_NAME}"
  echo "Created database ${DB_NAME}."
else
  echo "Database ${DB_NAME} already exists."
fi

# Prisma Migrate needs to create a shadow database during `migrate dev`.
psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE ${DB_ROLE} CREATEDB;" >/dev/null

echo "Done. DATABASE_URL should be:"
echo "  postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public"
