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
  database files are excluded; a mid-write copy is worthless), backs up
  `/srv/agents`, `/srv/prod` and `/etc` with `/etc/restic/excludes`, keeps
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
  `sqlite_master` row count and all user-table row counts with the snapshots
  on disk. Missing files or a mismatch fail the drill. An EXIT trap removes
  scratch data on success or failure. It never restores over live data.
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

### Signing accounts in

Provider accounts (Claude, Codex, Cursor) come over from the Mac; thread V
covers them. GitHub is the one sign-in done on the box itself, once, as
agents:

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
share the snapshot lock. It atomically points `previous` at the old build,
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
