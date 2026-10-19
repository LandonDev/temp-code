#!/usr/bin/env bash
source "$(dirname "$0")/prod-lib.sh"
secret_env "$SECRETS/convex-postgres.env" CONVEX_POSTGRES_PASSWORD
source "$SECRETS/convex-postgres.env"
# psql gets passwords on stdin only; no secret appears in argv or logs.
if ! docker exec prod-postgres psql -U prod_admin -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='convex_template'" | grep -qx 1; then
  printf "CREATE ROLE convex_template LOGIN PASSWORD '%s';\n" "$CONVEX_POSTGRES_PASSWORD" | docker exec -i prod-postgres psql -v ON_ERROR_STOP=1 -U prod_admin -d postgres >/dev/null
  changed 'Convex database role'
fi
if ! docker exec prod-postgres psql -U prod_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='convex_template'" | grep -qx 1; then
  docker exec prod-postgres createdb -U prod_admin -O convex_template convex_template
  changed 'Convex database'
fi
if [[ ! -s $SECRETS/convex-template.env ]]; then
  {
    printf 'INSTANCE_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'POSTGRES_URL=postgresql://convex_template:%s@postgres:5432\n' "$CONVEX_POSTGRES_PASSWORD"
  } | put "$SECRETS/convex-template.env" 600
fi
unset CONVEX_POSTGRES_PASSWORD
install -d -m 750 "$PROD/stacks/convex-template"
put "$PROD/stacks/convex-template/compose.yml" 644 < "$BOX_DIR/convex.compose.yml"
compose_up convex-template "$PROD/stacks/convex-template/compose.yml" "$SECRETS/convex-template.env"
if [[ ! -s $SECRETS/convex-template-admin-key ]]; then
  tmp=$(mktemp "$SECRETS/.convex-key.XXXXXX")
  docker exec convex-template-backend ./generate_admin_key.sh > "$tmp"
  [[ -s $tmp && $(wc -l < "$tmp") == 1 ]] || die 'Unexpected admin key output; inspect privately'
  put "$SECRETS/convex-template-admin-key" 600 < "$tmp"
  rm -f "$tmp"
fi
[[ $(stat -c '%a:%U:%G' "$SECRETS/convex-template-admin-key") == 600:root:root ]] || die 'Unsafe Convex admin-key permissions'
curl -fsS http://127.0.0.1:3210/version
