# tempcode-box

ReliableSite dedicated server, `104.194.11.2`, Ubuntu 24.04 LTS, AMD EPYC
4545P, 128 GB RAM, one 2 TB NVMe. Hostname: `tempcode-box`. Time zone:
`America/New_York`. Connect from the Mac with `ssh box` as root, using
`~/.ssh/id_ed25519`. The alias lives in `~/.ssh/config`; load its key from the
Mac Keychain with `ssh-add --apple-load-keychain` if needed.

## Apply

From the repo on the Mac:

```sh
scripts/box/apply.sh
# Resume one stage, for example:
scripts/box/apply.sh --from 30 --through 40
```

The runner checks Ubuntu 24.04 and a fresh key login, syncs scripts to
`/opt/box-baseline` with rsync, and runs numbered stages as root. On a minimal
image it first sends the access stage over SSH, applies it, and installs rsync.
Scripts report `CHANGED` or `SKIP`. They stop on errors. State markers live in
`/var/lib/box-baseline`. The first successful full upgrade runs once; daily
unattended upgrades then install Ubuntu security updates. To run another full
upgrade, use `ssh box 'apt-get update && apt-get -y full-upgrade'` during a
maintenance window. Automatic reboot is off: stage 10 and stage 75 write
`Unattended-Upgrade::Automatic-Reboot "false";` to
`/etc/apt/apt.conf.d/99-box-security`; stage 90 checks the effective APT value.
Check `/var/run/reboot-required`. To schedule a reboot, choose a maintenance
window, let active agent work finish, check backups, then run, for example,
`ssh box 'shutdown -r 02:00 "Planned maintenance"'` (02:00 New York time).
Cancel with `ssh box 'shutdown -c'`. The scripts never schedule a reboot.

Root SSH policy lives in `/etc/ssh/sshd_config.d/00-box-baseline.conf`:
`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, and
`PermitRootLogin prohibit-password`. The initial password is never part of
these scripts. Rotate it in the ReliableSite panel after this setup.

## Storage

The installer used `vg0` with a roughly 1.86 TiB root LV and a 4 GiB swap LV.
`pvs`, `vgs`, and `lvs` show **zero free extents**. `/srv/agents` and `/srv/prod`
therefore share the root ext4 filesystem; they are directories, not separate
volumes or quotas. No live root shrink or partition change was attempted.
To obtain roughly 100 GB root, 1.3 TB agents, and 500 GB production, back up
the host and reinstall through the ReliableSite panel with custom partitioning.
That reinstall is optional; the current host works with directories.

The storage script can use an existing VG with at least 1.8 TB of unused
extents for 1210 GiB and 466 GiB ext4 LVs. It never formats an occupied LV or
hides files under a new mount. A new 8 GiB `/swapfile` supplements the existing
4 GiB swap LV. `/etc/fstab` persists it; swappiness is 10.

## Users, slices, and ports

| User | Home | Access and workload placement |
| --- | --- | --- |
| root | `/root` | Key SSH, host setup, Docker administration |
| agents | `/srv/agents/home` | System user, bash, no sudo or Docker group; use `agents.slice` |
| prod | `/srv/prod/home` | System user, bash, Docker group; Docker grants root-level host control |

Both users have locked passwords, private group-owned `/srv` trees with mode
750, lingering user managers, and nofile soft/hard limits of 1048576.
The `user@UID.service` overrides put each user manager in its workload slice
and set `LimitNOFILE=1048576`. A plain `su` or root command does not move its
cgroup; services must use the correct slice explicitly.

| Slice | Settings |
| --- | --- |
| `agents.slice` | MemoryHigh=80G, MemoryMax=88G, TasksMax=6000, CPUWeight=100, IOWeight=100 |
| `prod.slice` | MemoryMin=24G, CPUWeight=400, IOWeight=400 |

MemoryMin protects allocated memory under pressure; it does not preallocate
24 GB. The users and slices share one kernel and disk.

`/etc/sysctl.d/60-box-fleet.conf` sets inotify watches 1048576, inotify
instances 8192, file-max 4194304, max_map_count 1048576, and somaxconn 4096.
PAM limits live in `/etc/security/limits.d/60-box-fleet.conf`.

UFW denies incoming and routed traffic, allows outgoing, and permits only
22/tcp in both IP families. fail2ban monitors sshd through the systemd journal
(5 failures in 10 minutes, 1 hour ban). All app origins must bind loopback and
use the Cloudflare tunnel. Port 7677 is reserved for thread C's remote listener.
No public HTTP, HTTPS, Docker API, or app port is allowed.

## Runtimes and Electron

Docker CE comes from Docker's signed apt repo. Node 22 comes from NodeSource's
signed repo. Bun uses its official installer once for root and agents, in each
user's `~/.bun`; `/etc/profile.d/box-bun.sh` sets the path for login shells.
Reapply keeps installed versions; package and Bun upgrades are separate
maintenance work. Git, gh, jq, ripgrep, compilers, Python 3, restic, rsync,
htop, ncdu, and the Ubuntu 24.04 Electron/Xvfb libraries are installed through
apt. Stage 50 checks every Electron package with `apt-cache policy` first.

`/etc/docker/daemon.json` enables live restore, json-file logs capped at three
10 MB files per container, `/srv/prod/docker` storage, and `prod.slice` as the
default container cgroup parent. The daemon also runs in `prod.slice`.
The socket stays `root:docker` mode 660. Agents cannot access it.

Docker published ports bypass UFW's INPUT chain. The Docker service therefore
runs `/usr/local/sbin/box-docker-fence` after each start. It rejects new
external forwarded connections through DOCKER-USER on default-route interfaces.
Established replies and outbound container traffic still work. Keep this hook
when thread I installs Coolify, and bind every origin to `127.0.0.1`.
See [Docker's firewall notes](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

Stage 55 installs `electron@latest` once as agents in the scratch directory
`/srv/agents/home/.local/share/box-electron-proof`, keeping its npm lockfile.
Every apply then runs both the Electron version check and the offscreen
BrowserWindow proof under Xvfb as agents in `agents.slice`. The proof loads
`about:blank`, captures a nonempty PNG as `screenshot.png`, and exits 0.
`scripts/box/electron-proof.cjs` contains the proof.

Ubuntu 24.04 restricts unprivileged user namespaces. The profile
`/etc/apparmor.d/box-electron-proof` grants `userns` to that one Electron
executable. The renderer uses its sandbox; no `--no-sandbox` or global sysctl
relaxation is used. Thread C must install a matching profile for its own
Electron executable path. See [Ubuntu's AppArmor docs](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

## Cloudflare tunnel

Tunnel `tempcode-box` has ID `8ec0ebc3-db38-44f7-8193-19b9be6e08b6`.
The Mac's origin certificate stays on the Mac. Only this tunnel's credentials
JSON is copied to `/etc/cloudflared/`, root-only mode 600, in a mode 700
directory. The Mac's existing config and other tunnel files stay untouched.
`tunnel.sh` uses a temporary empty config for its own commands and refuses to
recreate a tunnel if its credentials are missing.

Cloudflared comes from Cloudflare's signed apt repo and runs as a systemd
service. `/etc/cloudflared/config.yml` maps `tempcode.landonhale.com` to
`http://127.0.0.1:7677`, then returns 404 for unmatched hosts. Metrics bind only
to `127.0.0.1:20241`. The connector opens outbound connections; UFW needs no
extra inbound rule. Until thread C starts the listener, HTTPS returns the
expected Cloudflare 502.

To add a production hostname:

1. Add a hostname and its loopback origin to `scripts/box/ingress.yml`, before
   the final `http_status:404` entry. Commit the edit.
2. On the Mac, run `cloudflared --config scripts/box/cloudflared-local.yml tunnel route dns tempcode-box SITE.landonhale.com`.
3. Run `scripts/box/apply.sh --from 60 --through 60`. It validates ingress and
   restarts the connector only when its config changes.
4. Check `cloudflared --config scripts/box/cloudflared-local.yml tunnel info tempcode-box`, the local origin, and HTTPS.

Do not edit only the server config: a reapply will restore the repo version.
Do not copy the origin certificate or another tunnel's JSON to the box.
The explicit CLI config matters: this Mac's default config selects `devspace`
even when a different tunnel name follows `info`. The clean config avoids
that override without editing the Mac's config.
See [Cloudflare's local tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).

## Push to the phone: the APNs key on the box

The box posts to Apple itself (the hub cannot: Cloudflare's fetch speaks
HTTP/1.1 and APNs refuses it). The key is `/etc/temp-code/apns/AuthKey_<id>.p8`
(root:agents, 640, the directory 750) and `/etc/temp-code.secrets.env` names it:

```sh
TEMP_CODE_APNS_KEY_PATH=/etc/temp-code/apns/AuthKey_<id>.p8
TEMP_CODE_APNS_KEY_ID=<10 chars>
TEMP_CODE_APNS_TEAM_ID=<10 chars>
```

The same file carries `TEMP_CODE_HUB_URL`, `TEMP_CODE_HUB_HOST_ID` and
`TEMP_CODE_HUB_TOKEN` (since 2026-10-20 the app's own heartbeat reaches the
hub; the scaffold timer may stay). The key the owner issued is Production-only,
so the phone runs the Ad Hoc build and registers a production token; a Debug
build's sandbox token would be refused by this key. Rotating the key: put the
new .p8 beside the old one, change the three lines, restart the service, and
revoke the old key in the developer account. Never copy the key anywhere else.

## Backups (live since 2026-10-19)

Restic, to the Cloudflare R2 bucket `tempcode-backups` (account
landonhale123@gmail.com), two repositories: `box` for this machine and `mac`
for the Mac. One restic password covers both; it lives in the Mac login
Keychain as `tempcode-restic` (account `landon`) and on the box in
`/etc/restic/password`. The bucket-scoped R2 key is Keychain item
`tempcode-r2-backups` (account = access key id, password = secret) and
`/etc/restic/box.env`. Losing the password loses every backup; the R2 key
alone cannot read them.

- `box-backup.timer` runs `/usr/local/sbin/box-backup` (scripts/box/
  restic-backup.sh) daily at 04:15 New York plus up to 20 minutes, in
  prod.slice. It snapshots every `*.db` in `/srv/agents/temp-code-data` with
  `VACUUM INTO` as the agents user into `/srv/agents/backups/sqlite` (the live
  database files are excluded; a mid-write copy is worthless), writes a
  `manifest.json` alongside them with a generation id, schema counts and all
  table counts, backs up `/srv/agents`, `/srv/prod` and `/etc` with `/etc/restic/excludes`, keeps
  7 daily / 4 weekly / 6 monthly, prunes, and runs `restic check`.
- Postgres dumps come from `prod-postgres-backup.timer` (03:20) into
  `/srv/prod/backups/postgres`; the restic run picks them up.
- A failed run fires `box-backup-failed.service`, which POSTs a `failed`
  notification to the hub with the heartbeat token.
- Check: `systemctl list-timers box-backup.timer`,
  `journalctl -u box-backup.service`, and as root
  `set -a; source /etc/restic/box.env; set +a; restic snapshots`.
- `box-restore-drill.timer` runs Sundays at 06:00 New York, after the daily
  backup's 04:15 start and 20-minute jitter. `After=box-backup.service` and a
  shared lock wait for a backup still running at 06:00. It restores only the
  latest daily SQLite snapshots from R2 into a private scratch directory under
  `/srv/agents/backups`, runs `PRAGMA quick_check`, and compares both the
  `sqlite_master` row count and all user-table row counts against the
  `manifest.json` restored from that same uploaded snapshot. The backup
  uploads this manifest with its databases. A failed upload can leave a newer
  local generation; the drill never compares against that local dir. Missing
  files, a missing manifest or a mismatch fail the drill. After installing
  this format, upload one new daily backup before running the drill. An EXIT
  trap removes scratch data on success or failure. It never restores over live data.
- `box-restic-check.timer` runs on the first of each month at 08:00 New York:
  `restic check --read-data-subset=5%`. Daily checks still check metadata.
  Restic chooses a random 5% sample; this does not promise full coverage in
  twenty runs. See [restic's check guide](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency).
- Both timers are persistent and enabled by `75-backup-maintenance.sh`.
  Their services run in `agents.slice`, share the backup lock, and fire
  sibling failure units through the existing hub notification script. The
  event is `failed`, with title `Box restore drill failed` or
  `Box monthly restic check failed`. Check or run them now:

```sh
scripts/box/apply.sh --from 75 --through 75
ssh box 'systemctl start box-restore-drill.service'
ssh box 'journalctl -u box-restore-drill.service -n 20 --no-pager'
ssh box 'systemctl start box-restic-check.service'
ssh box 'systemctl list-timers box-restore-drill.timer box-restic-check.timer'
```

The Mac side is scripts/mac/backup.sh installed by scripts/mac/install-backup.sh
as the launchd agent `dev.landon.tempcode.backup` (03:30 daily, log in
`~/Library/Logs/tempcode-backup.log`): same snapshot step over
`~/Library/Application Support/temp-code`, including `checkpoints/`.

## Heartbeat scaffold (initial install; live state below)

`/usr/local/bin/box-heartbeat` sends a small JSON POST containing hostname and
UTC time. `box-heartbeat.timer` is installed but disabled; no hub request was
sent. When the hub ships, copy `/etc/box-heartbeat.env.example` to
`/etc/box-heartbeat.env`, mode 600, fill in its HTTPS URL and bearer token, and
run `systemctl start box-heartbeat.service`. Check the hub and
`journalctl -u box-heartbeat.service`, then enable the timer with
`systemctl enable --now box-heartbeat.timer`. The hub must accept the documented
`host` and `time` fields or the script must change to match it. It runs once per
minute, with up to 10 seconds of jitter. Reapply preserves the live env file.

## Next threads

- **C — temp-code under Xvfb:** done; see "temp-code service" below.
- **U — launcher:** done; use `box-update`, described in "Updating" below.
  Builds, trials and the service run as agents in `agents.slice`. SQLite
  snapshots, weekly restore drills and monthly data checks are installed.
- **I — Coolify:** use prod and Docker, `/srv/prod`, and `prod.slice`.
  Keep the Docker cgroup parent, log limits, socket permissions, and inbound
  fence. Route dashboard and sites through the tunnel to loopback origins;
  do not open 80/443 or dashboard ports. Add hostname entries to the repo file.
  Supply database and named-volume backups before enabling the restic timer.

## Verification

Run `scripts/box/verify.sh` from the Mac for key/password checks, remote host
checks, the Cloudflare connector count, and HTTPS. Run the full apply to repeat
the Electron screenshot proof. `scripts/box/smoke-docker.sh` uses a temporary
nginx container on port 18080 to test loopback access, its production cgroup,
and the inbound firewall from the Mac; its exit trap removes that container.
The test never adds a UFW rule. The downloaded test image may remain cached.

Baseline checks on 2026-10-19, before the app and backups went live:

| Check | Result |
| --- | --- |
| OS and hardware | Ubuntu 24.04, EPYC 4545P, 16 cores / 32 threads, 123 GiB usable RAM |
| Upgrade and reboot | Full upgrade complete; rebooted into `6.8.0-147-generic`; no failed units |
| SSH | Fresh key login passes; password-only attempt refused with only publickey offered |
| Host services | Docker, cloudflared, fail2ban, UFW and unattended-upgrades enabled and active after reboot |
| Firewall | Only 22/tcp, IPv4 and IPv6; Docker's temporary published port blocked from the Mac |
| Fences | Both slices and weights match; lingering user managers in their slices; login nofile 1048576/1048576 |
| Storage | Directory fallback; no free extents; 8 GiB swapfile plus existing 4 GiB swap LV; swappiness 10 |
| Runtimes | Docker 29.9.1; Node 22.23.3; Bun 1.4.3 for root and agents |
| Docker access | Agents cannot read/write socket; prod can use Docker; test container uses `prod.slice` |
| Electron | 44.9.0 as uid 999 (agents), sandbox enabled, Xvfb, 800×600 PNG (2727 bytes), exit 0 |
| Tunnel | One linux_amd64 connector from 104.194.11.2, four edge connections; Cloudflare 502 as expected |
| Mac Cloudflare files | Hashes of all pre-existing files unchanged |
| Scaffolds | Both timers loaded, disabled and inactive; no live env files or secrets created |

The second full `scripts/box/apply.sh` completed with **zero changes and zero
errors** after the maintenance reboot. Shell syntax checks, the Electron proof,
host checks, Mac SSH checks, connector count, HTTPS, and the Docker ingress
smoke test passed. The commits were made in the `box-baseline` worktree, rebased
on current master, then fast-forward merged into the project checkout. This
runbook's final result was committed on master. No remote repartition, Pro
attachment, R2 upload, or hub POST occurred.

## User steps

- Rotate the root password in the ReliableSite panel.
## Ubuntu Pro

This box does not need `ubuntu-pro` attached to run temp-code. Ubuntu 24.04's
standard Main security support lasts until May 2029; Pro adds Canonical's
Universe security coverage and Livepatch, which can reduce kernel reboots.
Those may help this host, but Pro does not cover the Bun/npm app dependencies
or replace planned reboots and backups. The host remains unattached; no token
was supplied. Revisit it if broader package coverage or compliance becomes a
need. See [Ubuntu's support dates](https://ubuntu.com/about/release-cycle) and
[Pro's services](https://ubuntu.com/pro/docs/services-overview/).

## Heartbeat (live since 2026-10-19)

`box-heartbeat.timer` is enabled and posts to https://hub.landonhale.com/v1/hosts/box/heartbeat every minute with the hub's body shape (environmentId, name, version, startedAt). The token is in `/etc/box-heartbeat.env` (root, 600) and in the Mac Keychain as `tempcode-hub-host-box`. Check: `curl -s https://hub.landonhale.com/v1/hosts -H "x-api-key: $(security find-generic-password -a landon -s tempcode-hub-ADMIN_KEY -w)"`.

## temp-code service (live since 2026-10-19)

The host runs temp-code itself, headless, from a git checkout: no window, no
menu, no updater, but the server, the gateway, the fixed-port listener and
html preview's hidden window all run as on a Mac. `TEMP_CODE_HEADLESS=1`
selects that mode (src/main/headless.ts); a Linux process with no display
gets it on its own.

| Piece | Where |
| --- | --- |
| Builds | `/srv/agents/temp-code-builds/<sha>-<UTC time>-<suffix>`, owned by agents, detached at the deployed commit |
| Active and rollback links | `/srv/agents/temp-code-builds/current` and `previous`; their parent directory is root-owned |
| Original v235 checkout | `/srv/agents/temp-code`, retained while a release link points at it |
| Data (database, environment.json, tls, server.json) | `/srv/agents/temp-code-data`, mode 700 |
| Unit | `/etc/systemd/system/temp-code.service`: `User=agents`, `Slice=agents.slice`, `Restart=always`, `LimitNOFILE=1048576` |
| ExecStart | `/usr/local/lib/temp-code/run`, with `WorkingDirectory=/srv/agents/temp-code-builds/current`; `env -u ELECTRON_RUN_AS_NODE xvfb-run -a … dbus-run-session -- node_modules/electron/dist/electron .` |
| Environment | `/etc/temp-code.env` (root, 600, managed): `TEMP_CODE_USER_DATA=/srv/agents/temp-code-data`, `TEMP_CODE_HEADLESS=1`, `TEMP_CODE_CLAIM_SHIM=1`, `AGENT_CLI_CREDENTIAL_STORE=file`, `TEMP_CODE_REMOTE_PORT=7677`, `NODE_ENV=production`, `SHELL=/bin/bash` |
| Secrets | `/etc/temp-code.secrets.env` (root, 600, optional, never written by the scripts); the unit reads it when present |
| AppArmor | `/etc/apparmor.d/temp-code` grants userns to Electron in the original checkout and each release build; the renderer keeps its sandbox |
| Local admin | `tc-local <method> [json]` or `tc-local --hello` (`/usr/local/bin`, runs the installed copy of `scripts/box/tc-local.mjs`) over the port in `<data>/server.json` |
| Logs | `journalctl -u temp-code` |

Stage `85-temp-code.sh` installs the launcher, runner, local client, unit,
AppArmor profile and sudo rule. Reapplying it never starts or restarts the
service. `box-update` owns deployment and the first service start. Builds and
trials use transient units with `User=agents`, `Slice=agents.slice`; no build,
package script or app runs as root. Root changes links and restarts only
`temp-code.service`.

Why the private bus: handed the agents user's session bus, Chromium registers
with that user's systemd and moves the main process into
`app-org.chromium.Chromium-<pid>.scope`, out of the unit's cgroup and beyond
`systemctl stop`; its lines then leave `journalctl -u` too. `dbus-run-session`
gives it a bus with no systemd on it.

The CLIs the drivers spawn are installed as agents, with no account signed
in: `claude` from the official installer (`~/.local/bin`), `codex` from npm
(`~/.npm-global/bin`, 0.162.1 or newer), `cursor-agent` from Cursor's installer
(`~/.local/bin`), `gh` from apt. The host resolves them over the login shell's
PATH, so `~/.profile` must keep adding `~/.local/bin`. Versions on
2026-10-19: Electron 39.8.10, Node 22.23.3, Bun 1.4.3, claude 2.1.303,
codex 0.163.0, cursor-agent 2026.10.16, gh 2.45.0. Rerunning the stage
upgrades codex when it is below the floor; the others self-update.

Remote access: `remote.publicOrigin` is `https://tempcode.landonhale.com`.
Cloudflare Access fronts `/ui` only; `/healthz`, `/api/*`, `/pair` and `/ws`
reach the listener directly, and every one of those routes carries its own
authentication. To let a device in, mint a pairing on the box and open its
link within ten minutes:

```sh
tc-local remote.pairings.create '{"name":"Landon phone","audience":"client","caps":["operate","approve"]}'
```

Proof from the Mac: `bun scripts/e2e-box-remote.ts`. It mints two read-only
pairings over key SSH without printing their codes, checks HTTP hello, bearer
and cookie sockets (including contract), Chrome's `/pair` flow, the Secure
cookie and the Access gate on `/ui`, then revokes its test credentials. For
another origin, supply `TC_ORIGIN` and two `TC_PAIR_CODES` explicitly. The
gateway's own proofs run on the box against fake upstreams:
`bun run script:e2e-gateway-unauthorized` and `script:e2e-gateway-failover`
in the checkout as agents. The hidden preview window is proven with
`tc-local app.htmlPreview` against a live session (see the log entry).

### Accounts: sign in on the Mac once

Provider accounts never sign in on the box. The Mac's Accounts page is the
one place a Claude or Codex sign-in happens, and the box gets what it needs
over the Mac's admin link to it (thread V; aliax-core `src/sync.ts`,
temp-code `src/main/server/remote/{peers,accountSync}.ts`):

- Every saved account has one owner, the environment that refreshes its
  grant. A refresh token rotates on every use at both providers and the
  rotation revokes its predecessor, so a grant can have exactly one
  refresher; every other host holds an access-only copy that follows the
  owner's pushes (`accounts.push`, `accounts.pull`, both admin-only on the
  remote wire) and asks the owner for a fresh one near its end. A copy whose
  owner is unreachable runs out, and the Accounts page says so on the row.
- **Every Claude account is a one-year token, held by every host (T1).** A
  one-year token is what `claude setup-token` makes: the Claude CLI (2.1.301,
  read off its binary) runs the ordinary OAuth code exchange for the Claude
  Code client and adds `expires_in: 31536000` to the token-exchange body;
  nothing in the consent URL differs but the scope (`user:inference` alone
  for the CLI's setup-token). The same field rides a refresh_token grant
  (`claude auth login` with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` mints a
  one-year token that way, no browser), and both grants answer with
  `account` (uuid, email) and `organization`, so the token names its own
  account. temp-code mints in-app (aliax-core `src/mint.ts`, temp-code
  `src/main/aliax/{staticMint,staticTokens}.ts`), one account at a time:
  first through the refresh grant the Mac holds (`user:profile
  user:inference` asked for, so the token can read usage and name itself;
  `user:inference` alone when the server grants that pair only hours), and
  otherwise through the account's stored claude.ai session in a hidden
  window, where the consent page approves without a sign-in. The token is
  filed only under the account the response names (a mismatch is refused by
  name, nothing filed), and the refresh grant is dropped only after the
  token is verified and saved; a refusal leaves the account a healthy owned
  profile holding the rotated grant. "Convert all to one-year tokens" on the
  Claude panel walks every account not yet converted (and every token inside
  its last 30 days), each row showing its progress; a row whose session has
  lapsed opens the ordinary in-app sign-in with the address pre-filled. An
  account whose grant the box refreshes (handed over before the conversion)
  is taken back first over the Mac's link, the same takeOver pull as moving
  Refreshed by to the Mac (provisional landing, confirm, the box strips),
  and minted from the grant; with the box out of reach the stored session
  and the sign-in window mint instead, and the row names the box when those
  fail too. The box has no page to convert on, so nothing ever says to
  convert it there. The
  row menu keeps the single-account action. Renewal needs no clicks: on
  boot and every six hours each token inside its last 30 days is minted
  again through its stored session (once a day at most while that fails);
  when the session is gone the row says "Sign in to renew its one-year
  token" and the footer says the same for the account it shows. A token with
  `user:profile` reports usage and its plan like any account; one minted
  with `user:inference` alone says "usage is not reported" and is never
  taken for a sign-out. Static profiles are pushed to every admin host with
  no owner (the box's access copies of the former grants become the static
  tokens); the first static token the box receives becomes its live Claude
  sign-in (`~/.claude/.credentials.json` for agents) when nothing is live
  there, and a renewed token of the account that is live replaces the older
  one (`accountSync.ts activateIfNothingLive`), so the box follows renewals
  with no sign-in of its own. The host that mints a token for the account
  its own CLI is signed in with installs that token as its live sign-in at
  once (the refresh route rotates the grant the CLI holds, and the CLI's
  next refresh of the old one is refused), and a lapsed live sign-in whose
  account holds a static token is repaired at boot and every six hours
  (`staticTokens.ts repairLive`). The Aliax app shows a static row's lapse and
  never refreshes it; renewing is temp-code's.
- **Codex is owned by the box.** Set "Refreshed by: box" on the Codex panel,
  then Add account: the fresh grant is handed to the box, becomes the box's
  live `~/.codex/auth.json`, and the Mac keeps an access-only copy that the
  box pushes on every rotation. The Mac's own terminal Codex keeps the grant
  it had; a grant the CLI here is signed in with (the refresh token in
  `auth.json`, the same check Claude's Keychain item gets) is never handed
  off, and Cursor's never is, since its IDE keeps its own tokens.
- **A handoff is two-phase, and the grant has one refresher throughout.**
  The sender exports under the profile's lock (aliax-core `src/lock.ts`, the
  one its token refresh holds too, so a refresh in flight finishes first and
  the handoff carries the rotated token); the receiver saves the grant
  provisionally (the row still names the sender, so nothing there refreshes
  it) and answers with a digest of the refresh token it saved; the sender
  strips its own copy only on an answer that echoes what it sent, then
  `accounts.released` makes the receiver the owner. An older handoff onto a
  host with no refresh token is refused as stale. A lost answer leaves the
  sender refreshing and the receiver with an inert copy; a lost notice
  leaves the receiver inert; the next sync settles both (`accounts.confirm`
  from the holder of a provisional copy, `accounts.released` told again).
- Moving "Refreshed by" back to the Mac takes the grants back the same way:
  the pull with `takeOver` hands the grant out under the lock and the box
  keeps refreshing it until the Mac's `accounts.confirm` arrives with the
  digest (30 s, else the box keeps it); the Mac's copy stays provisional
  until then.
- **A host accepts account state only for accounts it already has.** What
  the box sends the Mac unasked (an `account` rotation push) or in answer to
  a pull lands only on a row already on file, matched by account id or
  email, and only from the owner it names; a peer cannot plant an account.
  A new account reaches a host only over `accounts.push` from a holder of
  its admin key (the Mac, to the box). A re-pair that kept the routes but
  changed the key rebuilds the Mac's link (remote/peers.ts), so sync comes
  back after a revoked key.
  The Mac's main process keeps one socket per admin host (backoff to 5 min)
  and syncs on connect, on every local vault write, and every 15 minutes;
  `accounts.sync` and the row's Retry do it now. The box's own vault is
  `/srv/agents/home/.config/aliax/` in key-file mode.

Proof without a real account: `bun run script:e2e-accounts-sync` (two
isolated instances, a fake provider, a handoff, a rotation, the owner down)
and `bun run script:e2e-static-tokens` (three accounts converted through
their grants, one of them falling back to `user:inference`, the usage poll
on both kinds of token, a renewal through the stored session against the
fake consent page, a lapsed session marked needs-sign-in, and the peer's
live sign-in following the renewal; the CLI's credentials live in a file
inside each instance's data through `ALIAX_CREDENTIAL_BACKEND=file` and
`CLAUDE_CONFIG_DIR`, so the Keychain is never touched).

GitHub is the one sign-in done on the box itself, once, as agents:

```sh
ssh box
runuser -u agents -- env HOME=/srv/agents/home PATH=/srv/agents/home/.local/bin:/srv/agents/home/.npm-global/bin:/usr/bin:/bin bash -l
gh auth login --hostname github.com --git-protocol https --web -s workflow
                     # prints a one-time code; enter it at github.com/login/device on the Mac
gh auth setup-git    # git asks gh for HTTPS clones and pushes; no SSH deploy key
git config --global user.name LandonDev
git config --global user.email 71577782+LandonDev@users.noreply.github.com
git config --global commit.gpgsign false
```

The token sits in `~/.config/gh/hosts.yml` (agents, mode 600) with the scopes
repo, read:org, gist and workflow; `gh auth status` checks it and
`gh auth logout` removes it. The host's inbox and PR tools (the `github.*`
RPCs) run the same `gh`, so they need nothing more:
`tc-local github.inboxRefresh '{"reason":"manual"}'` answers
`auth.state: "ok"`, and the inbox polls only the repos of workspaces that have
a GitHub remote. Agent commits carry no AI attribution trailers.

### Harness config: synced from the Mac

The skills, slash commands, agents, settings and plugins the user set up for
Claude Code and Codex live on the Mac, and the Mac's main process mirrors
them onto the box over the same admin link the accounts use
(`src/main/server/remote/{harnessSet,harnessSync}.ts`). The Mac's copy wins;
the box never sends back. Nothing to do on the box: a headless host only
receives (`harness.sync.enabled` defaults to off there, on for a desktop).

The set, relative to each HOME:

- `.claude/skills/**` except `.claude/skills/synced/**` (the CLI's own
  account-synced bucket: each side keeps its own)
- `.claude/commands/**`, `.claude/agents/**`, `.claude/settings.json`
- `.claude/plugins/**` except `.claude/plugins/synced/**` and
  `plugin-directory-cache*.json` (the CLI rebuilds it per host)
- `enabledPlugins` and `mcpServers` of `~/.claude.json`, merged into the
  box's own file; every other key (`oauthAccount`, `projects`, …) stays as
  the box has it
- `.codex/skills/**` except `.codex/skills/.system/**`, `.codex/prompts/**`,
  `.codex/config.toml`
- `.agents/skills/**`

Never, whatever the rules say (checked when the manifest is built and again
on landing, and in the tests): `.credentials.json`, `auth.json`,
`settings.local.json`, `.claude.json` as a file, `*.pem`, `*.key`, `*.p8`,
`*.p12`, `*.pfx`. Also left out: any `.git` dir (a marketplace clone lands as
a plain tree), `.DS_Store`, and files over 16 MiB. A symlink on the Mac (a
skill linked in from a checkout) is followed when its target is inside the
Mac's HOME and outside `.ssh`, `.gnupg`, `.aws` and the like; the box gets
the content.

When: on link-up, about two seconds after a change under the set (a watch on
each rule root), and every 15 minutes. The Mac sends a manifest (path, size,
sha256, mode, mtime); the box answers what it needs (new, changed on the Mac,
edited on the box since it landed, or landed under an older path map) and what
it will delete (only files an earlier sync landed: a file made on the box
stays); the files come over as 2 MiB chunks staged under
`<userData>/harness-sync`, and the commit checks every hash, then renames each
file into place. `<userData>/harness-sync/ledger.json` records what landed.

Path translation, for `.md`, `.json`, `.toml`, `.sh` and `.mjs` files under
1 MB (anything else is copied byte for byte): the Mac's
`~/IdeaProjects/<X>` and `~/Desktop/Websites/<X>` become
`/srv/agents/work/<X>` (the box's work root), the Mac's home becomes
`/srv/agents/home`, and the box's `harness.sync.pathMap` setting (default:
`scripts/box/history-map.json`, set with `tc-local harness.settings.set
'{"pathMap":{…}}'`, `null` for the default) adds its roots and prefixes. The
Mac's home comes from its manifest. Hooks in `settings.json` that call
macOS-only tools just fail here; each landing of `settings.json` logs one
`[harness-sync]` line naming the hook executables not on the box's PATH.

Status: Settings → Remote access on the Mac has a Harness config section, one
row per host: `Harness config: 143 files, synced 2m ago`, `never synced`, or
the last error, with Sync now (`harness.status` and `harness.sync` on the
Mac's own socket). On the box, the `[harness-sync]` lines in the service's
journal say what landed. Proof:
`bun run script:e2e-harness-sync` (two headless instances with their own
HOMEs, paired over the fixed port; runs on the box under `xvfb-run`).

### Attachments on a remote thread

A file attached on the Mac (picked, dropped, pasted, an appshot) lives on
the Mac's disk or only in the renderer's memory; a thread on the box cannot
read either. Each composer attachment records the host its path is on
(`environmentId`, `src/renderer/src/lib/session.ts`), and when that is not
the thread's host, or the bytes are only in memory (a paste over the 20 MB
inline size), Send uploads it to the thread's host first
(`src/renderer/src/lib/attachmentUpload.ts`): `attachment.begin
{sessionId,name,size,mime,sha256}` → `attachment.chunk {uploadId,index,
dataBase64}` × n, 2 MiB raw each, strictly in order, each awaited before the
next (the backpressure) → `attachment.commit {uploadId}`, which answers
`{path,name,mime,kind,size}`; the turn carries that path. The bytes come from
the kept Blob, or from the origin host in ranges (`attachment.digest`,
`attachment.readRange`, read capability, path-fenced for a remote caller). A
file already on the thread's host is still sent by path. Small pasted images
keep riding `attachment.save` inline. While an upload runs the text and chips
stay in the composer with a bar on each chip; a failure marks the chip and
says why above the field (never a failed turn), and a retry does not send the
files that already landed. Contract: `src/shared/contract-attachments.ts`
(begin, chunk, commit, abort need operate; the phone's Swift contract has them).

Where they land (`src/main/server/attachmentDir.ts`, `attachmentDir(session)`,
which the Mac bridge's `mac.fetchFile` shares): `<project
cwd>/.temp-code/attachments/<sessionId>/` (git-excluded with the rest of
`.temp-code/`), else the workspace path's `.temp-code/attachments/<sessionId>/`,
else `<userData>/attachments/<sessionId>/` (a draft the host has not seen yet,
a floating chat; that root is in `managedRoots()`). The store
(`attachmentUploads.ts`) writes a hidden `.upload-<id>.part` in that dir,
appends and hashes each chunk, and on commit checks size and sha256 and
renames it to the sanitized name (last path segment, letters, digits, `_ . -`,
no leading dot, 120 chars; `name-1.ext` on a collision). An upload with no
chunk for 10 minutes is dropped with its partial; an upload belongs to the key
that began it.

Limit: `attachment.maxBytes` in the host's settings table, default 200 MB per
file, read with `attachment.settings` and set with `attachment.settings.set
{maxBytes}` (admin; null for the default). The composer checks a file it will
copy against the thread host's limit when it is attached and says so; begin
refuses it too. Settings → Remote access edits this machine's limit; on the
box: `tc-local attachment.settings.set '{"maxBytes":524288000}'`.

Fence: for a remote caller, every `session.send` and `queue.add` attachment
path (an appshot's `textPath` too; `kind: 'thread'` references are not files)
must sit under the managed roots or `attachment.save`'s paste dir
(`~/.temp-code/attachments`), so a Mac path sent to the box answers
`forbidden: session.send is outside app-managed roots` at once.

Retention: deleting a thread (or its project or workspace) removes its
attachment directories. The hourly archive sweep removes the directory of a
thread archived more than 30 days ago (its transcript then shows the file
chips without thumbnails; unarchiving does not bring them back) and any
directory under an attachments root that no thread owns once it is a day old.

Proof: `bun run script:e2e-attachments` (two headless instances under
`xvfb-run`: a 5 MiB file read off one in ranges crosses to the other's
remote socket under an operate key and lands byte for byte, the fence passes
the landed path and refuses a Mac path, an idle upload expires with
`TEMP_CODE_ATTACHMENT_TTL_MS`, a delete sweeps the dir); unit tests in
`attachmentUploads.test.ts`, `fence.test.ts` and
`src/renderer/src/lib/attachmentUpload.test.ts`.
### Moving a thread between hosts

One thread (with its subagents) moves Mac ↔ box from the desktop: the chip at
the right of the thread header names the host it runs on (status dot), and
its menu has **Move to box…** on a Mac thread or **Move to This Mac…** on a
box thread. The item is disabled with its reason while the thread (or any
subagent) is working, paused, waiting on an approval or has queued messages,
while either link is down, or when the saved key is not admin. Rows in the
sidebar carry a small host badge once the window talks to two or more hosts.
While a move runs the chip says `Moving to box…`; the result is a toast.

Only the Mac starts a move, because only the Mac dials (the peer link of
`remote/peers.ts`). `session.move {sessionId, to, from?}` is local-only on the
Mac's own socket; it then speaks admin RPCs to the box
(`src/shared/contract-session-move.ts`; `src/main/server/sessionMove.ts` is the
data, `src/main/server/remote/sessionMover.ts` the protocol):

- Mac → box, a push: the Mac freezes the subtree (`sessions.moving_to`: no
  send, no queue, no harness), sends `session.import.begin` with the
  manifest, every part with `session.import.part`, then
  `session.import.commit {digest}`; the box echoes its own digest, the Mac
  keeps a tombstone, then `session.import.release` makes the box's copy the
  thread.
- box → Mac, a pull: `session.export.begin` freezes it on the box and
  answers the manifest; the Mac pulls every `session.export.part`, lands it,
  and sends the digest to `session.export.commit`, on which the box keeps the
  tombstone; the Mac then claims its landing.

What crosses: the sessions rows of the root and every descendant by
`parent_id`, their event rows from both tiers (they land hot; seqs are kept,
so a client resumes with `afterSeq`), their `session_folds`, their agent pages
(`<userData>/html-renders/<id>/`), and the harness transcript: Claude's
`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug(cwd)>/<native id>.jsonl` and
its `<native id>/` dir (they land under the slug of the remapped cwd), Codex's
`<CODEX_HOME or ~/.codex>/sessions/**/rollout-*-<native id>.jsonl` (lands as
is). A transcript the source cannot find lands as a thread with no native id:
its next send replays the dialogue (`lostNativeHandoff`). Parts are event rows
in seq ranges of at most 2 MiB of JSON (a single larger row travels alone) and
files in 2 MiB chunks; every frame carries the running digest of the bundle
(a hash chain over each part's bytes), so a corrupted part is refused on
arrival and the commit compares one value.

What does not cross: checkpoints (baselines of the source's tree; the toast
says "Undo history stayed on This Mac"), and uncommitted changes in the
working tree. The source lists `git status --porcelain` of the thread's cwd
and the toast names what stayed; commit and push before moving to carry it.
No patch is carried. Event payloads keep the paths they recorded, as in the
history move.

Landing: the receiver remaps the cwd and an absolute `plan_path` through
pathMap.ts with its own `harness.sync.pathMap` (default
`scripts/box/history-map.json`) in either direction, plus the sender's home
and work root from the manifest (`~/IdeaProjects/<X>` and
`~/Desktop/Websites/<X>` against the work root, home against home); the first
candidate that exists wins. It resolves its own workspace at the remapped
workspace path (else the deepest workspace holding the cwd) and the project
whose cwd matches (else the thread lands loose in that workspace). It refuses,
and the source thaws untouched, when no workspace holds the cwd ("add the
workspace there first"), when the remapped cwd does not exist there, or when
it already holds the thread live. The landing is written at once but hidden
(`moving_from`); `session.list` and every lookup skip it until release.

The source keeps a tombstone: its `sessions` rows with `moved_to = <host>` and
`archived = 1`, hidden like a landing; its events, folds and pages go, its
checkpoints stay. Clients of the source hear `session-moved {id, sessionIds,
to}` and then `session-removed`; the desktop re-points an open tab to the new
host and resubscribes there, and a removal from one host never drops the copy
another host holds. A thread can move back and forth; a tombstone gives way
to a later landing of the same id.

Half-done moves settle on every link-up (the account handoff's shape): a
landing whose source is still live is dropped, a landing whose source is a
tombstone is claimed, and a freeze nobody finished lifts. A freeze never
outlives the process that set it (it lifts at boot), and an export or a
landing nobody touched for 10 minutes is let go.

Proof: `bun run script:e2e-session-move` (two headless instances with their
own HOMEs, Claude config dirs and Codex homes, paired over the fixed port; a
seeded thread with a subagent in the cold file, a fold, a page and both
transcripts moves Mac → box, back, and out again). Unit tests:
`src/main/server/sessionMove.test.ts` (both directions on temp databases,
remap, tombstones, refusals, a corrupted part, the settle rules) and the
renderer's `lib/tcserver/store.test.ts` and `lib/threadMove.test.ts`.
### The Mac bridge: what a box thread may touch on the Mac

Threads run on the box; the user and their files are on the Mac, and some
tools (`xcodebuild`, `osascript`, `open`, `security`) exist only there. A box
thread with the bridge on gets four tools: `mac_read_file`, `mac_list_dir`,
`mac_fetch_file` (copies the file onto the box and answers the box path) and
`mac_run`. The Mac decides every call; the box only carries it.

Transport (`src/main/server/remote/peerCalls.ts`). The box cannot dial the
Mac (the Mac's listener is loopback, behind no tunnel), so the box asks over
the peer link the Mac's main process already holds open to it with an admin
key. On link-up the Mac sends `peer.register {from, offers: ['mac-bridge']}`
and the box records that socket as the Mac's. The box asks with a push
`{push: 'peer.call', callId, method, params, deadlineMs}`; the Mac answers
`peer.reply {callId, ok, result | error}`, taken only from the socket the call
went out on. A reply over 2 MiB of JSON first crosses as `peer.chunk` frames,
each acknowledged. Each call has its own deadline: the Mac's 10-minute wait
for a person, plus a command's timeout, plus 30 s. When the socket closes its
calls fail at once and the thread's tool answers `Mac offline`.

On the box (`src/main/server/macTools.ts`). The bridge is per thread: the
setting `macBridge.thread.<sessionId>` names the Mac's environment id, and a
subagent inherits its parent's. It is set when the Mac's renderer creates a
thread on the box while the Mac's policy for the box is not off, or from the
thread menu ("Mac bridge"; `macBridge.thread.set` needs approve, since it lets
a thread act without a box prompt). A change restarts the thread's harness
once it is idle, so the tools come and go with it. Claude reaches the tools
in-process (`mcpServers.mac`, allowed without a box prompt: the Mac asks for
itself); Codex reaches them through `scripts/app-mcp-bridge.mjs`, which lists
them only when `TEMP_CODE_MAC_TOKEN` is in its environment. The `mac.*`
methods are local-only, and because the loopback socket is unauthenticated
each call carries that token: an HMAC of the session id under a key made at
boot, given only to that thread's bridge, so one thread cannot call as
another. A fetched file lands in `<project>/.temp-code/attachments/<thread>/`
(else the workspace's, else `<userData>/attachments/<thread>/`, which is in
the fence's managed roots), never overwriting: a second copy gets ` (1)`.

On the Mac (`src/main/server/remote/macBridge.ts`, `macRunner.ts`):

- Per box, in the Mac's settings: `macBridge.policy.<envId>` is `off` (the
  default), `read`, `read+run` or `full` (Settings: Off, Read, Read and run,
  Full access); `macBridge.shared.<envId>` lists shared
  folders: absolute, real paths, never `/`, the home directory or a directory
  above it. Settings → Remote access → Mac bridge edits both.
- Reads, listings and fetches inside the Mac's own managed roots (its
  projects, workspaces and work root) or a shared folder go through without a
  prompt. A path is judged by its real spelling: a symlink out of a shared
  folder asks. Paths are absolute, or `~` / `~/…` for the Mac's home (`~user`
  and relative paths are refused). The Mac names its home in `peer.register`
  (`home`, optional; an older Mac sends none), the box keeps the last one in
  `macBridge.home.<envId>`, and the thread's tool descriptions say "The Mac's
  home is /Users/…" (Claude in-process; Codex through `TEMP_CODE_MAC_HOME`),
  so a thread never guesses the user name. Any other path asks the person at
  the Mac, every time, with "allow this folder for this thread" (not offered
  when the folder would be home or wider).
- The policy decides before any file is touched: a path outside what it
  admits asks (or, with the bridge off, is refused) whether or not it exists,
  so a missing file answers ENOENT only after the person allowed the read.
- `full` reads, lists and fetches anywhere (home, other absolute paths)
  without asking, except a deny list that asks every time and is never
  remembered as a folder (`macDenied` in macBridge.ts): `~/.ssh`, `~/.gnupg`,
  `~/.aws`, `~/.config/gh`, `~/.aliax`, `~/Library/Keychains`,
  `~/Library/Application Support/TempCode` and `temp-code`,
  `~/.claude/.credentials.json`, `~/.codex/auth.json`, any file the harness
  sync's secret rule names (`harnessSet.ts` `isSecretPath`: `*.pem`, `*.key`,
  `auth.json`, …) wherever it is, and the directories above home (`/`,
  `/Users`, which would list every account). Matching is by real path
  (a symlink into `~/.ssh` asks) and case-folded. Managed roots, shared
  folders and remembered folders still go through first, as under `read`.
  Commands under `full` behave exactly as under `read+run`.
- Every command not remembered asks, showing the exact argv (or command
  string) and cwd, with a remember choice (below; the default is "this exact
  command").
- A thread in full access on its box (permission `auto`) is never prompted:
  the box sends the thread's permission with every call (`MacCallThread.
  permission`) and the Mac decides as if every call the policy admits were
  remembered: reads, listings, fetches, writes, commands and jobs alike, the
  always-ask floor and the deny list included. The per-box policy still
  rules: `off` refuses, `read` refuses commands and writes. An older box
  sends no permission and its threads ask as before.
- What reaches the screen (`runPresentation` in macBridge.ts; presentation
  only, nothing about what is admitted). A command or job admitted without
  a prompt (remembered, or from a full-access thread) shows on the Mac as a
  running card with Stop only while the host's **Show running commands**
  (`macBridge.showRunning.<envId>`, the toggle beside the policy in Settings
  → Remote access → Mac bridge) is on: off by default under `full`, on
  otherwise, and pinned either way once toggled. Off, the request is
  `quiet`: no card, no toast, nothing opens; the only trace is the running
  list under that host's row in the pane ("n commands running on this Mac
  from <host>", Stop per command and Stop all) and the thread's "Mac
  approvals…" dialog. A request that waits on the person is never quiet.
  Reads and writes that are admitted never made a request at all.
- The cards never fill the screen (`queueOf` in the renderer's
  lib/macBridge.ts): above a thread's composer, and in the stack for
  threads off screen, at most one waiting card per host, the oldest, with
  "and N more"; the next shows once it is decided. The running commands of
  a host fold into one line (the command when it is one, "n commands
  running from <host>" past that) with one Stop all.
- Remember rules live in memory per (box, thread) and end with the app.
- Remembered approvals (`src/main/server/remote/macBridgeRules.ts`,
  `src/shared/contract-macbridge-rules.ts`). A run card's select offers:
  **exact** (the same argv or command string in the same cwd; the
  default), **folder** (any command whose cwd is, by real path, under the
  card's cwd; not offered when the cwd is home or wider), **program** (any
  command whose program is the same, in any cwd: `argv[0]`, or a simple
  command string's first word after `VAR=value` assignments, path
  stripped; not offered for a shell or a wrapper such as `sh`, `bash`,
  `env`, `xargs`, `nohup`, `timeout`, and a command string with `;`, `&`,
  `|`, `<`, `>`, `(`, a newline, `$(…)` or backticks never matches one),
  **thread** (every command from the thread), or **ask every time**.
  `macBridge.decide`'s `remember` takes `'exact' | 'folder' | 'program' |
  'thread'`, or `true` as before (a read's folder, a run's exact command).
  The narrowest matching rule is credited. The floor, whatever is
  remembered: a command that names `sudo`, `su`, `doas`, `security`,
  `osascript` or `launchctl` anywhere in its argv or text (so `sh -c "sudo
  …"` and `env sudo …` count), `defaults write|delete|import|rename`, a
  recursive `rm` of `/`, a top-level folder, `~`/`$HOME`/the home
  directory (or `.`/`*` with home as cwd), or a credential path (`.ssh`,
  `.gnupg`, `.aws`, `.aliax`, `Library/Keychains`, `.netrc`,
  `.git-credentials`, `.docker/config.json`, `.kube/config`, `.config/gh`,
  `.npmrc`, `.pypirc`, `.claude/.credentials.json`, `.codex/auth.json`,
  `id_rsa`/`id_ecdsa`/`id_ed25519`) in its argv, text or cwd asks every
  time; its card says why and offers nothing to remember, and no rule is
  ever made from it. The lists are `ALWAYS_ASK` and `CREDENTIAL_PATHS` in
  macBridgeRules.ts, the one place to change them. Nothing is persisted:
  `macBridge.rules.list {sessionId?}` and `macBridge.rules.forget
  {sessionId, ruleId?}` (local) back the thread menu's "Mac approvals…"
  (each rule with Remove, and Forget all) and the list under Settings →
  Remote access → Mac bridge. A thread's rules also go when its host pushes
  `session-removed` or `session-moved` for it (the Mac cannot otherwise see a
  box thread end), and all of them when the app quits.
- A command runs through the Mac's login shell (`loginShell.ts`, `-lc`; argv
  as `exec "$@"`, never re-split), in its own process group, with no stdin, an
  environment cut down to `HOME`, `USER`, `LOGNAME`, `SHELL`, the locale,
  `TMPDIR`, `TZ` and a base `PATH` the login shell extends, and a timeout
  (default 2 minutes, at most 30). Past the timeout or on Stop, the whole
  group gets SIGTERM, then SIGKILL after 2 s. Output is not a reason to
  kill: past 4 MiB the middle is dropped (see "mac_run streams" below).
- The prompt is a `macBridge.request` push to the Mac's own local sockets
  only, shown as a card above the thread's composer (or a toast when the
  thread is off screen), and answered by `macBridge.decide`, which is
  local-only: no key, no phone, no box and no MCP bot can ever answer one.
  Unanswered, a request counts as denied after 10 minutes.
- One `[mac-bridge]` log line per call: host, thread, method, decision (and
  for a command, the executable's name and its exit). Never a file's
  contents or a command's output.

mac_run streams (`src/main/server/remote/peerStreams.ts`,
`src/main/server/macRunLive.ts`). A command's output reaches the thread while
it runs, not only when it ends:

- On the Mac, the runner hands stdout and stderr to a pacer that is
  line-buffered per stream (the two never mix inside a line) and sends at
  most one frame per 100 ms, 64 KiB per frame, as `peer.progress {callId,
  seq, chunk, skipped?}` on the same link, before the reply. A backlog over a
  frame keeps its newest lines and counts the rest as `skipped`; a line with
  no newline (a prompt) goes after 1 s. The box takes a frame only from the
  socket its call went out on (any other socket is refused, `admin`), hands
  frames on in `seq` order, and drops quietly a frame for a call that has
  already settled.
- The reply still carries the whole output, up to 4 MiB
  (`MAC_RUN_OUTPUT_CAP`) of stdout and stderr together. Past it the result
  keeps the first 1 MiB and the last 3 MiB in arrival order, with one marker
  line per stream saying how many bytes were dropped there, and says
  `truncated` with `droppedBytes`. The command is not killed for talking.
- On the box, the frames become the same broadcast-only partial tool-call
  row other streaming tools use (`sessions.append` with `partial: true`,
  seq -1, never in the log): the thread's own mac_run row, redrawn at most
  every 250 ms with `preview: {kind: 'shell', output}`, the last 24 KiB of
  the output so far (under the 32 KiB streaming body line, so a remote card
  grows too). The final tool result supersedes it; the wire coalescer drops
  a waiting preview when the result row passes. The row is the harness's:
  Claude names it (the CLI's `_meta["claudecode/toolUseId"]` on the MCP
  call), Codex does not (its call comes through `app-mcp-bridge.mjs`, which
  cannot stream into a tool result), so the box watches the log for open
  mac_run calls and an unnamed run claims the open one with the same argv,
  command and cwd, else the oldest unclaimed. The loopback `mac.run` also
  takes an optional `callId`. The desktop shows the output in the row's
  open pane while it runs (the one exception to "output once settled");
  the phone folds the same rows but its chip still shows output only once
  the result lands.

Writing a file on the Mac (`mac_write_file`, `mac.writeFile {path, dataBase64
| text, mode?, fileMode?}`, the same token as the other `mac.*` methods; Mac
side `src/main/server/remote/macBridgeWrite.ts`, box side `macWriteStage.ts`).
Up to 8 MiB per write. The contents are `dataBase64` (any bytes) or `text` (a
UTF-8 string), exactly one of them, which the schema enforces; the box encodes
`text` to bytes before staging, so the Mac only ever sees base64. Bytes whose base64 fits one `PEER_CHUNK_CHARS` frame ride
inside the `peer.call`; a longer write is staged on the box and the Mac pulls
it piece by piece with `peer.pull` (admin, answered only on the socket the
call went out on) after it has allowed the write, so a denied write never
crosses. A write is never prompt-free under `read`: every one asks, with no
remember on the card. Under `read+run`, and any level above it (a policy
string other than `off` and `read` counts as write-capable), a write inside
the Mac's managed roots, a shared folder or a folder remembered for that
thread lands at once; any other path asks with the same card and the same
"allow this folder for this thread" (write folders are remembered apart from
read folders). Anything under `~/Library`, any dotfile or dot-folder directly
in home (`~/.zshrc`, `~/.ssh/…`) and a key or credential by name asks every
time, whatever the policy, shared folders or memory, and is never remembered.
The path is judged by its real spelling (a symlink out of the allowed set
asks at its target) and the parent's real path is checked again just before
the file lands. `mode` is `create` (the default: refuses an existing file),
`overwrite` (temp file beside the target, then rename; the old mode is kept
unless `fileMode` names one) or `append` (opened in place with `O_NOFOLLOW`);
missing folders above the file are made only for create and overwrite, and
the card says so. One `[mac-bridge]` line per write names the host, thread,
path, bytes, mode and outcome, never the contents.

Interactive jobs (`src/main/server/remote/macJobs.ts`, contract
`src/shared/contract-macjobs.ts`). `mac_run` with `background: true` starts the
command as a job and answers `{jobId}` at once; the box forwards it to the Mac
as `mac.jobStart`. The approval is the same card (argv and cwd), saying
"interactively", with its own per-thread "allow this exact command"; once
allowed the job runs through the login shell with the scrubbed environment in
its own process group, but in a terminal (node-pty, so `ssh`, `sudo -S` and
other prompts that read the tty work; it echoes input and merges stderr into
stdout; piped stdio when node-pty cannot load), and stays on the card as
running, with Stop. Then `mac.jobWrite {jobId, dataBase64}`, `mac.jobRead
{jobId, afterOffset, waitMs?}` (the newest 1 MiB past the offset of a 4 MiB
rolling buffer, `nextOffset`, and the exit once done; `waitMs` up to 30 s waits
for output), `mac.jobSignal {jobId, TERM|KILL|INT}` (the whole group) and
`mac.jobClose` (stdin; in a terminal that is ^D) ask nothing more: the job was
allowed. All four are local, carry the thread's token, and the Mac answers
only for the (host, thread) that started the job. Tools: `mac_run`'s
`background`, `mac_job_write` (text or base64, `close`), `mac_job_read`,
`mac_job_signal`, for Claude and Codex alike. At most 4 run per thread; a job
ends when its thread is archived, deleted or moved off the box (the box sends
`mac.jobsEnd`), when the host's policy drops to read or off, when the Mac's app
quits, and after 30 minutes with no call on it (SIGTERM, SIGKILL 2 s later;
the idle clock is also what ends a job whose box went away); an
ended job's output stays readable for another 30 idle minutes (the newest 4
per thread). The log names the job, its argv0, writes by size, signals and the
exit; never its input or output.

Security model, in short: the box can ask, never decide. A compromised box can
make the Mac show prompts and read what the Mac shared with it (or with its
projects), nothing more; it can never run a command the person did not allow
on the Mac. The admin key the Mac holds for the box is unchanged in what it
can do on the box. On the box, the bridge is only as strong as the box's
loopback (any local process can already speak as the implicit admin there);
the per-thread token keeps one thread's tools from calling as another.
Proof: `bun run script:e2e-mac-bridge` (two headless instances, one playing
the Mac; runs on the box under `xvfb-run`); its streaming step runs a command
printing 20 lines over 2 s and needs at least 3 live rows on the thread before
the result, and the result whole.

Still darwin-only by design: appshots, the Aliax browser-cookie sign-ins,
the IntelliJ engine's pinned artifact (`lsp.ts` has only `darwin-arm64`; the
Linux pin waits for a build that has not expired), and vibrancy. Known gap:
the local socket is the implicit admin for any process on the box's loopback,
as on a Mac; the box has only `prod` as another user.

## Updating

For a ref already on GitHub, run from the Mac:

```sh
ssh box 'box-update master'
# Or pin a published tag or commit:
ssh box 'box-update v1.0.N'   # replace N with a tag published on GitHub
# As landon on the host:
sudo /usr/local/sbin/box-update master
```

On a fresh box, stage 85 creates the build/data directories and service
without needing an existing `current`. Run `box-update <ref>` to bootstrap:
it builds and trials the ref, skips the pre-update snapshot only when there
are no SQLite files yet, creates `current` and starts the host. There is no
`previous` on this first deploy. If it fails after switching, the launcher
stops the service and clears the links; it keeps any created data and has
no older binary to restart. The pending record also supports recovery of
an interrupted first deploy.

`box-update` takes `/run/lock/temp-code-update.lock` before doing any work.
The history-import wrapper uses the same lock; either refuses at once with
a maintenance-lock message if the other holds it. Both acquire
`box-backup.lock` second and keep it through the live switch/import,
restart, health checks and any rollback. A daily backup can run during the
build/trial, but cannot race the switch or restart.

`box-update` clones the GitHub repo into a fresh build directory and fetches
that ref. As agents, it runs `bun install --frozen-lockfile`, installs
Electron's binary, rebuilds native dependencies, then runs `electron-vite
build`. It starts a headless trial with a private HOME, userData, TMPDIR,
Xvfb and free loopback `TEMP_CODE_REMOTE_PORT`. The trial cannot claim the
live Aliax shim. The check requires `/healthz`, an HTTP hello with the built
version and contract, a matching local WebSocket hello, `tc-local session.list`,
and a remote pairing → bearer → ticket → socket `session.list`. Probe keys
are revoked. A failed build or trial leaves `current` and the live PID alone.
The launcher also refuses an older version after trial: a stale GitHub master
cannot silently replace a newer local deployment. Publish the green master
through the project's normal flow, or use the bundle commands below.

After trial success, the launcher takes `VACUUM INTO` snapshots of every live
SQLite database as agents, checks them, and keeps the last three complete
snapshot directories under `/srv/agents/backups/pre-update`. Each database
has its own consistent read transaction; the daily backup and restore drill
share the backup lock, held through the restart and health checks. It atomically points `previous` at the old build,
then `current` at the new build, and restarts `temp-code.service`. It repeats
all checks on 7677, including version and contract. This is the on-box check;
the Mac's public-path proof is a separate required operator check:

```sh
scripts/box/apply.sh --from 90 --through 90
bun scripts/e2e-box-remote.ts
ssh box 'tc-local --hello; tc-local remote.status; curl -fsS http://127.0.0.1:7677/api/hello'
```

Any failure after the switch restores the old links, restarts the old binary,
verifies it, and exits nonzero. A root-owned pending record in
`/var/lib/box-baseline/temp-code-update.pending` lets the next invocation
recover an interrupted switch before taking another ref. If rollback itself
fails, the record remains: inspect the service journal and repair the old
build before rerunning. The launcher keeps the two newest successful builds
plus any build named by `current` or `previous`; failed candidates are removed.
No update touches Docker, `/srv/prod`, cloudflared or the tunnel.

Database migrations are forward-only: the app only adds tables and columns
with defaults. Rolling back a binary therefore needs no database restore.
If a future change drops, renames or rewrites existing data, stop using this
assumption: require a migration compatibility check before deployment, drain
writers, and define and test a database restore or reverse migration before
allowing the new binary to commit. Never restore SQLite over a running host.

Install or refresh launcher files without deploying:

```sh
scripts/box/apply.sh --from 75 --through 75
scripts/box/apply.sh --from 85 --through 85
```

For green local master commits that are not on GitHub yet, transfer a bundle
of that same repo instead of pushing from an implementation thread:

```sh
git bundle create /tmp/temp-code-master.bundle master
scp /tmp/temp-code-master.bundle box:/var/lib/box-baseline/temp-code-master.bundle
ssh box 'chmod 644 /var/lib/box-baseline/temp-code-master.bundle; BOX_UPDATE_BUNDLE=/var/lib/box-baseline/temp-code-master.bundle box-update master'
ssh box 'rm /var/lib/box-baseline/temp-code-master.bundle'
rm /tmp/temp-code-master.bundle
```

The bundle must be root-owned and readable by agents. The launcher still
clones the GitHub repo, then fetches the requested ref from this explicit
bundle for that invocation only. The usual command continues to fetch GitHub.

Failure proofs (these intentionally return nonzero):

```sh
# This published pre-headless ref builds but fails the scratch trial:
ssh box 'box-update v1.0.228'
# Force a one-shot post-flip verification failure, then verify rollback:
ssh box 'touch /run/temp-code-update-force-post-flip-failure; box-update master'
ssh box 'tc-local --hello; curl -fsS http://127.0.0.1:7677/api/hello'
```

The fault file is root-only and the launcher consumes it after the post-flip
probe. Remove it manually if a build/trial fails before the switch. Keep full
launcher output in a private host log when collecting these proofs.

### U verification, 2026-10-19

Full logs are root-only on the box:
`/var/log/temp-code-update-trial-failure.log`,
`/var/log/temp-code-update-rollback.log`, and
`/var/log/temp-code-update-success.log`. These excerpts contain no keys or
pairing codes. GitHub master was still v235, so the v240 tests fetched a
bundle of local master `93abb331b19c873892334125bf4efd8093c50a08`.

```text
BUILD: v1.0.228 ee10b8ec578e8beaa1df93d9d7f50ef0b9a56e33
ERROR: health/socket check failed on 41521
ERROR: update of v1.0.228 rejected before switch (exit 1); current unchanged
exit=1
MainPID=2320

TRIAL PASS: 1.0.240 1 port=34855 sha=93abb331b19c873892334125bf4efd8093c50a08
SNAPSHOT PASS: /srv/agents/backups/pre-update/20261019T184650-130124
COMMIT: current=93abb331b19c873892334125bf4efd8093c50a08-20261019T184615-oHfZAP previous=temp-code
ERROR: forced post-flip health-check failure
ERROR: update of master failed after flip (exit 1)
ROLLBACK: restoring temp-code
ROLLBACK PASS: 1.0.235 1 current=/srv/agents/temp-code
exit=1

TRIAL PASS: 1.0.240 1 port=33951 sha=93abb331b19c873892334125bf4efd8093c50a08
SNAPSHOT PASS: /srv/agents/backups/pre-update/20261019T184743-133705
COMMIT: current=93abb331b19c873892334125bf4efd8093c50a08-20261019T184707-DEXWRK previous=temp-code
COMMIT PASS: 1.0.240 1 sha=93abb331b19c873892334125bf4efd8093c50a08
exit=0

PASS: temp-code-cold.db quick_check=ok sqlite_master=2 table-counts=1 match disk
PASS: temp-code.db quick_check=ok sqlite_master=24 table-counts=11 match disk
RESTORE DRILL PASS: snapshot=664579b8387a93ebdea66d1103b225d9e74f299b0c44e1dc62da2c98af699e4b
MONTHLY CHECK PASS: 5% of repository data read
```

The live environment remained `env_AXPf_aVGh7kfe4eydhNdVQ`, contract 1.
`tc-local --hello`, `tc-local session.list`, and
`tc-local remote.environments.list` passed; the deployed tree contains
`remote/webhooks.ts`, the connection runtime, and `ios/TempCodeContract`.
Stage 90 passed through `apply.sh`; the Mac e2e passed HTTP, ticket and cookie
sockets, Chrome pairing, secure cookie flags, the Access gate, and credential
cleanup. Local gates passed typecheck, 2,747 Vitest tests, 12 hub tests,
20 Swift tests, and the production build. The `/ui` renderer remains behind
Access; this run proved its gate and cookie/socket flow, not a signed-in
renderer session.
