# Production platform on box

No site or cloud Convex app has moved. This is the hosting platform and one
empty Convex deployment with a proof query. Host setup remains in [box.md](box.md).

## Installed layout

| Component | Location | Tunnel origin |
| --- | --- | --- |
| Coolify 4.4.6 | `/srv/prod/coolify`; `/data/coolify` symlinks there | `127.0.0.1:8000` |
| Traefik 3.7.15 | `/data/coolify/proxy/docker-compose.yml` | `127.0.0.1:80` |
| PostgreSQL 16.15 | `/srv/prod/stacks/managed/compose.yml`; data `/srv/prod/data/postgres` | `127.0.0.1:5432`, no DNS |
| Redis 7.4.11, AOF enabled | Same stack; data `/srv/prod/data/redis` | `127.0.0.1:6379`, no DNS |
| Convex backend | `/srv/prod/stacks/convex-template/compose.yml`; files `/srv/prod/data/convex-template` | `127.0.0.1:3210` |
| Convex HTTP actions | Same backend; reserved for future use | `127.0.0.1:3211`, no DNS |
| Convex dashboard | Same stack | `127.0.0.1:6791` |
| Secrets | `/srv/prod/secrets/`, root 700; files root 600 | None |
| PostgreSQL dumps | `/srv/prod/backups/postgres/`, root 700 | None |

The managed database stack is plain Compose, ready for a later Coolify import.
The first admin exists, but no Coolify API token was minted and onboarding has
not been completed in the browser. These services are not yet Coolify-managed
resources. Do not create a second database stack against the same data paths.

Coolify also runs its own PostgreSQL 15 and Redis 7, plus Sentinel. Its private
Docker volumes `coolify-db` and `coolify-redis` live under
`/srv/prod/docker/volumes/`. These are separate from the managed databases.
The nightly backup includes Coolify's PostgreSQL too.

Docker and all containers use `prod.slice`; memory accounting is on.
Docker's supported daemon setting is **`"cgroup-parent": "prod.slice"`**.
`default-cgroup-parent` is not a valid dockerd setting. Live restore, log limits
(3 × 10 MB), the Docker socket permissions, data root, and inbound fence remain.
A `10.240.0.0/16` pool with /24 networks keeps Coolify's installer from replacing
the daemon config. Stage 50 preserves these added settings on later baseline runs.
An empty Docker inspect `CgroupParent` means the daemon default applies; check
`/proc/<container-pid>/cgroup` for the actual placement.

The host still has one root filesystem. `/srv/prod` is not a separate volume or
quota. The slice protects CPU, I/O, and memory shares; it does not isolate root
administrators. `prod` has Docker access, which grants root-level host control.
`agents` still has no Docker access.

## Hostnames and access

| Hostname | Route |
| --- | --- |
| `coolify.landonhale.com` | Cloudflare Access, then tunnel to `http://127.0.0.1:8000` |
| `convex-template.landonhale.com` | Tunnel to `http://127.0.0.1:3210` |
| `convex-template-dash.landonhale.com` | Tunnel to `http://127.0.0.1:6791` |

Coolify's `/app` and `/apps` paths go to loopback port 6001 for realtime;
`/terminal/ws` goes to loopback port 6002. All other dashboard paths use 8000.
`tempcode.landonhale.com` still goes to 7677. No new inbound firewall rule exists.
All host port publications bind `127.0.0.1`, including Traefik; nothing publishes
80, 443, 8000, database ports, or Convex ports on a public address.

**Cloudflare Access must protect all paths on `coolify.landonhale.com` before
any registration or login.** Coolify's first visitor can become admin on an
unregistered instance. The approved install pre-created Landon's admin using
`landonhaleyoutube@gmail.com`, so registration is already closed. At verification,
an unauthenticated HTTPS request redirected to
`cosmicprisons.cloudflareaccess.com`, and the Access login page returned 200.
No Access policy was created or changed by these scripts.

Next user steps:

1. Confirm the chat thread's Access policy allows only the intended identity
   on the **whole hostname**, including realtime and terminal paths.
2. Retrieve `/srv/prod/secrets/coolify-admin.env` in a private root SSH session
   or password manager. Never paste it into chat, git, a command argument,
   or a shell history file. Sign in after Access, then change the generated
   password. **Do not register again.** The installer uses its root credentials
   only to create the first account; reapply does not reset a changed password.
3. Complete Coolify onboarding. Set the instance URL to
   `https://coolify.landonhale.com`. Keep automatic updates off until each
   upgrade has been reviewed for port bindings and host changes.
4. Check the existing localhost server and existing proxy configuration.
   Do not generate a default proxy config: it publishes public 80/443/8080.
   Keep the repo's loopback proxy file, HTTP entrypoint, and `coolify` network.
5. Create an API token in Coolify only when needed; save it in a root-only file
   under `/srv/prod/secrets/`, never the repo.

The Convex dashboard requires the deployment admin key. Adding Access there is
optional; do not place an interactive Access login in front of the backend
without planning how app clients and the Convex CLI will authenticate.

## Apply and verify

From the Mac, in this checkout:

```sh
scripts/box/apply.sh --from 100 --through 190
scripts/box/apply.sh --from 100 --through 190
python3 scripts/box/test-apply.py
scripts/box/prove-convex.sh
ssh box 'unset HISTFILE; python3 /opt/box-baseline/prove-coolify.py'
ssh box 'unset HISTFILE; bash /opt/box-baseline/prove-postgres-backup.sh'
```

| Stage | Purpose |
| --- | --- |
| 100 | Save original host guards once, merge Docker config, validate it, restart only on change; temporary cgroup proof |
| 110 | Install Coolify once through the reviewed official installer; reconcile loopback override; require first admin |
| 120 | Managed Postgres/Redis, generated credentials, backup service/timer |
| 130 | Convex database/role, backend/dashboard, persistent instance secret, generated admin key |
| 140 | Coolify-compatible Traefik with only a loopback HTTP origin |
| 150 | Mac DNS routes, then production tunnel ingress; requires first admin |
| 190 | Verify host service, UFW, listeners, every container cgroup/health/binding, and local origins |

`apply.sh` sorts both two- and three-digit stages as numbers. It keeps SSH from
consuming the stage list. The dispatcher test covers full and bounded stage ranges.
Scripts copy to `/opt/box-baseline`; state lives in `/var/lib/box-baseline`.
`prod-before.json` records the original temp-code PID, start time, restart count,
UFW output, and non-loopback listeners. Do not overwrite it to hide a failure.
If another authorized thread later restarts temp-code, review that event before
saving a new baseline in a separate maintenance change.

Production ingress lives in `scripts/box/prod-ingress.yml`. Stage 60 includes it
only after stage 150 has written `prod-ingress-ready`; full baseline reapply
therefore retains production routes. The Mac DNS helper uses the clean
`cloudflared-local.yml`, never the Mac's default tunnel config. The origin cert
stays on the Mac. Existing DNS routes return success without being changed.

The official installer is SHA-256 gated. Read a new installer before updating
that hash. It creates Coolify directories, secrets, Docker networks/volumes,
a localhost SSH key in root's authorized keys, and starts its own containers.
It can install packages/Docker or change daemon settings on a different host.
On this box, Docker/packages/sshd already existed, the address pool and log
settings matched, and the installer did not need to change those services.
It does not open UFW ports. Its logs stay private in
`/var/lib/box-baseline/coolify-install.log` and `/data/coolify/source/`.
It downloads its current Compose and upgrade files from the official CDN;
the installer hash does not pin every downstream download. Review upgrades
and preserve `docker-compose.custom.yml`, which replaces upstream ports with
Compose's `!override` tag. Automatic updates are disabled.

Managed Postgres, Redis, Traefik, and Convex images are pinned by digest in the
repo. Convex's current official images use `ghcr.io/convex/*`; the older
`ghcr.io/get-convex/*` path was unavailable. Coolify installed version 4.4.6.
Reapply does not pull new image versions or rotate credentials.

## Backups and recovery

`prod-postgres-backup.timer` runs nightly at 03:15 America/New_York, with up to
10 minutes of jitter and a catch-up run after downtime. It dumps both managed
Postgres and Coolify Postgres with `pg_dumpall`, compresses them, checks them,
and keeps seven days. A lock prevents concurrent dumps. A failed dump leaves
existing backups intact. Dumps include database roles and password hashes;
keep them private. The restore proof uses a temporary RAM-backed PostgreSQL
container with no network, then removes it.

```sh
ssh box 'unset HISTFILE; systemctl list-timers prod-postgres-backup.timer'
ssh box 'unset HISTFILE; systemctl start prod-postgres-backup.service'
ssh box 'unset HISTFILE; journalctl -u prod-postgres-backup.service --no-pager -n 15'
```

This is **local recovery only**, on the same disk as the data. Thread P must
set up restic/R2 and test off-host restore before a real app moves. Include:

- Verified PostgreSQL dumps and `/srv/prod/secrets/`.
- `/srv/prod/coolify/source/.env` (especially `APP_KEY`) and Coolify SSH keys.
- Convex local file storage, Redis persistence, Compose files, and any app mounts.

Do not treat a copy of a live database directory as a database backup. Convex
files and PostgreSQL state need a consistent recovery point: use a Convex export
including file storage, or stop that backend while taking the paired snapshot.
The plain pg_dumpall restore proof covers SQL recovery; it does not prove a
full Convex file restore or a Redis restore. Before a real cutover, test both.

R2 is the target for Convex object storage. Upstream documents S3 endpoint,
credentials, and separate buckets for files, modules, exports, imports, and
search. A storage-provider change requires an export/import into a fresh backend;
setting S3 variables alone does not move local files.

## Stamp out a Convex app

Keep the template as a worked example. Do not put a real app's code or data into it.

1. Choose a unique instance name, database, role, data directory, stack directory,
   loopback API/actions/dashboard ports, and hostnames. Replace hyphens with
   underscores for the database name. Never reuse the template instance secret.
2. Copy the template Compose file and provisioning stage into a per-app stack.
   Replace container names, ports, paths, `INSTANCE_NAME`, both public origins,
   and dashboard `NEXT_PUBLIC_DEPLOYMENT_URL`. Keep `prod.slice` and digest pins.
3. Generate a separate root-only env file, instance secret, and Postgres role
   password. Create the database owned by that role on `prod-postgres`.
   `POSTGRES_URL` ends at `postgres:5432`, **without a database path**;
   Convex selects the database from `INSTANCE_NAME`. Local Postgres needs
   `DO_NOT_REQUIRE_SSL=1`. Do not use the Postgres superuser for the app.
4. Keep a persistent bind mount for `/convex/data`. Plan R2 with thread P.
   Join `prod-data`; SQL access uses the Docker network, not the host's loopback.
5. Start the stack; check its health, logs, and real PostgreSQL tables.
   Run `docker compose … exec -T backend ./generate_admin_key.sh` and redirect
   its output straight into a root-only file under `/srv/prod/secrets/`.
6. Add backend and dashboard entries to `prod-ingress.yml`; if HTTP actions or
   auth callbacks are needed, add a **third** hostname to the actions port and
   set `CONVEX_SITE_ORIGIN` to it. This template leaves actions loopback-only.
7. Add Cloudflare proxied tunnel DNS from the Mac with
   `cloudflared --config scripts/box/cloudflared-local.yml tunnel route dns tempcode-box HOSTNAME`.
   Reapply stage 60 to validate and reload ingress. A new instance does not need
   another tunnel or any firewall rule.
8. In a private build/deploy environment, set `CONVEX_SELF_HOSTED_URL` and
   `CONVEX_SELF_HOSTED_ADMIN_KEY`. Run `npx convex dev --once` or deploy,
   then call a query through the public hostname. Keep the key out of browser
   env variables; app clients need only the public backend URL.
9. Before moving existing cloud data, make a snapshot export, test import into
   this new instance, preserve IDs/auth data, check actions and subscriptions,
   and test SQL plus file recovery. Arrange cutover and rollback in that app's
   own thread. No such migration happened here.

The Mac proof uses a fresh scratch directory, the documented self-hosted env
variables, `npx convex dev --once`, TypeScript checking, and `convex run`:

```json
{"deployment":"convex-template","value":"Mac-to-box round trip passed"}
```

Its trap removes the scratch project, npm install, and generated `.env.local`.
The admin key travels through SSH into process memory, not a local file or an
argument. The deployed `proof:roundTrip` query remains in the template.

## Move one Vercel site (later threads)

This pattern is documented only; no application was created or moved here.

1. Inventory the Vercel app: git source/branch/root directory, Node version,
   build/install/start commands, server/client env variables, domains, redirects,
   cron jobs, image handling, edge functions, storage, auth callbacks, and any
   Vercel-only services. Plan replacements before changing DNS.
2. In Coolify, choose a project/environment and create an Application from its
   git source. Connect the repository with a GitHub App or deploy key. Select
   Nixpacks for a standard Next.js app, or a reviewed Dockerfile for a fixed
   build. Match the Node version and lockfile. Typical commands are `npm ci`,
   `npm run build`, and `npm run start`; use the repo's actual package manager.
   The app listens on `0.0.0.0:3000` **inside its container**, without a host port.
3. Set private runtime/build env in Coolify. Public `NEXT_PUBLIC_*` values get
   baked into the build. Replace Vercel/Convex URLs only for that app. Keep
   deploy/admin keys server-side. Configure mounts and backup paths as needed.
4. Set the Coolify domain to `http://SITE.landonhale.com` (HTTP to Traefik behind
   the tunnel) and the internal port to 3000. Ensure it joins the `coolify`
   network, uses `prod.slice`, has a health check and appropriate resource limits.
   Leave host port mappings empty and public TLS/ACME redirects off. Cloudflare
   serves HTTPS at the edge. Check forwarded scheme/trusted proxy handling so
   redirects, secure cookies, and auth callbacks use the public HTTPS URL.
5. Add this rule before the catch-all in `prod-ingress.yml`:

   ```yaml
   - hostname: SITE.landonhale.com
     service: http://127.0.0.1:80
     originRequest:
       httpHostHeader: SITE.landonhale.com
   ```

   The Host header makes Traefik select the app's Coolify router. No wildcard
   tunnel catch-all should point to Traefik. Keep the final unmatched-host 404.
6. Deploy on a new test hostname first. Add **proxied** tunnel DNS with the Mac
   command above; review an existing DNS record before replacing it. Stage 60
   validates the repo's ingress and restarts only cloudflared if it changes.
   Neither DNS nor ingress needs an inbound firewall opening.
7. Check the loopback origin with `Host: SITE.landonhale.com`, then public HTTPS,
   static assets, SSR/API routes, sign-in/out and callback URLs, cookies,
   redirects, uploads, jobs, logs, and data writes. Verify no new non-loopback
   listener and check every new container's kernel cgroup path.
8. Take and test the backup. Set a cutover window and a written rollback point.
   Move the production hostname only after the user authorizes that site's move.
   Keep Vercel and the old data source available until the app's checks pass and
   the rollback window ends. Never run competing writers without a data plan.

To import the plain managed stacks into Coolify later, use a Docker Compose
resource with the same image pins, private env values, and bind mounts. Schedule
an explicit stop/recreate so only one Postgres or Redis process opens each data
directory. Remove these stages' ownership of the imported stack in that same
change; two managers must not keep reconciling one resource.

## Verification record — 2026-10-19

- Docker cgroup proof passed with `systemd-cgls` and `/proc/<pid>/cgroup`;
  memory accounting is enabled. All nine steady-state containers are in prod.slice.
- `ss -ltnp` shows the new ports only on `127.0.0.1`. UFW remains SSH-only in
  both IP families. No sshd, user/slice, temp-code, or agents-tree change occurred.
- temp-code remains active with original MainPID 2320 and NRestarts 0.
- Coolify health and origin login return 200; its generated admin logged in
  over HTTP. Public HTTPS redirects to Cloudflare Access, whose login returns 200.
  No authenticated browser session through Access was tested.
- Public Convex backend and dashboard answer; Mac deploy, TypeScript check,
  and query passed. Managed SQL dump restored with Convex tables in isolation.
- Both complete production applies (100–190) passed with **zero changes**.
  Dispatcher ranges, SSH stdin isolation, shell syntax, secret permissions,
  and Postgres/Redis password checks passed.
- Local files remain local. R2, off-host backups, real app migrations, browser
  onboarding, and Coolify API resource adoption remain for later threads.

## Official references

- [Coolify self-hosted install and account setup](https://coolify.io/docs/start-with-self-hosted)
- [Coolify networking](https://coolify.io/docs/core/networking-in-coolify)
- [Convex self-hosting setup](https://github.com/convex/convex-backend/blob/main/self-hosted/README.md)
- [Convex PostgreSQL setup](https://github.com/convex/convex-backend/blob/main/self-hosted/advanced/postgres_or_mysql.md)
- [Convex S3/R2 storage](https://github.com/convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md)
- [Docker daemon settings](https://docs.docker.com/reference/cli/dockerd/)
