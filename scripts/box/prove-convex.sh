#!/usr/bin/env bash
# Mac only. The admin key lives in memory; never in a local .env or arguments.
set -euo pipefail
unset HISTFILE
umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/convex-prod-proof.XXXXXX")
cleanup() { unset CONVEX_SELF_HOSTED_ADMIN_KEY; rm -rf "$scratch"; }
trap cleanup EXIT
cd "$scratch"
printf '{"private":true,"type":"module"}\n' > package.json
npm install --silent convex@latest typescript@latest
mkdir convex
cat > convex/tsconfig.json <<'JSON'
{"compilerOptions":{"target":"ESNext","lib":["ES2023","DOM"],"module":"ESNext","moduleResolution":"Bundler","strict":true,"skipLibCheck":true,"noEmit":true},"include":["./**/*.ts"]}
JSON
cat > convex/proof.ts <<'TS'
import { query } from "./_generated/server";
import { v } from "convex/values";
export const roundTrip = query({
  args: { value: v.string() },
  returns: v.object({ value: v.string(), deployment: v.literal("convex-template") }),
  handler: async (_ctx, args) => ({ value: args.value, deployment: "convex-template" as const }),
});
TS
export CONVEX_SELF_HOSTED_URL=https://convex-template.landonhale.com
CONVEX_SELF_HOSTED_ADMIN_KEY=$(ssh -o BatchMode=yes box 'unset HISTFILE; cat /srv/prod/secrets/convex-template-admin-key')
export CONVEX_SELF_HOSTED_ADMIN_KEY
npx convex dev --once
npx tsc --noEmit --project convex/tsconfig.json
npx convex run proof:roundTrip '{"value":"Mac-to-box round trip passed"}'
printf 'PASS: deployed and queried Convex from the Mac; scratch project removed on exit\n'
