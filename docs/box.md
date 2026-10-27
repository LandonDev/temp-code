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

A Mac holds no APNs key, so its own threads' notices travel through the box:
a Mac with neither a key nor a hub sends each one down its link as
`relay.notice`, and the box delivers it through its sender, its hub client
and the key webhooks with `environmentId` set to the Mac's id, so a tap opens
the thread on the Mac's client ("The relay" below). Live Activities for a Mac
thread are not carried yet.

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
| Builds | `/srv/agents/temp-code-builds/<sha>-<UTC time>-<suffix>`, owned by agents: for a `v1.0.N` the release's prebuilt `out/` laid out from `temp-code-out-1.0.N.tar.gz`, for master a clone detached at the commit and built there; each with a `build-manifest.json` ("Updating" → "Build once") |
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
link within ten minutes. The link's page (`/pair`, src/main/server/remote/pairPage.ts)
shows the code and one Pair button and redeems nothing until it is pressed; a
client link signs the browser in and lands on `/ui/`, a bot (`mcp`) link shows
its key once with Copy. A refused code reads "This code is invalid or has
expired. Make a new one in Settings → Hosts on your computer." A `/ui` tab whose
session lapsed or was revoked goes to `/pair?signed-out` ("Signed out.")
instead of reconnecting:

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

### Surviving a restart: threads mid-turn come back

`box-update` (and any `systemctl stop`) ends the service with SIGTERM to the
whole cgroup while threads may be mid-turn. Before 2026-10-21 those threads
stayed marked running with no harness behind them until someone restarted
each one by hand. Now:

- **The record.** `resume_after_boot` is a live ledger: `SessionRegistry.
  append` (src/main/server/sessions.ts) writes a thread's row (time, the seq
  of the user turn in flight) on every running or starting status and clears
  it when the turn settles, on a pause, a restart or a delete. The signal
  handler (and `before-quit` on a Mac) then stamps `shutdown_at` on the rows
  of every thread with a harness behind it (`recordForResume`, one
  synchronous SQLite write) and exits. The ledger matters because the handler
  does not always run: systemd's stop signals the whole cgroup, dbus-daemon
  (from `dbus-run-session`) goes down with us, and Chromium aborts the main
  process on the D-Bus disconnect (`FATAL:dbus/bus.cc "D-Bus connection was
  disconnected"`, SIGTRAP) before Node's handler gets the loop; the proof saw
  that on both of its stops. A paused thread is never recorded. The unit's
  `TimeoutStopSec=30` is ample: the harnesses write their transcripts as they
  go and need no flush of their own.
- **Boot.** Once the servers and the gateway listen, `BootResumer`
  (src/main/server/resumeAfterBoot.ts) boots a fresh harness on each recorded
  thread's transcript and sends it one nudge, `The host restarted during your
  turn at <time>; continue where you left off.` (the shutdown's time when
  the handler stamped it, else this boot's), through the same
  `registry.resumeStopped` the Resume button uses. Four boot at a time, each
  worker pausing 750 ms between its threads; subagents go before their
  parents. A thread the user paused stays paused; a thread that is gone or
  archived is forgotten. The transcript shows `Resumed after the host
  restarted at <time>`. Log lines start with `[resume]`.
- **Stopped.** A thread whose row says running (or starting) with no live
  harness for more than 20 s reads `stopped` (a new status, in the contract
  and the Swift package): a crash or SIGKILL mid-turn, a boot resume that
  failed to produce a handle, or a harness process that died without the
  driver settling the status (`DriverHandle.alive`, the liveness sweep every
  5 s in `sweepLiveness`). The working strip says "Stopped · the harness is
  gone" with Resume, the rail row shows a small still square instead of the
  spinner, the tab says Stopped, and the header menu offers Resume;
  `session.resume` on a stopped thread calls `resumeStopped`. The boot no
  longer flips running rows to idle; only waiting and watching rows are
  idled at boot.
- **The toast.** When a boot resumed anything, every socket gets one
  `boot-resume` push (count, the boot's time) and the rail says "7 threads
  resumed after restart" as a sonner toast, with the host's name under it
  when two or more are paired (`useBootResumeToasts`, chrome/HostRows.tsx),
  once per boot (the renderer keeps the boot time per host in localStorage).

Proof: `bun scripts/e2e-survive-restart.ts` on a host with a Claude account:
an isolated headless instance, two claude-haiku-5-5 threads sent a long turn
in a scratch directory, SIGTERM mid-turn, the two rows checked in the
database, a relaunch, both threads back to running with the nudge, the
`boot-resume` push read on a fresh socket, then everything torn down. Unit
tests: src/main/server/sessions-resume-after-boot.test.ts and the strip's
WorkingStrip.dom.test.tsx.

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
- **Removals follow the owner.** Remove an account on the Mac's Accounts
  page (or over `accounts.delete` on a host) and it is gone everywhere:
  the vault row goes, the host's accounts snapshot rebuilds at once (the
  gateway and the routing stop naming it before anything else runs; no
  Refresh or Sync needed), and every peer hears, over the Mac's link as
  `accounts.removed` and to the sockets that pulled from the host as an
  `accounts-removed` push; every pull answer also carries the sender's
  whole file and its tombstones, so a box that was away prunes on its next
  sync (`accountSync.ts deleteProfile`, `prune`). The tombstone rule: a host
  that deletes a profile it refreshes or a static one-year token keeps a
  tombstone (settings row `accounts.tombstones`, 30 days, void once a
  profile of that account is saved there again). A peer deletes an
  access-only copy refreshed by the sender when the sender's list no longer
  has the account (the owner's file is the whole truth about what it
  refreshes), and a static token only when a tombstone names it (every
  host holds its own copy, so absence from one list proves nothing). Never
  deleted on a peer's word: a profile the host refreshes itself, the one
  its CLI is signed in with (Claude's credentials, Codex's `auth.json`), or
  a provisional copy from a handoff in flight; the log says what was kept
  and why. A thread on the box whose pin or sticky account went: it routes
  automatically from its next turn, the project's or workspace's pin for
  that provider is cleared, and one plain row lands in the thread, "Account
  <name> is gone from this host; routing automatically from here" with the
  time (`chooseAccount` reports `vanished`, `sessions.ts accountGone`); the
  account chip reads Auto until the next pick lands.
- **A failed turn says what happened, in words, with the account.** The host
  classifies every error row before it is stored (`src/main/server/failureKind.ts`,
  stamped in `Sessions.append`): the harness's words, the gateway's last
  refusal for the thread (`noteRefusal`: a 401 with the upstream body's code
  from `onUnauthorized`, a 429 from `pickNext`, fresh for two minutes) and
  the routing (`accountKnown`: is the thread's account still in the vault;
  `visibleModels`: does the catalog offer its model here) fold into one
  `failure` on the event: a kind (`oauth_expired`, `account_unknown`,
  `token_expired`, `rate_limited`, `quota`, `model_unavailable`, `network`,
  `harness_crashed`, `unknown`), the account the turn was routed to, one
  line naming what happened ("Anthropic session for landon@… expired and
  could not be refreshed", "Account work@… is no longer on file") and one
  with the likely cause. A stop and a "turn ended:" wind-down note are never
  classified. The verdict is folded onto the session row (`session_folds.failure`,
  `SessionMeta.failure`, cleared by whatever settles the error) so the tab
  edge and the workspace popover's failed row print the summary instead of
  "Failed", and the phone contract carries it (`Failure` in the generated
  Swift). The transcript's failure card (`src/renderer/src/surfaces/FailureCard.tsx`,
  the action set in `lib/failureActions.ts`) offers at most three actions
  that fit the kind, Retry always last: Route automatically (`session.reroute`,
  capability operate: the thread re-picks its account fresh, a dead one being
  out of routing, respawns there and continues), Pick another account (the
  composer's account list), Sign in (on the Mac, the Aliax sign-in with the
  address pre-filled; a box thread says "Sign in on the Mac, the box never
  signs in" and gets Route automatically instead), Pick another model (a
  hidden or refused model opens the composer's picker) and Retry
  (`session.continue`). A row written before the verdict existed keeps the
  bare red Failed line with the harness's words.
  The Mac's main process keeps one socket per admin host (backoff to 5 min)
  and syncs on connect, on every local vault write, and every 15 minutes;
  `accounts.sync` and the row's Retry do it now. The box's own vault is
  `/srv/agents/home/.config/aliax/` in key-file mode.

Proof without a real account: `bun run script:e2e-accounts-sync` (two
isolated instances, a fake provider, a handoff, a rotation, a removal that
reaches the other host and clears a thread's pin, the owner down)
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

### Routing by headroom: both hosts pick from one picture

A thread in auto mode spends from the account with the most headroom for
its provider and model, not from the one it happened to land on first
(`src/main/server/accountRouting.ts` `chooseAccount`, scored by
`accountScore.ts`). The picture it scores from is the gateway's own
(`src/main/server/headroom.ts`): every upstream answer the gateway forwards
carries the provider's per-request limits (Anthropic's
`anthropic-ratelimit-*` headers and unified status, OpenAI's `x-ratelimit-*`,
`retry-after` on a 429), and the store keeps, per account and per host, the
newest of each, the answers of the last minute, and every 429 or 529 with
the moment it lifts. An account inside that cooldown is skipped until then.
A pinned account is routed regardless.

- **Weights.** 0.45 × the least room among the model's usage windows (5h,
  Weekly, Fable's own cap), 0.30 × the tightest per-request limit left
  (unknown counts as full: nothing says the account is busy), 0.15 × live
  threads against the soft cap of 3, 0.10 × the cross-host answer rate
  against 30 a minute, plus 0.15 for an Opus thread on an account whose
  Fable window is spent. A thread stays on its account unless the best other
  one leads by more than 0.10 plus 0.25 × cache warmth, where warmth is 1
  right after the thread's last answer and 0 after the 5-minute prompt cache
  TTL: a thread mid-conversation moves only for far more room, an idle one
  moves for a little.
- **Both hosts, one picture.** The box and the Mac each observe only their
  own gateway. The link holder (the Mac's main process) pushes its own
  entries to the box every 30 s and within a second of a 429
  (`accounts.headroom`, admin on the remote wire), and the answer carries
  the box's; each side merges the other's under its environment id and
  never its copy of a third host's. A new throttle in a peer's push re-picks
  the open threads here as if the local gateway had seen it.
- **Where it shows.** The account chip's menu and the Claude panel in
  Settings carry a short bar per account (what is left of the tightest
  limit, "rate limited · 40s" inside a cooldown, "no answer yet" before any
  answer) with the refill or pick-again moment and the rate on hover. The
  rows follow the store at most every 5 s; picks read it live.
- **Across a relaunch.** `<data>/headroom.json` (on the box
  `/srv/agents/temp-code-data/headroom.json`) is written 5 s after a change
  and on close, and read at boot; observations older than a day are
  dropped.
- Proof from either host: `bun run script:e2e-quota-routing`.

### Harness config: synced from the Mac

The skills, slash commands, agents, hooks, settings and plugins the user set
up for Claude Code and Codex live on the Mac, and the Mac's main process
mirrors them onto the box over the same admin link the accounts use
(`src/main/server/remote/{harnessSet,harnessSync}.ts`). The Mac's copy wins;
the box never sends back. Nothing to do on the box: a headless host only
receives (`harness.sync.enabled` defaults to off there, on for a desktop).
Installing a skill on the Mac (Impeccable's `npx` installer puts it under
`~/.agents/skills/`, links or copies it into `~/.claude/skills/`, and writes
Codex's `~/.codex/hooks.json`) is enough: the box has it within seconds.

The set, relative to each HOME, each rule with the label the status line
uses (`HARNESS_SET` in `harnessSet.ts`):

- Claude skills: `.claude/skills/**` except `.claude/skills/synced/**` (the
  CLI's own account-synced bucket: each side keeps its own)
- Claude commands `.claude/commands/**`, Claude agents `.claude/agents/**`,
  Claude hooks `.claude/hooks/**` (the scripts settings.json's hook commands
  point at, when they live there), Claude settings `.claude/settings.json`
- Claude plugins: `.claude/plugins/**` except `.claude/plugins/synced/**` and
  `plugin-directory-cache*.json` (the CLI rebuilds it per host)
- `enabledPlugins` and `mcpServers` of `~/.claude.json`, merged into the
  box's own file; every other key (`oauthAccount`, `projects`, …) stays as
  the box has it
- Codex skills `.codex/skills/**` except `.codex/skills/.system/**`, Codex
  prompts `.codex/prompts/**`, Codex config `.codex/config.toml`, Codex hooks
  `.codex/hooks.json` (the user-level hooks; the trust rows config.toml keeps
  for them, `[hooks.state."<home>/.codex/hooks.json:post_tool_use:0:0"]
  trusted_hash = …`, name the box's copy after path translation, and the hash
  is the hook's own, so a hooks.json that names `$HOME` lands byte for byte
  and stays trusted)
- Shared skills `.agents/skills/**`, read by Claude Code and Codex alike

A project's own `.claude/skills/` lives in its repository and crosses with
git, not with this sync.

Never, whatever the rules say (checked when the manifest is built and again
on landing, and in the tests): `.credentials.json`, `auth.json`,
`settings.local.json`, `.claude.json` as a file, `*.pem`, `*.key`, `*.p8`,
`*.p12`, `*.pfx`. Also left out: any `.git` dir (a marketplace clone lands as
a plain tree), `.DS_Store`, files over 16 MiB, and any Mach-O file (thin,
either byte order, or a universal binary, told from a Java class file by the
arch count): a macOS executable runs nowhere else, so the Mac leaves it out
of the manifest and counts it as skipped, and the box refuses one at commit
should a manifest name it anyway. Under every skills root, a skill's
per-platform binary cache `<skill>/scripts/bin/**` is not even walked: that
is where Impeccable's launcher (`scripts/impeccable`) looks for
`bin/<os>-<arch>/impeccable` beside itself before filling
`~/.impeccable/bin/<version>/` (outside the set) from the release channel on
first use. The launcher, `scripts/VERSION` (the engine version), SKILL.md,
`command-metadata.json` and the skill's `agents/*.toml` cross; the box
downloads its own Linux engine the first time a hook or a thread runs it.

A symlink on the Mac is followed when its target is inside the Mac's HOME
and outside `.ssh`, `.gnupg`, `.aws` and the like. A skill directory that is
a link (into another skills root, a checkout, or a package cache under HOME
such as `~/Library/Caches/…` or `~/.npm/_npx/…`) is walked as a directory:
the box gets the target's files as a real directory under the same path,
never the link. A link that points outside HOME (`/opt/homebrew/…`) is
skipped and counted.

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

Status: Settings → Hosts on the Mac. This Mac's Sync group has the Harness
config switch, with how many files stay on the Mac (over 16 MiB, a symlink
out of reach, or a macOS binary) under it; each paired host's Sync group has
a Harness config row, `143 files  synced 2m ago` (every set with files, in
the set's order, from `sets` of `harness.status`, in its tooltip), `Never
synced`, or the last error, and Sync now at the group's heading
(`harness.status` and `harness.sync` on the Mac's own socket). On the box, the `[harness-sync]` lines in the service's
journal say what landed. Proof:
`bun run script:e2e-harness-sync` (two headless instances with their own
HOMEs, paired over the fixed port; runs on the box under `xvfb-run`).

### Memory: synced both ways

The notes the harnesses write for themselves are the one part of the
harness config every host writes, so they cross both ways
(`src/main/server/remote/{memorySet,memoryMerge,memorySync}.ts`,
`src/shared/contract-memory.ts`). The set, relative to each HOME:

- Claude Code: `.claude/projects/<encoded cwd>/memory/**` (MEMORY.md plus
  one file per memory), `.claude/plans/**`, `.claude/CLAUDE.md`
- Codex: `.codex/memories/**` (memory_summary.md, MEMORY.md,
  rollout_summaries/, skills/; not its `.git` baseline), `.codex/AGENTS.md`

Never: transcripts (`*.jsonl` and the per-session dirs beside `memory/`),
anything the harness sync calls a secret, `.git`, files over 1 MiB. A
project's own `.claude/` notes live in the checkout and are not touched.

The encoded project dir names the cwd with every other character as `-`
(`-Users-landon-IdeaProjects-temp-code` on the Mac,
`-srv-agents-work-temp-code` here), so it is translated through the same
path map the harness sync uses (`harness.sync.pathMap`, the shipped
history-map.json by default; `memorySet.ts` `translateEncodedDir`): a mapped
root or prefix whose encoding starts the name is swapped for its
counterpart's, a worktree under a mapped root follows it, and a project no
mapping covers keeps its name. The box reads the map forward; the Mac reads
it backward for what comes from the box (its roots and prefixes inverted,
the box's work root as `~/IdeaProjects`). Text files have the paths inside
them translated the way the harness sync does.

Who drives: the host holding the link (the Mac) sends `memory.exchange`
(its files with size, sha256, mode and mtime, plus its tombstones); the box
decides per file (`memoryMerge.ts`) and answers what it wants, what the Mac
lands (the box's own files whose side won, bytes included) and what the Mac
deletes; the Mac lands and deletes, then streams what was asked for as
`memory.files` frames, the last one with the hashes of what it landed. Both
keep `<userData>/memory-sync/state.json`: per peer, the hashes the two
agreed on last time; and the host's own tombstones. The rules:

- unchanged on both sides since the last sync: nothing; same bytes once
  translated: nothing, remembered as synced
- changed on one side: that side's copy crosses, with its mtime
- changed on both (or never synced and different): the newer mtime wins
  on both hosts, and the other copy is kept beside it as
  `<name>.conflict-<host>-<yyyymmddThhmmss><ext>` (the host whose copy
  lost), on both hosts; never silently dropped
- `MEMORY.md` under a project's `memory/` is unioned instead: one line per
  memory file, the newer file's order, the other's extra lines after the
  nearest shared line, deduped by file name; a line whose file is gone from
  both hosts is dropped
- a deletion crosses as a tombstone (kept 30 days) unless the other side
  edited the file after it, in which case the edit wins and the file comes
  back; an edit the deletion beats is kept as a conflict copy

When: on link-up, every 5 minutes, about three seconds after a thread
settles idle on either host (memory is usually written at the end of a
turn: the Mac syncs; the box, which holds no link, pushes a `memory.nudge`
down the Mac's link and the Mac syncs), and from Sync now. A round that
made something the other side should have (a union result, a conflict copy)
runs one more at once.

Status: Settings → Hosts on the Mac, a Memory row under each paired host's
Harness config row: `42 files  synced 2m ago  1 conflict`; This Mac's Sync
group folds the conflict copies on this machine open under its Memory switch
(the file it sits beside, whose copy, when, and Reveal); that switch is the
`memory.sync.enabled` setting (on by default). `memory.status`,
`memory.sync` and `memory.settings.set` on the host's own socket; on the
box, `tc-local memory.status` and the `[memory-sync]` lines in the journal.
Proof: the memory step of `bun run script:e2e-harness-sync`.

### Integrations and API keys: placed by hand

The harness sync never carries a secret, so the keys and config files the
Mac holds for the user's integrations were put on the box once, by hand
(2026-10-21). A new key goes in the same place:

- Keys the Mac exports from its shell (`~/.zshenv`, `~/.codex/sentry.env`
  via `~/.zprofile`) live in `/etc/temp-code.secrets.env`: `LINEAR_API_KEY`,
  `LINEAR_API_KEY_SKY`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`.
  The unit's environment is what every thread child inherits (`harnessEnv`:
  `process.env` plus the login PATH), so a Bash call in a box thread sees
  them the way a zsh on the Mac sees `.zshenv`. The agents user's `.bashrc`
  would not do: bash reads no rc file for a non-interactive shell, and the
  CLI's shell snapshot carries PATH, functions and options, never exports.
  A key added to the file reaches children only after
  `systemctl restart temp-code.service`.
- Files that scripts and skills read by path sit under the agents home
  (agents, 600, directories 700): `.codex/sentry.env`,
  `.config/cosmic/{paynow.env,convex-selfhost.key}`,
  `.config/cosmic-admin/{runtime.env,keys/}`, `.config/codex/pterodactyl.env`.
- Each web project's gitignored `.env` and `.env.local` files sit in its
  clone under `/srv/agents/work/<X>` (agents, 600). `.env.production.local`
  and `.vercel/` stay on the Mac.
- `gh` is signed in as LandonDev with the repo scope (`~agents/.config/gh`);
  git pushes over https through `gh auth git-credential`. No SSH key.
- Not on the box: the Slack plugin's MCP OAuth grant and the CosmicPrisons
  project's `linear-server` MCP. Both are per-host sign-ins in the CLI's
  credential store; the Linear skills call GraphQL with `LINEAR_API_KEY`.

Copying from the Mac: `COPYFILE_DISABLE=1 tar -cf - <paths> | ssh box 'cd
<dir> && tar -xf - --no-same-owner --no-same-permissions'`, then chown to
agents and chmod 600. Without `COPYFILE_DISABLE` bsdtar adds a `._<name>`
AppleDouble file beside each one; delete them.

#### Mobbin MCP: Claude Code and Codex on both hosts

Mobbin uses its official HTTP endpoint, `https://api.mobbin.com/mcp`, as
the global server `mobbin` in both CLIs. Register it on the Mac:

```sh
claude mcp add mobbin --scope user --transport http https://api.mobbin.com/mcp
codex mcp add mobbin --url https://api.mobbin.com/mcp
```

Harness sync carries Claude's `~/.claude.json` server entry and Codex's
`~/.codex/config.toml` entry to the agents user on the box. OAuth grants
stay in each CLI's own credential store. Sign in once per CLI per host;
do not copy refresh tokens between them. Provider account sync does not
handle these MCP grants.

To sign in again on the Mac, run `claude mcp login mobbin` or
`codex mcp login mobbin --scopes openid,offline_access`. On the box, run
the same login as agents (`runuser -l agents -c '…'` from root), using
`/srv/agents/home/.npm-global/bin/codex` for Codex. Claude's
`--no-browser` flag prints the sign-in URL and accepts the redirect URL;
use `ssh -t` so its prompt has a terminal. For a browser callback to the
box, forward the port printed in the authorization URL with
`ssh -N -L <port>:127.0.0.1:<port> box` before opening that URL on the
Mac. Close the tunnel when login finishes. Both clients use the
`openid` and `offline_access` scopes.

Verified on 2026-10-24: all four clients connected and loaded the same
eight tools: screen, section and flow search; list and read collections;
create a collection; save content; add a comment. Claude's
`claude mcp get mobbin` reports Connected on both hosts; Codex's
`codex mcp list` reports OAuth. Native client tool discovery also passed
for all four, without a model turn. New sessions load the server; an
existing session may need to reconnect its MCP servers.

Setup references: [Mobbin's Claude Code guide](https://docs.mobbin.com/mcp/clients/claude-code-cli)
and [OpenAI's MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

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
refuses it too. Settings → Hosts (Attachment limit) edits this machine's limit; on the
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
### Working notes: what a thread keeps for its next window

Every root thread keeps one markdown file, `notes.md`, beside its
attachments (`attachmentDir(session)/notes.md`, so the harness can read and
write it with its own tools; `src/main/server/threadNotes.ts`, the text
rules in `src/shared/notes.ts`), mirrored in the `session_notes` table for
the renderer, search and archived threads whose directory is gone. Five
fixed headings — Goal, Decisions, State (done, in flight, blocked; its
first line is the one-line status), Pointers (files, commands, ids), Open
questions. The file keeps every heading; a prompt or a digest embeds only
the filled ones.

The harness writes it with the `update_notes` app tool (claude in-process,
codex through the bridge as `app.updateNotes`): one section per call,
`replace` or `append`, and the tool reads the file first so a person's edit
since the last call survives. The mechanics (`NOTES_MECHANICS`,
`src/main/server/notesPrompts.ts`) ride every claude system prompt, so a
compaction never drops them, and the first-message preamble of every other
harness.

The app reminds the thread at the two moments that matter. When the
context meter passes 0.7 of the window, a `<notes-reminder
reason="context">` is whispered into the live turn (both drivers take
mid-turn input), once per window, armed again below 0.5 or at a
compaction. When a root thread's turn committed or merged (`git commit`,
`git merge`, `gh pr merge`, `git push`) without an `update_notes` call, the
app sends a `<notes-reminder reason="commit">` as its own short turn after
the settle, marked on the transcript like a completed-turn pass ("Notes");
with a queued message waiting it rides ahead of that message instead, and a
reminder is never repeated before the next user message. A whisper that
finds no live turn is held and goes ahead of the next message the harness
gets (a user message or a turn pass).

After a compaction (the `compaction` event's `done` phase) the thread's
notes go to the harness as a `<thread-notes>` block, so the window that
only has the summary starts from what the thread chose to keep. Successors
start the same way: a thread digest (`renderMirror`, hence
`app_read_thread`, `seedThreadIds` and `@thread:` references) carries
`## Notes` between the frontmatter and `## Outcome`, kept whole when the
digest is trimmed, and a build thread's first message carries its planning
thread's notes (`<planning-notes>`) beside the plan seed.

On the wire: `session.notes.get` (read) answers `{text, updatedAt, path}`,
`session.notes.set` (operate) is the person's whole-text edit, and the
`notes` push goes to every client of the thread's host (the phone's
decoder folds it into its unknown case; the Swift subset is untouched).
`session.search` folds notes hits in ahead of the transcript rows (`source:
'notes'`, seq 0, one per thread). In the desktop renderer
`lib/threadNotes.ts` keeps the copy current on the push and feeds the Notes
drawer at every root thread's right edge (`surfaces/threads/NotesPanel.tsx`:
rendered markdown, an edit mode that saves on a debounce and on Done and
offers the thread's version when it wrote meanwhile, "Copy as brief" for a
successor's first message), the needs-you banner's State line, and the
notes icon on a search hit.

Proof: `threadNotes.test.ts` (sections, the file and mirror round trip),
`sessions-notes.test.ts` (both reminders, the whisper, the compaction
block, the digests, the plan hand-off), `session-search.test.ts`,
`app-bridge.test.ts`, and the renderer's `threadNotes.test.ts`,
`NotesPanel.dom.test.tsx` and `ThreadBanners.dom.test.tsx`.

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
says "Undo history stayed on This Mac"). Event payloads keep the paths they
recorded, as in the history move.

**The branch travels too.** Before any part goes, the source reads the
thread's cwd (`src/main/server/sessionMoveBranch.ts`, `inspectBranch`): the
checked-out branch and commit, whether the cwd is a linked worktree of the
project (`git rev-parse --git-dir` against `--git-common-dir`), the default
branch (`origin/HEAD`, else main or master), and `git status --porcelain`
(tracked changes plus untracked files; a nested worktree listed as `dir/` is
not a file). The manifest carries that as `branch` (`SessionMoveBranchSchema`);
`session.move.preview {sessionId, from?}` answers the same reading for the
confirm dialog, which says "Branch ios/home travels too · 3 uncommitted files
will be carried" or "No branch to carry" (`movePreviewLine`), and the host
chip shows the branch after the host name.

- The commits: when the repo has an `origin` and `git push -u origin
  <branch>` lands, the transport is `origin` and the receiver fetches. When
  there is no origin, the push fails, HEAD is detached, or the receiver
  cannot fetch from its own origin (it answers a fetch failure to
  `session.import.branch.commit`, or raises `BranchFetchFailed` on a pull),
  the commits cross as a `git bundle` over the link, made only after the
  receiver named the commits it already holds (`branchPlan.have`: its HEAD,
  its default branch, its copy of the branch), so the bundle is the
  difference; the receiver already holding the commit means `transport:
  'none'`. Bundles over 512 MiB are refused (push to origin first).
- The uncommitted changes: one patch, `git diff --binary HEAD` plus a
  `--no-index` diff of every untracked file, capped at 64 MiB (over it the
  changes stay and the toast says so). Nothing on the source is staged,
  stashed or reset; the source keeps its branch and its changes.
- The order (`remote/sessionMover.ts`): a push sends `session.import.begin`
  (the receiver plans the landing and lands the rows hidden at the planned
  cwd), then the blobs in 2 MiB chunks (`session.import.branch.chunk`, the
  patch then the bundle, each frame naming the whole blob's hash), then
  `session.import.branch.commit {transport, bundle, patch}`, and only then
  the parts. A pull lands the manifest, then `session.export.branch.begin
  {have}` (the source makes the bundle), `session.export.branch.chunk`, the
  local branch step, then the parts. The branch step is complete before any
  session part crosses; a failure in it aborts the move with the source whole.
- Where it lands (`planBranchLanding`): the receiver's repo is the mapped
  main checkout (else the mapped project cwd, else the workspace path). A
  checkout here that already has the branch is reused (`reuse`; fast-forwarded
  to the source's commit when clean, left at its own commit with a note
  otherwise). Else, when the source was on the branch directly and the
  project here is clean on its default branch, the branch is checked out in
  the project itself (`checkout`). Else a worktree at
  `<project>/.claude/worktrees/<branch with / as ->` (`worktree`), and the
  result says why (dirty project, another branch, the source was in a
  worktree). A branch that is ahead here, or a detached source, lands as a
  detached worktree at the source's commit (`detached`). The moved thread's
  cwd (and a subagent's that was the thread's) becomes that path; a worktree
  the move made is recorded in the host's `thread_resources` ledger when the
  host keeps one (`MoveHost.recordResource`), and an abort before the parts
  commit removes it (`undoBranchLanding`); a checkout the move switched goes
  back to the previous branch when the tree is clean.
- The patch is applied with `git apply --check` + `git apply`, then `--3way`
  on a tree that was clean before (a failed 3-way is undone, including the
  files it created). A patch that does not apply is kept at
  `<cwd>/.temp-code/moved-changes.patch` (`.temp-code/` excluded locally),
  the result says `patch: 'kept'`, and the thread gets one quiet row
  ("Moved here with branch … the patch is at …", a `status` event with a
  `detail`) once it is live on the receiver. The toast names where the branch
  landed, how the commits crossed and what happened to the changes
  (`moveNoticeLines`).
- A cwd that is not a git checkout moves as before: no branch, the dirty
  list named in the toast as what stayed.

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
own HOMEs, Claude config dirs and Codex homes, paired over the fixed port; the
Mac shop on ios/home with a tracked change and an untracked file, the box shop
a clone on master; a seeded thread with a subagent in the cold file, a fold, a
page and both transcripts moves Mac → box with the branch checked out there
and the patch applied, back with the Mac checkout reused, and out again; a
second thread in a Mac worktree lands in a box worktree and comes back with
its patch kept and the note on the thread). Unit tests:
`src/main/server/sessionMoveBranch.test.ts` (branch detection, push else
bundle, the bundle against what the receiver holds, the patch round trip,
checkout vs worktree vs reuse, the detached fallback, a kept patch, undo),
`src/main/server/sessionMove.test.ts` (both directions on temp databases and
temp repos, remap, tombstones, refusals, a corrupted part after the branch
step, the origin-to-bundle fallback, the settle rules) and the renderer's
`lib/tcserver/store.test.ts` and `lib/threadMove.test.ts`.
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
  above it. Settings → Hosts edits both: the policy in the host's Mac bridge
group, the folders in its Mac bridge settings dialog.
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
- What reaches the screen. A card is only ever a decision: a request that
  waits on the person. A command or job that runs, prompted or not, is a
  row of the thread's Activity section in its right panel and of the host's
  Mac bridge list on Settings → Hosts ("n commands running on this Mac from
  <host>", Stop per command and Stop all), and of the thread's "Mac
  approvals…" dialog; it is never a card or a toast. The server still marks
  a call admitted without a prompt `quiet` while
  `macBridge.showRunning.<envId>` is off (`runPresentation`, off by default
  under `full`); the desktop no longer reads that flag or offers the switch.
  Reads and writes that are admitted never made a request at all.
- The cards never fill the screen (`queueOf` in the renderer's
  lib/macBridge.ts): above a thread's composer, and in the stack for
  threads off screen, at most one waiting card per host, the oldest, with
  "and N more"; the next shows once it is decided.
- The load guard (`src/main/server/remote/macLoadGuard.ts`). Fifteen box
  threads once drove the Mac to a load average of 810 and nothing stopped
  them. Now, between the decision and the spawn of every command and job
  (never a read, listing, fetch or write):
  - Per host, `macBridge.maxRunning.<envId>` (default 4) caps the commands
    plus jobs running on the Mac at once. At the cap the next one waits its
    turn, in order.
  - The load watch samples `os.loadavg()[0]` and the core count every 15 s.
    Over `macBridge.loadLimit` (one setting for the Mac; default 2 × cores)
    every new command and job is held, whatever its host, until the load is
    back under three quarters of the limit (1.5 × cores by default): the
    hysteresis keeps a load bouncing around the limit from flapping the
    queue. A lower limit typed under the current load holds at once; a
    raised cap or limit releases at once.
  - A held call is not refused. Its request turns `status: 'held'` with a
    `held` block (reason `cap` | `load`, 1-based `position`, the load, the
    limit, the cores, the host's cap and running count), re-pushed on every
    change of standing, and the box thread's tool result is simply later.
    On the Mac it is a row after the running ones in the host's running
    list (the host's Mac bridge on Settings → Hosts) and in the thread's "Mac
    approvals…" dialog, never a card: "Waiting for the Mac · load 12.3 of
    8 · 3rd in line" (or "4 of 4 running"), with Stop, which takes it out of
    the line and fails the call as stopped. The count line says "n commands
    running on this Mac from <host> · m waiting". It waits only as long as
    the call's own deadline allows: a command until its approval window
    would eat into its timeout (so a command that starts still gets its
    whole `timeoutMs`), a job until the call's deadline; past that the call
    fails "the Mac stayed too busy" and the box thread may try again.
  - `macBridge.maxThreads.<envId>` (default 2) caps the Mac-local threads a
    host starts here ("Threads across hosts" below).
  - The pane shows it all on the host's row: "n running · m waiting · k
    threads" with the two caps as small fields (At once: running, threads),
    and once for the Mac, "Load 3.2 · 8 cores" with the limit field (empty
    follows the cores; "holding new commands until under 12" while it
    holds). `macBridge.limits.set {environmentId, maxRunning?, maxThreads?}`
    (null restores a default), `macBridge.loadLimit.set {limit | null}`,
    `macBridge.load.get` and `macBridge.admitThread {environmentId}` are
    local, like the rest of the pane's methods. One `[mac-bridge] load
    guard:` log line when the watch turns busy or calm, and one per call
    held, released, stopped or expired.
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
  (each rule with Remove, and Forget all) and the Remembered approvals group
  in This Mac's section of Settings → Hosts. A thread's rules also go when its host pushes
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

Pause and Stop (`src/main/server/macPause.ts` on the box; `mac.cancel` and
`mac.held` in `remote/macBridge.ts` on the Mac). A thread's Mac work follows
its status, subagents included (a thread is paused when it or any ancestor
is). Pausing a thread (`session.pause`, the strip's Pause, Pause all) cancels
every call of its still out on the Mac: the box answers each at once with
"cancelled: the thread was paused" (that is the tool result the harness sees)
and sends the Mac one `mac.cancel` per thread naming the calls, and the Mac
gives each what its Stop button sends (a waiting card is denied, a running
command killed) and ends the thread's interactive jobs as stopped (they stay
readable). Stop (`session.interrupt`) does the same with "cancelled: the
thread was stopped" for the whole root tree. While paused, a new command,
job or write from the thread or a subagent is held on the box in arrival
order and never sent: Continue lifts the hold in that order, and a call whose
own wait (its `timeoutMs`) would pass first is answered at once with
"refused: the thread is paused"; Stop refuses what is held. Reads are not
held: they reach the Mac marked `paused` and are answered only where they
need no prompt (a shared, managed or remembered folder, or full access); one
that would have asked is refused with the same text and raises no card. The
Mac lists what the box holds (`mac.held` carries the thread's whole held set
on every change) as `paused` rows (`mb_held_<id>`, status `paused`) in the
host's running list on Settings → Hosts and in the thread's "Mac
approvals…" dialog, with "Paused" where Stop would be, never as a card; they
go when the box releases or refuses them, or the link drops. The box pushes
`macBridge.held` (the count under the root) to its own clients and answers it
on `macBridge.thread.get`, so the paused strip reads "Build is paused, and 2
Mac jobs with it". This hold is the thread's state only: the load guard's
room-based wait is a different queue. Proof: the e2e's pause step marks the
thread running through the proof seam `session.markStatus`
(`TEMP_CODE_E2E_STATUS=1`, isolated instances only).

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

What a key may see and do of the bridge. Every `macBridge.*` method the
Mac's own pane reads is `local`, so the phone (or a box's /ui) reaches the
bridge through two narrow methods on the Mac's listener:
`macBridge.activity` (read) answers each saved host's caps and counts with
how many requests wait for a decision there (never the requests), the load
with its limit, and every call past the prompt (held with its standing,
running, or paused on its box; no folder, remember offer or deadline);
`macBridge.stop { id }` (operate) does what the Mac's Stop does for a
running or held call and refuses one that waits for a decision ("that
request waits for a decision on the Mac"). Deciding, remembering and every
setting stay the Mac's own. The phone shows them on a box's host detail
under "On <Mac>" (docs/IOS-DESIGN.md "Host activity").

### The fleet switches: Pause all, Resume all, Stop all, Archive done

Fifteen threads need one click, not fifteen. Every scope has the same five
rows, Mark all read first: a project's menu (the rail's row and the project
header; for a workspace linked across hosts the row's menu acts on every
copy, one `session.batch` per host), a host's submenu (in the rail's Hosts
row when more than one host is paired, `HostsRow` in chrome/HostRows.tsx), and the
View menu for every host at once (Pause All Threads, Resume All Threads, Stop
All Threads, Archive Finished Threads). No shortcuts: menu rows only. A row
with nothing to act on is disabled, not hidden. The phone has the same four
rows in its host and project menus (ios/TempCode/Sources/Shell/FleetSwitches.swift
over the client package's ThreadBatch.swift, the rules and copy ported
verbatim), with a medium sheet for the confirm and a status line for the
outcome; its scope is a host or a project, never everywhere.

What qualifies (`src/renderer/src/lib/threadBatch.ts`, roots only; a
subagent follows its parent):

| Row | Threads |
| --- | --- |
| Pause all | a turn in flight anywhere in the tree (running, starting, waiting on an approval), not paused |
| Resume all | paused anywhere in the tree, or stopped by a restart once that status exists |
| Stop all | the same running turns as Pause all; the turns end |
| Archive done | idle or done for at least ten minutes, read, nothing to continue, nothing paused |

Pause all, Stop all and Archive done confirm first, with the count read from
the store while the dialog shows ("Pause 15 running threads on the box?",
"Stop 1 running thread in temp-code?", "Archive 6 finished threads
everywhere?"); OK closes at once. Archive done adds "and remove their 6
worktrees and simulators" with a checkbox on by default when the threads hold
anything on the ledger (`setResourceCleanup` in threadBatch.ts, wired by
lib/threadResources.ts to the count of their live rows; see "Thread
resources" below). Resume all and Mark all read run at once.

The run is one `session.batch {action, ids, cleanup?}` per host (operate;
the hosts in parallel), which the registry answers through
`src/main/server/sessionBatch.ts`: each id mapped to its root once, the
existing per-session calls (`pauseRun`, `resumePausedRun`, `stopRun`,
`setArchived`) at most four in flight, every id answered in `succeeded` or
`failed` with its error; `cleanup` runs the registry's `resourceCleanup`
after each archive when a host has one. The result is one toast bottom
right, "Paused 14 · 1 failed: Search (harness not responding)", the failed
thread's title a link that opens it; a clean result fades after eight
seconds, one with a failure waits to be dismissed. Proof:
`bun run script:e2e-thread-batch` (a headless isolated instance with fake
providers: archive over five scratch threads, a subagent's id acting on its
root, pause/stop/resume over idle threads, a read key refused).

### Thread resources

What a thread creates outlives it unless something remembers: the fifteen iOS
threads of 2026-10-20 each left a git worktree under `~/IdeaProjects/tc-ios/`
and a simulator on the Mac. The ledger is the `thread_resources` table on the
host the thread runs on (src/main/server/threadResources.ts,
src/shared/contract-resources.ts): one row per worktree, simulator or dev
instance, with the environment id of the host the resource lives on, filed
under the top-level thread (a subagent's rows carry its parent's id). Rows are
stamped, never deleted; one live row per resource per host, so a re-creation
after a removal is a new row. The phone reads the same ledger (`resources.list`,
`resources.listAll` and the `resources` push) into its Resources sheet
(ios/TempCode/Sources/Thread/ResourcesSheet.swift) and asks before archiving
a thread that holds something.

- **Detection** (threadResourcesParse.ts, pure) reads the command and what it
  printed, and records nothing the command did not demonstrably create: a
  `git worktree add` needs git's own `Preparing worktree` line (or a clean
  exit when the exit code is known; the line also says whether a new branch
  was made, which is the only branch a removal may delete), `xcrun simctl
  create` needs the UDID simctl printed, a dev launch needs its
  `TEMP_CODE_USER_DATA`. `simctl boot` records nothing; `git worktree
  remove`, `simctl delete` and the harness's `ExitWorktree remove` stamp the
  row removed. Three feeds: the session event stream (a Bash-like tool call,
  under any harness's name for it, paired with its result by callId, and the
  harness's `EnterWorktree`), every `mac.run` result on the box
  (`macTools.ts` tells the ledger, with the Mac's id and home), and a job's
  reads once the output proves the creation. A worktree the branch step of a
  thread move makes for the landed thread is recorded too (sessionMove.ts
  `recordResource`), so it goes with the thread's archive.
- **Removal** runs on the owning host, never touching anything not on the
  ledger (threadResourcesRemove.ts): `git worktree remove --force <path>`
  from the repo's main tree, then `git branch -D` only for the branch the
  command created and only when it has no commits ahead of its upstream (with
  no upstream: none that no remote has); otherwise the branch stays and the
  row's note says `branch x kept: 2 commits ahead of its upstream`. A
  simulator is `simctl shutdown` then `simctl delete`; a dev instance's
  userData dir is removed, never the installed app's. This host runs the
  argv itself (macRunner); a Mac runs it through the bridge as the thread
  with the thread's permission (a full-access thread is not prompted, the
  Mac's policy and remembered rules apply otherwise). A Mac with no live
  link leaves the row waiting (`remove_requested_at`, note "host offline,
  waiting for its link") and the next `peer.register` from it retries
  (`PeerCalls.onRegister`). A resource already gone is a removal with a note.
- **RPCs** (capabilities.ts): `resources.list { sessionId, includeRemoved? }`
  and `resources.listAll { kind?, environmentId? }` (read; the device list
  joins on the latter), `resources.remove { sessionId, ids? }` (operate),
  `session.archive { …, removeResources: true }` runs the removal after the
  archive lands. Ids only, never a caller path, so the fence has nothing to
  check. The host pushes `{ push: 'resources', sessionId, resources }` after
  every change.
- **Renderer**: the thread menu's "Resources…" (count once known) opens the
  panel (chrome/ThreadResourcesDialog.tsx): host · kind · label per row,
  Remove, "Waiting" while the host is offline, the last outcome under the
  row, Remove all. Archive on a thread with rows asks first: "and remove 2
  resources on the Mac" with the box on by default. A single archive calls
  `archiveThread(sessionId, { removeResources })` (lib/threadResources.ts);
  the fleet's Archive done sends `session.batch { cleanup: true }`, and the
  host's `registry.resourceCleanup` (index.ts) is `resources.remove` for each
  archived thread. The renderer reads every host's `resources.listAll` once
  per link-up, so the fleet's count is right before any menu opened.
- Proof: `bun run script:e2e-mac-bridge` makes a worktree on the Mac through
  the bridge, finds it on the box's ledger with the Mac's id, removes it, and
  checks the branch with an unpushed commit stayed with its note.

### Dev servers on the box

A box thread runs `bun run dev`, Vite binds `localhost:5173` on the box, and
the browser on the Mac has to reach it. The road is the Mac's own peer link:
no SSH key, no DNS, nothing public, and the box dials only its own loopback.

- **The ledger kind.** A dev server a thread opens is a `port` row in the
  thread resources ledger ("Thread resources" above): the port, the
  listening pid, the label (the URL the server announced, else the command)
  and the tool call that opened it (`pid`, `call_id`). Two detectors fill it
  (src/main/server/threadPorts.ts, the parsers in threadPortsParse.ts), both
  in the ledger's spirit: the server's own announcement in a shell call's
  output ("Local: http://localhost:5173", "ready on http://localhost:3000",
  "listening on :8080" and the usual Vite, Next, bun and express shapes,
  loopback or wildcard hosts only), recorded only when something listens on
  that port at the call's end; and a listener new under the thread's harness
  process tree (`ss -ltnpH` on Linux, `lsof -nP -iTCP -sTCP:LISTEN` on
  macOS, the tree from `ps`), polled every 2 s while a shell call runs and
  for 10 s after the last one. Listeners under the harness when its first
  call starts (an MCP server) are the baseline and never recorded. A port
  nothing listens on in two sweeps running (10 s apart) is stamped removed
  ("stopped listening"); a listener that changed pid (a watcher's restart)
  moves the row to the new pid. Removal (Stop in the panel, or archiving
  the thread with its resources) sends SIGTERM to the pid only while it
  still holds the port, waits 3 s and sends SIGKILL.
- **The sweep.** Agents mostly start a dev server with a background shell
  (Claude's `run_in_background`, `&`, nohup): the call returns at once, the
  output goes to a file and the server is reparented to init, so neither
  detector above sees it. A third one (src/main/server/portSweep.ts) reads
  every TCP listener on the host 3 s after a shell call settles and every
  15 s while any harness runs, and looks only at a port and pid it has not
  decided yet: with nothing new, a sweep is one `ss` (or `lsof`) and one
  `ps` and no per-process read. A new listener is credited to a thread by,
  in order: its ancestry (a harness pid above it); its environment on
  Linux (the `~t=<thread>` scope in the inherited ANTHROPIC_BASE_URL, else
  CLAUDE_PID, the harness pid every Claude tool call inherits; both survive
  the reparenting); the output file on its stdout or stderr that a shell
  call named (Claude's "Output is being written to: …/tasks/<id>.output",
  or the command's own `> /tmp/web.log`), which also names the call; and
  its working directory (or an ancestor's) inside a thread's cwd, the
  deepest folder first, then a live thread, then the most recently active,
  only a thread that existed before the process started and was live or
  active since. Skipped: ports under 1024, database, queue and debugger
  ports (5432, 3306, 6379, 27017, 9229 and the like), infrastructure and
  proxies by process name (postgres, redis, docker-proxy, sshd, cloudflared,
  ngrok, nginx, caddy, socat, electron, claude, codex…), a command line
  naming an MCP server or a proxy (`@modelcontextprotocol/…`,
  `chrome-devtools-mcp`, `mcp-server…`), a test run, typecheck or the gate
  anywhere above the listener (`scripts/gate.ts`, vitest, jest, `bun test`,
  their workers), all in src/shared/devServerRules.ts, which the shell-call
  detector applies too,
  the app's own process, the Dev Server button's runs,
  anything the harness started within 15 s of itself that no tool call
  started (an MCP server), and a port bound before any thread worked in its
  folder. A listener no thread claims is looked at again after 5 minutes.
  The row's label is the command of the call that named its port, else the
  server's own top process ("bun run dev"). `bun scripts/port-sweep-dry-
  run.ts` on the box prints every listener with its verdict and records
  nothing.
- **The Dev servers tab** (src/renderer/src/surfaces/DevServersPane.tsx,
  rules in lib/devServers.ts `liveServers`, state in lib/devPane.ts). The
  bottom dock's other occupant, under the dock's one bar
  (chrome/DockBar.tsx: the project's terminals and a "Dev servers" tab as
  line tabs, with the live count beside it, then New terminal and Hide);
  the tab shows only when a host can serve the project, a server runs or
  the pane is open (`devTabOf`). Its body is a 288px column, the starter
  (chrome/rail/DevServerPanel.tsx: the target, Run, and with two or more
  hosts the host to run on) above a list of the servers live on every
  connected host right now, newest first; the picked one's console beside
  it (surfaces/DevConsole.tsx). A row is a running Dev Server run (each
  host's `devServer.runs` at link-up, then its `dev-run` pushes) or a `port`
  row on a thread's ledger that is not removed and still passes the shared
  rules, titled by the run's target ("web · dev") or the thread's project and
  port ("cosmicweb :3007"), with the host glyph when two hosts are paired,
  "Open on the Mac :5174" under it when it opens here, and Stop. The host
  dropping a server takes its row out at once: no "Exited" rows, no
  history. With nothing live the console's place says what Run would start.
  The pane is closed until the person opens it (the thread menu's Dev
  server row toggles it, the bar's Dev servers tab opens it, a Run opens
  it on that run); nothing opens it on its own. It takes the dock's place
  while open, at the dock's height (the terminal dock keeps its own open
  flag and comes back when a terminal tab is picked or a terminal is asked
  for; Hide closes both),
  and remembers open and its height in localStorage `monocode.devPane`.
  The console reads an agent's server's log from the file its process
  writes (portLog.ts: fd 1 or 2 of the listener or the shell above it; a
  file Claude already deleted is still read through the fd; else the file
  the call named; else the call's output in the transcript), and a run's
  from `devServer.log` and its pushes. Dev server tabs saved in an older
  layout are dropped on load (workspaceSnapshot.ts).
- **The forward** (src/shared/contract-ports.ts). The box sends its live
  ports, the ledger's and the Dev Server button's, as one list down every
  registered Mac's link (`{ push: 'ports' }`, again on every change and
  whenever a Mac registers, so a link that came back forwards everything
  again). The Mac (remote/macPorts.ts) binds `127.0.0.1:<port>` itself: the
  same number when nothing on the Mac answers there over v4 or v6, else the
  next free one above it (up to 100 above), the number it had before a
  reconnect first; it answers `ports.bound` with what it took. Each
  connection it accepts is a stream on the link (remote/portStreams.ts):
  `ports.open` (the box dials 127.0.0.1, then ::1), `ports.data` frames of
  at most 64 KiB in base64 numbered per stream and written in order, and a
  close each way that counts the frames before it. A websocket is just TCP
  here, so HMR works. Backpressure: a side pauses its socket while the link
  holds more than 1 MiB unsent, or the Mac has 32 frames unanswered, and
  resumes below 256 KiB and half that. The box side is
  remote/portForward.ts.
- **The switch.** "Forward dev servers" in each host's Mac bridge settings
  on Settings → Hosts (`ports.forward.<envId>`, on by default; RPCs
  `ports.forwards` and `ports.setForwarding`, local). Off closes every
  forward of that host. The host's Mac bridge group lists what is
  forwarded, one row each with Open, the number here and, when it moved,
  which one was taken.
- **Where it shows.** A shell call's transcript row ends with "Open on the
  Mac :5174" for the port its command opened (src/renderer/src/surfaces/
  CallPortLink.tsx; "Open in browser" for a Mac thread's own server); the
  Resources panel lists the port with where it opens here, Open and Stop;
  and the thread hears the Mac's URL: claude in the shell call's own result
  through a PostToolUse hook ("Forwarded to http://localhost:5174 on the
  Mac (5173 is taken there)"), other harnesses as a `<dev-server>` line
  whispered into the turn once the Mac bound it (src/main/server/
  portTail.ts). A thread can hand that URL to a Mac child or a computer-use
  run. The Dev servers pane lists it while it listens.
- **The Dev Server button.** The thread header shows "Dev server" when a
  host can serve the thread's project, with a dot while one runs; it opens
  and closes the Dev servers pane. The rail's Dev tab
  (chrome/rail/DevServerPanel.tsx) starts one: the target (a menu when
  there are several), the host (this Mac or the box's copy of the project:
  the linked copy, else one paired by repo or folder name) and Run, which
  opens the pane on the new run. The host detects the targets itself
  (src/main/server/devTargets.ts): the `dev`, `start`, `serve`, `preview`,
  `web` and `storybook` scripts of the root package.json and of its
  workspaces (package.json `workspaces`, pnpm-workspace.yaml, else apps/*
  and packages/*), run with the lockfile's package manager; an Expo app; an
  Xcode app (an .xcworkspace, an .xcodeproj or an XcodeGen project.yml, two
  folders down at most, outside an Expo app) as a Mac-only target that
  builds for the simulator, installs on the booted one and streams its
  console. An Electron app's script is left out. A client names a target id,
  never a command (`devServer.targets`, `.runs`, `.log` read; `.start`, `.stop`,
  `.restart` operate). A run (src/main/server/devRuns.ts) is the login shell
  in its own process group, the log batched to every client as `dev-run`
  pushes with a 3,000-line replay; its ports are the listeners under its
  tree, and they go to the Macs with the ledger's.
- **Proof.** `bun run script:e2e-port-forward` (build first): two isolated
  instances on one machine, so every forward is the collision case. The Dev
  Server road (detect, run, forward, a GET and a websocket echo through the
  Mac's number, Stop), a thread's road through the seam
  `session.proofShellCall` (`TEMP_CODE_E2E_STATUS=1`: a shell call's rows
  with no harness; the ledger row, the forward, archive kills the server),
  the switch, and the link dropping. Unit tests: threadPortsParse, threadPorts,
  portSweep (every credit rule and the skip list), portLog, portTail, devTargets, devRuns, remote/portForward (the stream framing,
  backpressure, allocation, the switch, a link drop, a 3 MiB body), and the
  renderer's devPorts, devServers (the pane's rules: which rows show, removal
  on drop, nothing opens it), DevServersPane, DevServerPanel,
  workspaceSnapshot (old tabs dropped) and ThreadResourcesDialog.
- Not built yet: the host-based subdomain proxy behind the cookie, the
  phone's road to a box dev server.

### Threads across hosts

iOS builds, the simulator, screenshots, computer use and every Mac app
exist only on the Mac; the checkouts and the services a long build needs
live on the box. A thread on either host can start a thread, or spawn a
subagent, ON the other and supervise it from where it sits: the work runs
where the tools are, as an ordinary thread the other host lists the moment
it is created. The same objects are built on every host: the asking side
is `src/main/server/crossHostAgents.ts`, the serving side
`src/main/server/remote/crossHostThreads.ts`, and the socket between the
two runs whichever way it runs.

The app tools. `app_start_thread` and `spawn_agent` take `environmentId`:
`mac` for the thread's own Mac (its Mac bridge peer, `macBridge.thread.
<id>`, an ancestor's counts), else the only host registered here with the
`threads` offer; `box` for the only saved host this process holds a link
to; or a host's environment id, reached either way. Nothing named is the
bridge peer, else the only host reachable at all; several hosts and no name
is a refusal that lists them. The tool description ends with the hosts
reachable right now and their aliases (`hostParamDescription`). Every id
that comes back is `<environmentId>:<sessionId>` (`src/shared/
contract-crosshost.ts` `encodeAgentId`), and `send_to_agent`,
`check_agent`, `wait_for_agent`, `answer_agent`, `interrupt_agent`,
`list_agents` (each row with `host` and `hostName`) and `app_read_thread`
route by that id, so the model never learns which way the socket runs.
The thread's rules still gate a remote spawn (`resolveSpawnSpecs` in
orchestration.ts: approved models, effort, the caps, with the agents on
other hosts counted), and the thread on the other host inherits the
caller's permission, so a full-access thread runs unattended there and
`answer_agent` takes `allow` for its approvals. Codex reaches the same
fields through `scripts/app-mcp-bridge.mjs`.

Transport (`src/main/server/remote/hostLinks.ts`, one `HostTransport` for
both). A host that dialed this one and registered (`peer.register` with
`offers: ['mac-bridge', 'threads']`: the Mac on the box) is called with a
`peer.call` push down that socket, the Mac bridge's reverse RPC
(`remote/peerCalls.ts`), answered by `peer.reply`. A host this one dialed
(the box, from the Mac) is called with the same `thread.*` methods as
ordinary admin requests on its listener, over this host's own PeerLink
(`remote/peers.ts`); the box takes the caller to be the environment the
socket registered as (`PeerCalls.environmentOf`), never what the params
say, and a socket that never registered is refused. The methods:
`thread.start`, `thread.spawn`, `thread.send`, `thread.list`,
`thread.events` (at most 500 rows, each text field cut to 4,000 characters,
plus the files under the thread's attachments directory), `thread.check`,
`thread.wait`, `thread.interrupt`, `thread.answer`, `thread.pause`,
`thread.resume`, `thread.archive`, `thread.adopt` and `thread.read` (an
`@thread:` reference's digest; "One project across hosts: threads see each
other" below), every one with the calling thread as `caller` (its id, title and permission). One
`thread.wait` is at most 60 s; the caller loops windows until the thread
settles or the tool's timeout passes, so a link that drops mid-wait is seen
within a window and the call answers the last state it saw with
`linkDown: true` instead of hanging. The reports go the other way by the
same rule: a settle (`crossHost.settled`) and a batch landing
(`crossHost.landing`) are requests on the owner's listener when the runner
holds a link to it (the Mac → the box), else a `peer.call` down the owner's
registered socket (the box → the Mac), served by `CrossHostAgents.
onPeerPush`; a settle wakes the thread that started or spawned the thread
the way a local child's settle would, unless a wait already covers it.

The serving side (`remote/crossHostThreads.ts`, `handle` for a peer.call,
`handleRequest` for a request). Only a saved host may call, and every later
call must name a thread that host started, spawned or adopted here
(`crossHost.owner.<sessionId>`), so a host never reaches a thread of this
host's own or another host's. The caller names where it works (its project
cwd) and its work root; this host maps that through its path map, read in
both directions since a Mac path never matches the box side and the other
way round (`hostPathFor`: the inverse, `/srv/agents/work/temp-code` →
`~/IdeaProjects/temp-code`, then the forward map, then `<caller work root>/
<name>` → `<own work root>/<name>`), taking the first that exists; when
nothing is there the thread starts in this host's work root and the result
carries `cwdNote`. A thread.start is a root thread with its type and title,
under the project at that cwd, with the caller as `startedBy` and the
caller's batch (`masterId`) when it rides along; a thread.spawn is a child
whose `parentId` is the calling thread, so the fleet view lists it under
the thread it shows over the link (the spawn is recorded on the caller's
side, as `agent-spawned` with the host's environment id). A writing agent
gets a worktree there as it would locally. Such a child is not archived
with its parent (the parent is not here); archive it from here, or through
the batch. Admission: on a Mac the Mac bridge's thread cap
(`MacBridge.admitThread`, `macBridge.maxThreads.<envId>`, default 2, the
"Threads at once" in the host's Mac bridge settings on Settings → Hosts); on the box
its own `crossHost.maxThreads.<envId>` (default 4, cap 32, a settings row,
no pane), counting the threads that host started here that are live now
(`liveThreadsOf`); at the cap the start fails with the count and the key,
nothing is queued, the caller tries again later. The Mac's running cap and
load guard for commands are untouched.

What a thread started, spawned or adopted elsewhere is kept on the asking
side in `crossHost.children.<sessionId>` with the last state seen, so
`list_agents` still names it, marked `linkDown`, while the host is away.
`TEMP_CODE_WORK_ROOT` sets an isolated instance's work root (the proof's two
hosts). Proof: `bun run script:e2e-cross-host-threads`
(scripts/e2e-cross-host-threads.ts): two headless instances paired over the
fixed port under `xvfb-run`, two clones of one bare origin; a box thread
starts a thread on the Mac, sends it a message, waits for it to settle,
reads its rows, spawns an agent there and collects its report, lists both
with host; a Mac thread does the same on the box over its own link and gets
the box child's settle as a report; a master on the box runs a child on
each host (below); then the link drops and the box gets `linkDown` and the
refusal. No turn reaches a model there (TEMP_CODE_FAKE_PROVIDERS is a dead
origin; `session.markStatus` moves the children); the live pass is a box
thread with the Mac app open.

#### A master's batch across hosts

A thread a master (or a batch root) starts on another host is a batch
member: it carries the `masterId` there, reports its settles to the master
(the starter is the parent of a started thread's report), and the engine on
the master's host counts it (docs/master-threads.md "The children are root
threads"). The asking side keeps an index per master
(`crossHost.batch.<masterId>` → the parents' child records);
`Batches.members` joins the local roots and those records, keyed
`<envId>:<sessionId>`, and `batch.get` answers `children` with every one
(`sessionId`, `environmentId`, `title`, `status`, `threadType`, `provider`,
`model`; a far child with `seenAt` and `linkDown`). State comes from the
settle pushes as they arrive and from one `thread.list` per host when the
engine reviews a batch whose local children are done; a far child is done
when its host says `done` or `idle` (its host reports a settle only after a
turn). A host out of reach keeps the batch open with `blocked { why:
'unreachable', environmentId }` and the master told once; back, it
unblocks. Pause and Resume on the master reach the far children through
`thread.pause` / `thread.resume` (`Batches.cascade`, after the local
cascade); `batch.archive` archives them through `thread.archive`, lists
them in `succeeded`, and drops them from the index; `batch.adopt` takes a
`<envId>:<sessionId>` root through `thread.adopt` on its host (an unarchived
root of no batch there; the master's host becomes its owner) and answers
refusals per id. Landing: a far child lands through its own host's
`merge_branch`; before the fast-forward that host asks the owner
(`crossHost.landing` phase `ask`, after pushing the branch to origin):
under all-at-once the owner records `{ branch, host }` and the child reads
HELD, else the merge goes through there, pushes origin, and the owner
hears `landed`. The owner's land step then brings its project checkout to
the project branch's origin head (`fetchFastForward`: `git fetch origin
<target>`, `merge --ff-only origin/<target>`) before the gate and the
release, and merges a held far branch from `origin/<branch>` after a fetch
(`fastForwardFromOrigin`). An owner that cannot be asked refuses the
child's merge rather than landing blind. Nothing changes for the gate,
release, publish and deploy steps.

### Devices on the Mac

"What is crippling my machine" used to take a terminal. Settings → Remote
access on the Mac now has, under the Mac bridge's host rows, a block
"Devices on this Mac": one summary line ("3 simulators, 1 booted · iPhone 17
Pro Max paired · load 44.9 / 16 cores") and a compact table of every
simulator and every iPhone or iPad Xcode knows: device and runtime, a state
dot (green booted, muted shutdown, amber while changing) with the booted
ones' CPU share, the thread that holds the device, and on hover the
actions. In the box's /ui web mode (and on the phone, which reads the same
methods) the block is "Devices on <Mac>" for every Mac linked to the box,
served through the Mac's own main process.

What it reads, on the Mac and only on demand (`src/main/server/devices/`):

- `xcrun simctl list -j devices` (every runtime flattened, devices whose
  runtime is gone left out), `xcrun devicectl list devices --json-output`
  (iPhones and iPads: connected when a tunnel is up, paired when known but
  away, unavailable otherwise; Apple TVs and watches are not listed), one
  `ps -axo pid,pcpu,command` for the booted simulators' CPU (the %CPU of
  every process under `…/Devices/<UDID>/`, summed), `os.loadavg()` with the
  core count, and the Xcode in use: `DEVELOPER_DIR` when set, else the
  newest `/Applications/Xcode*.app` as `sort -V | tail -1` orders them
  (exactly what scripts/ios-device.sh picks; `Xcode-beta.app` sorts after
  `Xcode-26.app`), else what `xcode-select` names. Every xcrun call runs
  with `DEVELOPER_DIR` pinned to that Xcode, so a Mac whose `xcode-select`
  points at the Command Line Tools still answers. A pass younger than 5 s
  answers the next asker as is; overlapping askers share one pass; a tool
  that fails is one line under the table, the rest of the report stands.
  The parsers are pinned by fixtures captured on the user's Mac
  (`devices/fixtures/README.md`).
- The holder: the `thread_resources` ledger, by UDID, live rows of kind
  `simulator` whose `environment_id` is the Mac. The Mac joins its own
  ledger; a box joins its own ledger for that Mac when it forwards the
  report, so a box thread's simulator names the box thread (title and
  status when the host runs the thread, else the row's label). A database
  without the table, or a device no thread recorded, shows "—". The holder
  is a link to the thread.

The contract (`src/shared/contract-hostdevices.ts`, all capability read
unless said): `host.devices.hosts` lists the Macs a viewer may watch (this
Mac; on another host, the peers registered with the `devices` offer);
`host.devices` answers a report; `host.devices.watch` opens a viewer on the
socket and a `host.devices` push lands every 30 s until
`host.devices.unwatch` or the socket closes; `host.simulator.shutdown`,
`host.simulator.delete` and `host.device.openXcode` (operate) act. Nothing
runs with no viewer: the renderer watches only while the block is on
screen (`lib/hostDevices.ts`, two rows of one Mac share a viewer), the hub
(`HostDevicesHub`) keeps one 30 s timer per Mac while any socket watches
it, and a box's timer polls the Mac with a `host.devices` peer.call, so the
Mac gathers only when a box viewer is open too. The peer calls ride the Mac
bridge's reverse RPC under the `devices` offer the Mac adds to
`peer.register`; the Mac serves them against its own gatherer, performing
the actions itself, only for a host it knows.

The actions: Shutdown on a booted simulator; Delete behind a confirm that
names the holder ("Held by iOS: Home, running. Delete anyway?", or what is
removed when nobody holds it); on an iPhone only Open in Xcode, which
brings Xcode forward and clicks Window → Devices and Simulators through
System Events (without the accessibility permission Xcode comes up and the
person presses ⇧⌘2). From the box's web UI the same confirm shows and the
call goes to the Mac over the link. The table never animates beyond the
hover actions' opacity.

Tests: `devices/parse.test.ts` (the fixtures), `devices/hostDevices.test.ts`
(the gatherer, the holder join, the viewer timer that starts with the first
watcher and stops with the last, the peer serving), `devices/ledger.test.ts`,
`contract-hostdevices.test.ts` (the confirm text and the summary line),
`surfaces/MacDevices.dom.test.tsx` (the table, the empty state "No
simulators", the confirm) and `lib/hostDevices.dom.test.tsx` (watch on
mount, unwatch on unmount).
### The relay: the phone and the API reach the Mac through the box

A phone or a bot pairs with the box, the one host behind the tunnel. The
Mac's main process already holds an admin link to the box, so the box carries
the phone to the Mac over that link: the phone keeps one client per host, and
the Mac's client is a second socket on the box,
`/ws?ticket=<t>&host=<the Mac's environment id>` (the cookie upgrade takes
the same query). Nothing on the phone has to know the hop.

- **The lane.** The box answers the hello itself, under the Mac's id:
  `environmentId` is the Mac's, `caps` and `key` are the box key's, `build`
  is the Mac's, `via` is the box's id and `presence` the Mac's row. It then
  asks the Mac `relay.open` (a `peer.call` of the `relay` offer); the Mac
  serves the lane with its own `attach()` on a virtual socket
  (`remote/relayServe.ts` `RelaySocket`) under a remote principal with the
  box key's caps, named `<key> via <box>`, so the Mac's fence, gate and
  coalescer run as for any remote caller. Each request crosses as
  `relay.frame`; the Mac's frames come back in order as `relay.frames`
  (batched, one request in flight, 2 MiB a batch), its own hello swallowed.
- **What crosses.** `RELAY_METHODS` in `src/shared/contract-relay.ts`: every
  read and steering method the phone speaks (threads, projects, files, notes,
  queues, attachments, batches, plans, reviews, resources, GitHub, devices)
  and the project settings its sheet edits, and the Mac's own harness and
  memory sync status; the box's own deploy methods and its view of the Mac
  bridge's calls (`RELAY_NOT_CARRIED`) never cross. The box runs its
  own gate first: a `local` method or a cap the key lacks never crosses, and
  a method outside the table is `forbidden: <method> does not relay to another
  host`. The key's own push rows (`remote.push.*`) are answered by the box;
  `remote.push.activity` answers null.
- **Presence.** The Mac reports its screen and power (`src/main/presence.ts`:
  Electron's `powerMonitor` for lock, unlock, suspend and resume, the lock
  read once at boot from `ioreg`), in `peer.register`, on every change and
  every minute as `peer.presence`. The box adds the link (up or down, and
  since when) and the last time it heard the Mac, keeps every row in the
  `relay.hosts` setting so a down Mac is still listed after a restart, and
  pushes `presence` (the whole list) to every remote socket when a row's
  link, screen, power or name changes. `/api/hello` lists the rows for a key
  the box knows; a direct lane's hello carries them as `hosts`.

| Mac | Reads and steering | Opening Xcode | Refusal |
|---|---|---|---|
| available | run | run | — |
| locked | run | refused | `unavailable: the Mac is locked` |
| asleep | refused | refused | `unavailable: the Mac is asleep` |
| unreachable | refused | refused | `unavailable: the Mac is unreachable since 09:14` |

- **Refusals.** A locked Mac keeps running: only what needs its screen or
  its person is refused. A request in flight when the link drops answers
  `linkDown: the Mac is unreachable since 09:14` and the lane closes with
  4010; the Mac closing its end is 4011, another contract 4012, a revoked
  key 4001 as for every socket. A lane to a host that is not registered now
  is refused at the upgrade with 503. The time is the box's, with the date
  before it when it is not today.
- **/mcp.** Every tool takes `host`; a session id of the form
  `<envId>:<id>` routes to that host; `list_projects` names every host with
  its state, and `list_sessions` and `list_pending` merge every host that
  answers (docs/remote-mcp.md "Hosts"). A relayed call runs the Mac's own
  facade (`relay.facade`).
- **Seams.** `TEMP_CODE_PRESENCE=locked|unlocked|asleep|awake` sets an
  isolated instance's start state; `presence.set` (local) flips it under
  `TEMP_CODE_E2E_PRESENCE=1`. The iOS test server seeds four relayed hosts in
  one process (`remote/relayLoopback.ts`): Studio Mac available, locked,
  asleep and unreachable, with `POST /presence` to flip one.
- **Code.** The box: `remote/relay.ts` (`HostRelay`, `PeerRelayTransport`).
  The Mac: `remote/relayServe.ts` (`RelayServer`, `RelaySocket`). The wire:
  `src/shared/contract-relay.ts`. Proof: `bun run script:e2e-mac-relay`
  (two headless instances of the built tree; build first).

### Search across hosts

The search surface (⌘⇧F opens it; src/renderer/src/surfaces/SearchView.tsx)
asks every connected host the same query at once and shows one list. Each
host answers for itself: its threads by title (from the metas the window
already holds) and by transcript row (`session.search`), its copy of the
project by file name and file content (`search.project`, within the linked
project; see below), and its notes (`notes.search`, new, capability read).
Hosts answer in parallel and the rows land as each one does
(`runCrossHostSearch` in src/renderer/src/lib/crossHostSearch.ts streams a
snapshot after every answer); the footer says how long each host took
("box: 1.2 s", muted) and names a host that was skipped (its socket is not
open) or failed (no source answered). The ranking never looks at the host:
a message's score is its match quality (the best bm25 among the hits is 1,
a row a host had to scan or a loaded transcript matched in memory sits in
the middle) plus recency; titles and files keep their fuzzy scores.

Hits carry the host as the rail does: the host glyph (`chrome/HostGlyph.tsx`,
the name on hover) at the row's trailing edge, and nothing when only one
host is paired.
Enter opens a hit where it lives (a thread through the session store's
route to its host, a file through the catalog's host for its path, a note
in the notes view on its host, `focusNote`); ⌘↩ opens it in a new pane
beside the focused one (`openEditorTabBeside`, `openSessionBeside`). The
list never animates.

**The same project on two hosts.** src/renderer/src/lib/projectPairs.ts
pairs the Mac's checkout with the box's clone when both name the same
GitHub repository, else when their folders share a name (one member per
host). The file search on a host runs in that host's member of the current
project's pair; a file at the same relative path in both copies (a content
hit: the same line too) is one row that opens on the copy with the later
mtime (`search.project` matches now carry `mtime`) and says "· newer" in
its host mark, with "Also on <host>" as the row's title; two copies no
newer than each other keep the first host's with no claim. A `project:`
token matches the pair's name for both copies. This pairing is the seam the
cross-host project pairing through the path map replaces with its own
table when it lands.

**Filters** are typed in the box, nothing else: `host:box` (a host's name
or id; `mac` is the macOS host), `type:thread,file,note,project` (several
with commas, singular or plural), `project:<name>`. The one line under the
box names them and shows the active ones brighter. A token with nothing
after the colon is one still being typed and filters nothing.

**The index.** `session.search` was a `json_extract` + `instr` walk of
every row of `events`. Each host now keeps an FTS5 index over turn text
(src/main/server/turnIndex.ts): `events_fts` in the hot file and
`cold.events_fts` in the cold one hold the text of every user-text /
assistant-text row that is not a delta and not inside a tool call (what
the scan matched), with rowid `(ordinal << 32) | seq` where `turn_index`
gives each session an ordinal, so a session's rows are one rowid range and
a move or a delete is an indexed range operation. The index is kept current
three ways: `flushEvents()` inserts the text of every landed row whose
session is ready (a session made through `insertSession` is ready from its
first row); the backfill (`Store.backfillTurnIndex`, started after the
cold mover's first drain in server/index.ts and again hourly) indexes every
session without a ready `turn_index` row, newest first, in transactions of
5,000 event rows with a yield between them, marking it ready only when every
row is in; and `moveToCold` / `moveToHot` carry the rows between the files.
A session whose rows changed under the store (`forgetSessions`, a move
landing) is dropped and indexed again. While some session is not ready the
search unions a scan of those sessions' rows only (a PK lookup per session),
so nothing is unfindable during the first backfill. The query is every
whitespace token as a quoted term, all required, the last a prefix
(`ftsQuery`), ranked by bm25 with FTS5's own snippet; a hit carries `rank`
(negative, lower is better) so the surface can score it. Without FTS5 in
the SQLite build the hooks are no-ops and the search is the scan it was.

Measured on a copy of the box's database on 2026-10-21 (hot 426 MB with
919,554 rows of which 10,416 are turns, cold 3.9 GB with 7,657,678 rows of
which 82,016 are turns, 5,495 sessions; `bun run script:measure-turn-index
<copy>` prints this against a copy, never the live file):

| | scan before the index | FTS5 after |
| --- | --- | --- |
| "gateway", hot | 588 ms | 7 ms |
| "gateway", hot + cold | 5.8 s | 27 ms |
| "notarize", hot + cold | 5.1 s | 3 ms |
| "the" (a stop-word-like term, 200-row cap), hot | 502 ms | 72 ms |
| "the", hot + cold | 5.5 s | 338 ms |

The backfill indexed the 92,432 turn rows in 14.6 s (6,300 rows/s, in the
background, yielding between transactions) and grew the hot file by 5 MB
and the cold file by 107 MB. A two-word query is no longer a phrase: "session
move" found 1 row by scan and 128 rows with both words by FTS.

Proof: `bun run script:e2e-cross-host-search` (build first). Two headless
instances, each with a copy of the same workspace (the box's shared file
newer), threads whose logs are seeded into the databases with the instances
stopped (a database from before the index); both boot backfills index them
and `session.search` answers with bm25 (the delta and the tool-call row are
not hits; a two-word query needs both; a prefix matches; the archived
thread comes from the cold file's index with `archived: true`),
`search.project` carries the mtimes, `notes.search` finds the box's note;
then box issues an admin key and mac saves box, and, as the surface does,
the script holds a read key for box, mints a ticket, upgrades `/ws` and
runs the same query on box over the remote listener while asking mac on its
local socket, merges by rank, reads the shared file's box copy with its
mtime, and sees `search.project` outside the project refused by the fence.
Unit tests: src/main/server/db-fts.test.ts (the index, the backfill, the
moves, the deletes, the ranking, the no-FTS fallback, `notes.search`),
src/renderer/src/lib/crossHostSearch.test.ts and projectPairs.test.ts (the
filters, the streaming runner, the merge, the de-dup rule, the pairing),
src/renderer/src/surfaces/SearchView.dom.test.tsx (a row per kind with its
host mark, the folded file, the footer, the keys).

### Opening a box file on the Mac

A box thread's diff, transcript and file tree name box paths
(`/srv/agents/work/<X>/…`), which the Mac cannot open as they are. Read in
the Mac app, the file worth opening is the Mac's own checkout, so opening it
is a local action: the path is translated and the Mac's editor comes
forward.

- **Where.** The diff panel's rows (an icon beside stage/discard on hover),
  the right-click menu on a path in the transcript, and the file tree's
  context menu (files only; `⌥⏎` on the selected row does the same). The
  item says **Open on the Mac** when the path's host is not this machine
  and **Open in <editor>** (IntelliJ IDEA, VS Code or Xcode) when it is;
  it is absent when no editor is installed here. No animation: the editor
  takes focus, the app does not move.
- **The editor.** Settings → Editor → Open files in: Auto (the first of IDEA,
  VS Code and Xcode installed), or one of them; the `editor.command`
  setting in the settings table (src/main/editorLaunch.ts). The launcher
  is asked of the login shell (`whence -p idea` / `type -P code`), else the
  usual install paths. Argument shapes: `idea --line N [--column C] path`,
  `code -g path:N[:C]`, `xed -l N path`. A Swift file under an `ios/`
  folder goes to Xcode when Xcode is the chosen editor or IDEA is not
  installed, whatever Auto would otherwise pick. A launch that fails (no
  editor at all) opens the file in the app with the reason on the line
  above it.
- **The translation.** The harness sync's path map (`harness.status` →
  `pathMap`; the `harness.sync.pathMap` setting, else the shipped
  scripts/box/history-map.json) is Mac → box; `src/shared/openOnMac.ts`
  inverts it, roots before prefixes, longest match first: box
  `/srv/agents/work/<X>/…` ↔ Mac `~/IdeaProjects/<X>/…` (or wherever the
  map says), `/srv/agents/home/…` ↔ `~/…`. A path no entry covers maps to
  nothing.
- **The decision** (`decideOpen`): both hosts hash the file (`fs.digest`,
  a read-capability, fenced method: sha256 per path, null when missing).
  Same bytes on the Mac → the editor opens the Mac copy at the same line.
  Otherwise the box's version opens in the app's own editor, read-only,
  with one line above it:
  - *Mac copy differs: on branch X here* and **Open the Mac copy anyway**
    when the Mac has the file with other content (X is the Mac checkout's
    current branch, from `git.branches` on the mapped project root);
  - *No Mac copy: on branch X here* and **Open the project anyway** when
    the Mac has the project (the mapped cwd is a directory) but not the
    file (the thread is on a branch the Mac has not checked out);
  - *Not checked out on the Mac* or *Only on <host>* with no action when
    the project is not here or nothing maps the path.
  A file the box deleted but the Mac still has opens the Mac copy. The
  note travels onto a tab already open for the path and a plain open
  clears it.
- **The reverse hides.** A Mac thread read from the box's `/ui` (web mode)
  has no editor to hand a file to: `window.api.editor.config()` answers
  null there and on a headless host, and every "Open in …" item and the
  Settings row stay hidden. The in-app editor still shows the file as the
  Mac holds it.
- Tests: src/main/editorLaunch.test.ts (the argument shapes, the choice,
  the launcher with a stubbed spawner), src/shared/openOnMac.test.ts (the
  mapping, the decisions, the notes), src/renderer/src/lib/openInEditor.test.ts
  (the label per host, the remote plan), FileNoteBar.dom.test.tsx and the
  note case in layout.test.ts.

### A box thread's files and images open from the box

A click on a path in a box thread's transcript (a file the Read tool read,
an image the thread was given, a link in its markdown) used to pick the
host from the path alone: the catalog's project or workspace that holds
it, else this machine. A path outside every root (`/tmp/shot.png`, a file
under the agents' home, a folder under a workspace but outside a project)
went to the Mac's disk and said "file not found"; a path the Mac also has
outside its media roots (one the thread fetched through the bridge) fell
to the text path and said "Binary files cannot be edited."; an image under
a box project got a media URL the box minted, which the Mac's asset handler
could not look up, so it never decoded. Only the attachment chips worked,
because they always asked the thread's host (`attachment.read`).

- **The rule** (`src/renderer/src/lib/pathHost.ts`, `hostForPath`): a
  catalog root is a definite answer (a box project's file is on the box, a
  Mac project's file the box thread named is on the Mac); outside every
  root the host of the thread that named the path; with no thread (the file
  tree, search, a drop) this machine. `hostOfPath(path, threadHost)` in
  lib/tcserver/projects.ts applies it from the catalog. The transcript's
  chips, its markdown links and code paths, the edit rows and the
  right-click menu read the thread's host off the transcript
  (`useTranscriptHost`) and pass it as `OpenFileOptions.environmentId`; a
  file tab opened that way carries `environmentId` (decided once at open),
  and the media gate, the CodeMirror and Monaco editors and the mtime
  watcher read, write and stat on that host. The attachment chips and the
  html_render rows take the same host.
- **The bytes.** `fs.media` stamps the host's environment id on every URL
  it mints (`tempcode-asset://file/<token>/<name>?v=<mtime>&host=<id>`,
  server/media.ts `setMediaHost`). The Mac's asset handler
  (src/main/assets.ts) serves its own id from its token table as before
  and, for another host's id, streams the file over the admin peer link
  with `media.read { token, offset, length }` (contract.ts; 2 MiB per
  answer, ids only: the token was minted for a path already inside that
  host's fence, and the answer never names the path), Range-aware for a
  video's seeks, nothing cached (an agent rewrites its screenshots). A host
  out of reach answers 503 with the reason; a token the host no longer has,
  404. `/asset/file/…` on the fixed port mirrors it for the box's own `/ui`.
- **A file that is not there** says so with the host's name: the editor's
  line reads "No such file on The box." (`openFailureText`); any other
  refusal keeps the host's words.
- Tests: pathHost.test.ts (the rule, the copy), MediaViewer.dom.test.tsx
  (the gate asks the host the tab names), openInEditor.test.ts (the label
  off the thread), media.test.ts (the stamped URL, `media.read`),
  assets.test.ts (the remote stream, ranges, 404 and 503), capabilities.test.ts.
  Proof: `bun run script:e2e-remote-media` (scripts/e2e-remote-media.ts;
  build first): two headless instances, box minting the URL for a 3 MiB
  PNG in its workspace, mac paired with an admin key serving that URL from
  its `/asset` mirror under a client key byte for byte, a Range, a suffix
  range and HEAD; the old host-less URL 404 on mac, a never-minted token
  404, box's own URL from its own table, and 503 with the reason once box
  is gone. On the box: ALL PASS.
## The launch mirror against a slow box

The desktop paints every host's rows from its launch mirror before any
socket is up (CLAUDE.md "Launch: the rail paints from the launch mirror"),
so a box that is asleep, far away or slow to answer no longer leaves its
rows in the rail blank. To play that case on purpose, run a host with
`TEMP_CODE_PEER_DELAY_MS=<ms>` (src/main/server/peerDelay.ts): every
request a remote principal makes there waits that long before it is
handled; the host's own local socket never waits. Isolated instances only.

`bun run script:e2e-launch-mirror` (scripts/e2e-launch-mirror.ts) is the
proof and the measurement: a headless box with a 3 s peer delay and 12
threads, a windowed desktop under xvfb driven over CDP, three cold starts
(pair; the saved host with the mirror emptied; the mirror in place after the
box renamed, archived, deleted and added a thread while the desktop was
down). It reads `tc:ready` and `tc:rail-complete` off the window's
performance marks; the second fires once every host's rows are on screen.

| cold start, 3 s peer delay, 12 threads on the box | tc:ready → rail complete |
| --- | --- |
| before: host saved, no mirror (two delayed round trips) | 6,026 ms |
| after: launch mirror | 11 ms |

Measured 2026-10-21 on the box (xvfb, software rendering). The reconcile
after the second start resumed from the saved cursor over
`session.changes`: the renamed row read its new title in place, the deleted
one left, the archived one archived, the new one appeared, and the mirror
was rewritten with the new cursor.

## The shape that scales

Hundreds of threads may exist on a host; a bounded number run, and the
thread on screen is answered before background work. Ten steps took the
host there (the plan: `.temp-code/plan-lFxuRUHIDd_1.md`).

**Before**, measured on the box on 2026-10-22 at 07:30Z with 33 to 38
threads running:

| Measure | Value |
|---|---|
| Loop lag (`loop` lines) | 466 lines; mean of means 75 ms; max 1,074 ms |
| `slow-request checkpoint.capture` | 7,854 in two log files; p50 889 ms, p90 5.3 s, max 16.8 s |
| Meta pushes per second | mean 175; 113 seconds over 1,000; max 13,122 |
| Claude CLI memory | 47 processes, 331 MB on average, 15.5 GB |
| Slice | MemoryHigh 80 GiB, MemoryMax 88 GiB |

**After** has no box column yet: the box was not re-measured when these
steps landed. Re-measure with the profiler and `stalls-summary.ts`
("Profiling the host" below) on a working day with 30 or more threads, and
add the column here. What the proofs measured on the Mac:

| Step | What changed | Proof |
|---|---|---|
| Profiler | `doctor.profile`, `currentLag()`, `untilLoopIdle()` | doctorProfile and stalls tests |
| Gateway parse | the scope carries the model (`;m=`); the gateway reads `model` off the body's first 1,024 bytes; no JSON.parse | `script:e2e-quota-routing`: a 429 is charged to the body's model |
| Checkpoints | the host captures from its own live edits; one manifest write and one sync per turn; capture, ensure and sync left the wire | `script:e2e-checkpoint-turn`: 9 to 11 git children per turn, none per path |
| Loop costs | an incremental session index; one serialization per frame; a coalescer on every socket; folds and the mirror read on the reader worker | a test: 13,000 meta changes in half a second reach a local socket as at most ten frames |
| Lane | `session.focus`, request lanes, duplicate reads joined | `script:e2e-interactive-lane`: focused reads p95 3.4 ms during 200 bulk requests; 15 git children instead of 600 |
| Honest loading | `loading`, `slow` and `failed` instead of an empty thread; request deadlines and retries | `script:e2e-loading-states`: about 1,000 samples, never the empty state |
| Board | `batch.board` answers children, a digest per child and the batch state in one reply; `board` and `batch` pushes (log deltas) go only to sockets watching the master; virtualized, memoized rows | MasterView test: 300 rows mount only the visible window, one child's change re-renders one row; `script:e2e-master-batch` asserts the answer; the renderer logs `board-paint master= n= ms=` |
| Gateway process | the byte path in an Electron utility process, respawned on its ports | `script:e2e-gateway-process`: killed mid-stream, back on the same port, the turn finished; warm start cold 338 ms, warm 67 ms first token |
| Admission | a running cap sized from memory | `script:e2e-queue`: a cap of two over six threads, oldest first, Start now past it |

**The lane.** A socket names the thread its focused pane shows
(`session.focus`). Requests about an interactive thread, and direct clicks
marked `lane: 'ui'`, run at once. Bulk reads (git status and diffs,
searches, `doctor.get`, the sync methods) run two at a time while the
loop's mean lag is under 50 ms, and a duplicate joins the one already
waiting or running. The host's own jobs wait for a quiet loop. CLAUDE.md
"The interactive lane" has the rules.

**The cap.** `admission.maxRunning` when pinned, else
floor((budget − reserve) / per-process RSS). The budget is the smaller of
the cgroup's `memory.high` or `memory.max` and the machine's RAM. The
reserve is the larger of 25% and 8 GiB on Linux, of 50% and 16 GiB on
macOS. The per-process figure is the median RSS of the live harnesses,
450 MB until five samples exist. Admission pauses while free memory is
under 10% of the budget. On the box that is near 120 threads; on a 48 GiB
Mac, near 54. Every harness process counts, roots and subagents; Start
now and the focused thread's sends go past it. Settings → Hosts has a
Running threads row in each host's section: "118 of 120 running  7 queued".

## Profiling the host

On the box, run `tc-local doctor.profile '{"seconds":15}'` (the local
client is `scripts/box/tc-local.mjs`). This admin RPC answers with `path`,
`bytes`, `seconds` and `samples`. `seconds` accepts 1–60 and defaults to 10;
`intervalUs` defaults to 1000. Only one capture runs at a time; another
request fails with `a profile is running`.

On the Mac, choose Help → "Profile the host (10 s)". It profiles the main
process and reveals the file in Finder when done. Both paths write to
`<userData>/logs/profiles/<timestamp>.cpuprofile` and keep the newest ten
files. The box uses `/srv/agents/temp-code-data/logs/profiles/`.

Read a capture with `bun scripts/profile-summary.ts <file.cpuprofile>`.
It prints the top 30 frames by self time, the shares of `(program)`,
`(garbage collector)` and `(idle)`, and the top 15 by total time including
descendants. Lines use one-based source line numbers; times come from the
sample deltas.

Run `bun scripts/stalls-summary.ts <stalls.log> [more files]` for loop lag,
slow request counts and percentiles, push rates, in-flight depth and timed
section counts. Both scripts run with plain Bun and no app imports, on
either host. Loop and push figures cover logged stall seconds only;
in-flight depth counts the entries in the log, capped at twelve.
`doctor.get` also answers with the last second's `loop` mean and max,
its `ewmaMs`, and all `inFlight` requests with their method and age in ms.

## Updating

For a ref already on GitHub, press "Deploy master…" in the Mac
app's Settings → Hosts (below, "Deploy from the app"), or run from
the Mac:

```sh
ssh box 'box-update master'
# Or pin a published tag or commit:
ssh box 'box-update v1.0.N'   # replace N with a tag published on GitHub
# As landon on the host:
sudo /usr/local/sbin/box-update master
```

### Warm start: pooled upstream sockets, pre-connect, the warm harness process

Three things cut the wait between Send and the first streamed token of a
new thread (feature thread of 2026-10-21; CLAUDE.md "Provider traffic" has
the rules, this is what runs on the box and what it measured).

- **Pooled upstream sockets.** aliax-core forwards every request through the
  fetch the host configures; ours (src/main/server/upstream.ts) keeps undici
  pools per (origin, account digest) for api.anthropic.com, HTTP/2, 32
  sockets per account, free sockets for 90 s, and reports per request
  whether the socket had carried one before. `TEMP_CODE_GATEWAY_TRACE=1`
  lines read `[gateway] POST /claude/~t=…/v1/messages → 200 reused=true h2`.
  chatgpt.com stays on Electron's net.fetch (Chromium's pool), `reused=n/a`.
- **Pre-connect.** A turn starting on an idle thread, or the composer of an
  idle thread gaining focus, opens (or refreshes) that account's socket
  with a `GET /`; one per account per minute, so a focus that flickers
  costs nothing. `[gateway] preconnect claude <account>: opened|refreshed`
  under the trace flag.
- **The warm harness process.** One pre-spawned Claude CLI (and one codex
  app-server where codex is installed) per host, started from the exact
  argv/cwd/env of the last thread that started, with its MCP servers
  attached and no session. The next thread of the same shape adopts it and
  the SDK initializes it with that thread's prompt; its gateway URL is the
  `~w=<id>` scope the gateway re-points at adoption. Three seconds after an
  adoption (or a cold start of another shape) a replacement spawns; ten
  minutes without a thread start retires it. It is never a session:
  `session.list`, running counts, spawn caps and the Mac load guard never
  see it. `tc-local harness.warm` shows the pools (`'{"retire":true}'`
  empties them); `TEMP_CODE_WARM_HARNESS=0` in /etc/temp-code.env turns
  warming off.

Measured on the box (`bun run script:e2e-warm-start`: an isolated headless
instance of the built tree, a fake Anthropic that streams one fixed answer,
chat threads in a scratch checkout, one turn each, timed from
`session.send` to the first `assistant-text` push; the agents user's
user-level MCP servers attach in every CLI). Run 2 of 2026-10-21, with run
1's medians beside it:

| run | Send → first token | notes |
| --- | --- | --- |
| warming off, 4 threads | 3138, 2898, 2354, 2371 ms (median 2.9 s; run 1: 2.1 s) | every thread spawns its CLI |
| warming on, thread 1 | 1755 ms | cold by construction: it becomes the shape |
| warming on, threads 2–4 | 185, 299, 473 ms (median 0.30 s; run 1: 0.17 s) | each adopted a warm process about 4 s old |
| another model after those | 2345 ms | another shape boots cold and re-shapes the pool |
| real claude-haiku-5-5, one thread, cold | 3056 ms | /srv/agents/work/l5-phone-scratch; HTTP/2; the pre-connect at Send opened the socket and all three requests of the turn reused it (`reused=true 3`, `reused=false 1`) |

The real warm figure is derived, since one real thread was the budget:
cold minus the harness boot the fake run measured (2.9 s − 0.3 s) is about
0.46 s. On the fake (HTTP/1.1) the CLI's startup `HEAD /api/hello` makes
undici drop its socket, so each thread's first POST opened one; the real
API is HTTP/2, where the HEAD rides the same session and nothing is dropped.
A socket count at the fake includes Chromium's own connections (usage
polls), so the gateway's `reused=` flags are the measure, not the count.

Codex: the box has no codex binary, so its warm app-server is unit-tested
only (a fake app-server answers initialize and thread/start). Adoption
there saves process start and the initialize handshake; MCP servers attach
at thread/start, after adoption.

### Knowing the box is behind: the deploy-drift mark

Nothing deploys the box on its own, so the Mac app marks a host that has
fallen behind master. Every host says what it runs in its hello frame and
in `/api/hello` for a caller it knows (`build`: release.json `n`, the
`1.0.N` version, the commit, the platform; `src/main/buildInfo.ts`). The
box's commit is its checkout's `.git/HEAD` when box-update built master
from a detached clone, and `tempcodeBuild.sha` in the build's package.json
when it laid out a release asset (scripts/release-pack-out.sh writes it,
there is no `.git`); a published Mac build carries the same key in the
bundled package.json, which release-publish.sh passes through
electron-builder's extraMetadata. The Mac's main process reads
`https://raw.githubusercontent.com/LandonDev/temp-code/master/release.json`
every ten minutes and again when a window comes forward after fifteen idle
minutes (`src/main/deployDrift.ts`, the updater's cadence; nothing faster,
no git, and a failed fetch keeps the last number); the local socket gets
the number with `deploy.master` and the `deploy-master` push, and the
main process's peer links keep each host's `build` on their state. The
renderer's `useDeployDrift(environmentId)` (`lib/deployDrift.ts`) yields
`{ behind, deployedVersion, masterVersion }` and `chrome/DeployDrift.tsx`
draws a muted tabular `+3` at the trailing edge of the host's row in the
rail's host rows and the host's header on Settings → Hosts,
with the tooltip
"3 releases behind master (runs v1.0.270, master is v1.0.273). Deploy
with: ssh box 'box-update master'" (a Mac host says "Publish with: bun run
release:publish"). Current, ahead, or unknown on either side draws nothing.
A headless host never fetches master; the box's own `/ui` shows no mark.

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

`box-update` lays the ref into a fresh build directory as agents: for a
`v1.0.N` tag it downloads the release's `temp-code-out-1.0.N.tar.gz` and
builds nothing, for master it clones the GitHub repo, fetches that ref and
runs `electron-vite build`; node_modules come from the current build when
bun.lock is unchanged, else from `bun install --frozen-lockfile` with
Electron's binary installed and the native modules rebuilt ("Build once"
below has the rules and the timings). It starts a headless trial with a private HOME, userData, TMPDIR,
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

The phone reads the same release.json itself (`MasterReleaseWatcher` in
the iOS client package: every ten minutes while a drift mark or a host
detail is on screen, and on foreground after fifteen idle minutes; a
failure keeps the last value), because `deploy.master` is local-only. It
shows the `+N` on the Hosts row and Home's host header and status row, and
the host detail's Build section names both versions with Deploy Master for
an admin key (`host.deploy`, the same trigger, its log in a sheet that
follows the tail through the box's restart).

### Deploy from the app

"Deploy master…" on the box's Deploy row in Settings → Hosts is the same `box-update master`, pressed in the app with the log streamed
back. `box-update` must run as root and the host runs as agents, so the app
never runs it: the root-owned trigger of stage 87
(scripts/box/87-deploy-trigger.sh) does. One-time install, from the Mac
checkout:

```sh
bash scripts/box/apply.sh --from 87 --through 87
```

What the stage puts in place, all idempotent:

- `/etc/tmpfiles.d/temp-code-deploy.conf`: `/run/temp-code/deploy`, root:agents
  1770 (tmpfs, recreated at boot). Sticky and group-writable: agents can drop
  and withdraw its own `request` and read the root-owned `log`, `ref` and
  `exit`, and nothing else of root's can go.
- `temp-code-deploy.path`: `PathExists=/run/temp-code/deploy/request` starts
  `temp-code-deploy.service`, a oneshot running
  `/usr/local/lib/temp-code/deploy-runner` (scripts/box/deploy-runner.sh) as
  root. The runner reads the one-line ref, takes `master` or a `v1.0.N` tag
  only (anything else is refused into the log with exit 2, nothing runs),
  removes `exit`, truncates `log`, writes `ref`, removes `request` (in that
  order, so the directory never reads as finished or idle between a request
  and its run), runs `box-update <ref>` with its output appended to `log`,
  and writes `exit` last with the status. `systemctl status
  temp-code-deploy.service` and the journal have the same output.

The app's side (src/main/server/hostJobs.ts `DeployTrigger`,
src/shared/contract-host.ts): `host.deploy {ref}` (admin, the Mac calls it
over the box's link) validates the ref, refuses when the directory is not
writable ("Deploy from the app is not installed on this host; run `bash
scripts/box/apply.sh --from 87 --through 87` from the Mac checkout once") or
a deploy is pending or running, and drops the request; `host.deployStatus`
reads the phase from the files alone (`request` pending, `log` without `exit`
running, `exit` done, nothing since boot idle), so it is right again after
the host restarts into the new build mid-deploy; `host.log {job: 'deploy'}`
answers the log so far and subscribes the socket to `host-log` pushes. A
request nobody picks up within 15 s is withdrawn and reported as the trigger
not running. The restart drops the Mac's link; the renderer asks for the log
again on link-up and the card keeps tailing (`src/renderer/src/lib/hostJobs.ts`).
The card says the box cannot be stopped mid-way (box-update rolls back on a
failed trial) and ends with "Deployed v1.0.N, the service is back" or the
failure's last lines. The confirm names the versions: what the box runs
(its package.json) against origin/master's in the Mac's release checkout.
Proof without root: `src/main/server/hostDeployRunner.test.ts` runs the
runner against a scratch directory and a fake `box-update`
(`TEMP_CODE_DEPLOY_DIR`, `TEMP_CODE_BOX_UPDATE`), and `hostJobs.test.ts`
drives the app's side through the same files. The Mac's "Publish Mac
release" button is the other half (CLAUDE.md "Releases").

### Publish a box release through the Mac peer

The publish peer modules (`src/main/server/remote/peerPublish.ts` on the box,
`macPublish.ts` on the Mac) publish a release the box has already cut and
pushed, as the `publish` step of a master's batch (docs/master-threads.md).
The Mac advertises `publish`; `publish.start` carries the box
thread's caller, the 40-character commit SHA, branch, `1.0.N` version and
notes. Only a saved host may call, and its caller id must match the link.

The Mac uses the Publisher's login-shell git in its release checkout to
fetch origin and pull the named branch with `--ff-only`. It refuses a HEAD
that differs from the requested SHA or a HEAD package.json version that
differs from the requested version. It then runs the Publisher with
`train: false`: only `bun run release:publish`, since running release.ts
again would cut another release. The local button still cuts then
publishes. The Publisher's dirty-tree, master-branch, feed-version and
running-job checks still apply.

The box picks the thread's bridge peer when it is online with the offer,
else the only registered publisher. No choice says `no Mac paired`;
several choices name the Macs. One call waits up to 90 minutes and streams
log chunks as lines through `peer.progress`. Its result carries `ok`,
`exit`, `version` and a one-line outcome (the last meaningful log line on
failure). A refused start rejects with the Mac's error text; a dropped link
says `the Mac went offline during the publish`. Stop sends `publish.stop`
to the same Mac with a 30-second deadline, then cancels the start call;
the Mac stops the Publisher's whole process group.

The result's text reads "Published 1.0.N in 4m12s" from the script's
`phase ✓ total` line, and the box then sends `release-available { version }`
down every registered Mac's socket (src/main/server/releaseAnnounce.ts), so
the installed app fetches the release that second and offers "Restart to
update"; the Mac's own Publisher had already asked its updater as the
script's `update` phase. A master on the Mac runs the same steps without
the link: `LocalPublish` for the publish and `remote/peerDeploy.ts` for
the box deploy over the Mac's link (docs/master-threads.md "The same
engine on the Mac").

### Build once: the release asset and the lockfile rule

The Mac's `bun run release:publish` already builds the tree it ships, and
`out/` (main, preload, renderer, boot.js) is platform-independent
JavaScript: nothing in it is decided at build time by the platform (the
Mac-only pieces, the native menu, the Appshots helper under
`resources/native`, the updater, are behind `process.platform` and
`existsSync` checks at runtime, and the helper is not in the tarball, so
Appshots disables itself on the box as it does in a dev tree). Only
node_modules has native parts. So the box no longer builds a published
release; it lays in what the Mac built, and installs node_modules only
when they changed.

**The asset.** The moment the electron-vite build is done, and while
electron-builder is still signing the app, release-publish.sh runs
`scripts/release-pack-out.sh`, which packs `out/`, package.json with the
commit under `tempcodeBuild.sha`, release.json, bun.lock, `scripts/box`
(the runner, `tc-local`, the probe, the history map), the history importer,
docs/box.md and a `build-manifest.json` (version, release number, commit,
contract version, bun.lock's sha256, when and on what it was built) into
`temp-code-out-1.0.N.tar.gz`, writes a sha256sum line beside it and
uploads both to the draft of the GitHub release `v1.0.N` (a red gate
deletes the draft with them). The dry run is
`scripts/release-publish.sh --pack-only [dist-dir]` (or `bun run
release:pack-out`): tar and sha from the `out/` already built, no Keychain,
nothing uploaded; `--dry-run` runs every local phase with its timing.

**What box-update does with it** (scripts/box/box-update.sh, the install
half in scripts/box/box-update-lib.sh, installed by stage 85 at
`/usr/local/lib/temp-code/box-update-lib.sh`; reapply stage 85 once to get
both):

- `box-update v1.0.N` fetches the `.sha256` first; a 404 means the release
  predates the asset and the launcher clones and builds from source as
  before (`SOURCE: release v1.0.N carries no temp-code-out asset`). Else it
  downloads the tarball, checks it with `sha256sum -c`, extracts it into the
  candidate and checks what the box runs: the three bundles, package.json's
  version equal to N and its `tempcodeBuild.sha` equal to the manifest's,
  a contract version in the manifest. The probe reads version and contract
  from the manifest, so the candidate needs no `src/`.
- `box-update master` clones and runs `electron-vite build` as before.
- node_modules, on both paths: when the candidate's bun.lock is
  byte-identical to the current build's and that build has an Electron
  binary, the current tree is hardlinked into the candidate (`cp -al`, 0.7 s
  for the 76,000 files; nothing writes into node_modules at runtime, and
  pruning the old build only drops its links). Otherwise
  `bun install --frozen-lockfile`, Electron's binary and
  `electron-builder install-app-deps` run in the build unit as today. The
  install keeps devDependencies: Electron itself and electron-builder are
  devDependencies, so a `--production` install would remove the runtime.
- The build's `build-manifest.json` gets a `deploy` block: `ref`, `source`
  (`asset` or `source`), `nodeModules` (`reused` or `installed`),
  `modulesFrom` (the build the tree came from), `lockfileSha256`, `at`; plus
  `version`, `contract`, `sha` and `release` (the drift mark reads the
  commit from package.json and the release number from the bundle, so the
  manifest is for an operator and the deploy log). The log says which path
  ran: `SOURCE: release asset … (sha256 verified)` or `SOURCE: clone of
  master at …`, `MODULES: reused from <build> (bun.lock unchanged, …)` or
  `MODULES: installing (<reason>)`, `BUILD: skipped; … is prebuilt and its
  modules are reused` or `BUILD: <ref> <sha> (<source>, modules <plan>)`.
- Trial, snapshot, commit, rollback and retention are unchanged.

**Expected deploy time** (measured on the box on 2026-10-21 with the 1.0.273
tree; the trial's health check, the snapshot and the restart are the same
on every path and add about a minute):

| Path | Lay out | node_modules | Build | Before the trial |
| --- | --- | --- | --- | --- |
| `v1.0.N`, bun.lock unchanged | download the 10 MB tarball, extract in 0.6 s | hardlinked, 1–5 s | none | under 30 s |
| `v1.0.N`, bun.lock changed | same | `bun install`, Electron, native rebuild: 1–3 min | none | 1–3 min |
| `master`, bun.lock unchanged | clone, ~20 s | hardlinked, 1–5 s | `electron-vite build`, ~3 min | 3–4 min |
| `master` with a changed bun.lock, or a release without the asset | clone | install, 1–3 min | build | 4–8 min (the whole deploy before this) |

The scratch proof (`scripts/box/prove-build-once.sh <tarball>`, as agents,
nothing root or live: the lib's steps into a build under /tmp with the live
current build's node_modules hardlinked, then a headless start with a
private HOME, userData, TMPDIR and port, `/healthz`, the hello and
box-probe.mjs) went from the tarball to an answering app in 10 s. The Mac
side's `--pack-only` packs the built tree in 2.5 s.

**What still forces work:** a changed bun.lock (any dependency or Electron
bump) installs node_modules once, on the first deploy after it;
`BOX_UPDATE_FRESH_MODULES=1 box-update <ref>` forces that install (for a
tree you distrust, or a package.json `postinstall` change with no lockfile
change, which the rule does not see); `master` always runs
`electron-vite build` on the box, since only a published release has a
tarball; a release from before the asset existed builds from source; a
current build with no Electron binary (an interrupted install) is never
copied. `BOX_UPDATE_ASSET_BASE=<url>` points the fetch at another feed
(the proof's local server). Proofs: `python3 scripts/box/test-build-once.py`
(no root: the pack step on a fake tree, the fetch over a local server with a
present, absent, corrupt and unreachable asset, the unpack checks, the
lockfile rule, the hardlinked copy, the build steps per path, the manifest
merge and the probe's read), and the root rehearsal
`scripts/box/test-history-maintenance.py` still drives the launcher end to
end with a mocked build.

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

A thread started or spawned on the Mac this way opens with the Mac
project's preamble (CLAUDE.md "Project preambles"), resolved on the Mac
from the project the box cwd maps onto: the box parent is unknown to the
Mac's store, so the child follows the project rather than the parent, and
`preamble: false` on the spawn spec rides the wire (`ThreadSpawnArgs`) to
opt it out.

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

## One project across hosts: the linker

A workspace or project row carries a link id (`wl_…`, `pl_…`) that its
copies on other hosts share. The linker
(`src/main/server/remote/projectLinks.ts`) stamps those ids. It runs on the
host that holds the admin link to the other (the Mac, to the box); the code
assumes no platform, so whichever host holds a link runs it for that link.

- **When.** On link-up, on a `workspaces` or `projects` push from the peer,
  on a catalog change here (not the ones its own stamps cause), and every 5
  minutes. Asks within 2 s fold into one run per host. A link that is down
  skips the run without a word.
- **What a run does.** It reads the peer's `workspace.list` and
  `project.list`, pairs rows with the rules in `src/shared/projectLinks.ts`
  (workspaces by GitHub repo, else folder name; projects by name inside
  paired workspaces; the oldest row when a host has two of a key), and
  decides each pair with `decideLink`: a side with an id gives it to the
  other, neither mints one, and on a conflict the settings home's id wins.
  The home is the copy off darwin (`settingsHomeOf`; a peer whose hello did
  not name its platform counts as the box), so the box's id wins whichever
  side runs the linker. Then one `registry.linkCatalog` here and one
  `catalog.link` there, each only when it has rows to stamp. A second run
  with nothing new reads twice and writes nothing.
- **What it never does.** It never removes a link: a row whose partner is
  gone keeps its id. It never gives an id to a second row on the same host
  (a box Alpha renamed to Beta keeps the link; a new Alpha there stays
  unlinked).
- **Status.** `projectLinker.status(hostId)` on the running server answers
  `{ lastRunAt, pairs: { workspaces, projects }, error? }`; no RPC yet.
- **Proof.** `src/main/server/remote/projectLinks.test.ts`.

### One project across hosts: settings live on the box

A linked project (one `linkId` on its copy on each host) keeps its settings
on one copy, its settings home: `settingsHomeOf` in
`src/shared/projectLinks.ts` names the copy whose host is not a Mac (by the
hello's `build.platform`), else the host whose id sorts first. The settings
are one bundle (`project.settings.get` / `.set`): name, archived, preamble,
account pins, review, plans, build and turn pass, with the time one of them
last changed on its home (`projects.settings_updated_at`). Every setter
stamps that time.

The Mac follows the box (`src/main/server/remote/projectSettingsSync.ts`).
On link-up, on the box's `projects` push and every 5 minutes, debounced per
host, it reads the box's `project.list`; for each linked copy whose home is
the box and whose stamp there is newer than the Mac's, it pulls the bundle
and writes it under the Mac's id with the box's stamp. A home that never
stamped a setting takes the Mac's bundle once instead (`project.settings.set`
there, the box's own name and archive kept), so what the Mac had before the
link reaches the box and a later forwarded write never swaps it for the
box's blanks; past that seed it never writes toward the box. So a rename
or an archive on the box reaches the Mac's row, and a Mac thread of the project opens with the box's preamble.

A settings write on the Mac for such a project (`project.rename`,
`project.archive`, `project.setPreamble`, `project.setAccounts`,
`project.settings.set`, and `review.set`, `plans.set`, `build.set`,
`turnpass.set` for a project) goes to the box: the same method on the box's
copy, then the box's bundle is written on the Mac, so the next pull has
nothing to do. An archive's git cleanup runs on the Mac's own checkout only.
With the box down the write is refused with
`refused: settings of <project> live on <host>; it is offline` and nothing
is written on the Mac. The Mac remembers which host holds a copy, and that
host's platform, in the settings row `project-settings-sync:peer:<envId>`,
so it refuses even after a restart with the box still down. An unlinked
project, and every write on the box itself, behave as before.

Tests: `remote/projectSettingsSync.test.ts` (the pull, an older stamp, a
rename and an archive following, the forwarded write, the refusal, the cold
refusal) and the linked-project case in `projectPreamble.test.ts`.

## One project across hosts: a far start lands in the linked project

A thread one host starts on another (`app_start_thread` or `spawn_agent`
with `environmentId`) carries the caller's project as link facts: the
project's and its workspace's link ids, its name, branch and mode, the
workspace folder, the project cwd and the workspace's GitHub repo.
`crossHostAgents.ts` reads them from the project ROW (`projectLinkFacts`
in sessions.ts), not from the thread's cwd; a row with no link id yet gets
one minted and stamped there, with the catalog pushed, so the far copy
carries an id that lasts. `app_start_thread` with `environmentId` no
longer refuses a `projectId` this host does not know: it sends the
caller's own project instead.

The far host's `CrossHostThreads.place()` asks `ensureLinked`
(src/main/server/projectLinks.ts, also the `project.ensureLinked` RPC)
for its copy, in this order:

1. a project with the link id;
2. else the workspace: by its link id, else the caller's workspace folder
   mapped onto this host (`hostPathFor`; a folder with no row gets a
   workspace row born with the link id), else the same GitHub repo;
3. in that workspace an unlinked project of the same name is adopted and
   stamped; else the project is created with the caller's name, branch
   and mode. A `worktree` copy checks out the caller's branch when this
   host has it (locally or on origin) and makes it otherwise; a worktree
   that fails becomes a `local` copy at the workspace path, and the
   thread's `cwdNote` says so.

The thread lands in that project with its cwd. With no workspace, the
start falls back to the path logic of "Threads across hosts": the work
root, `projectId` null, and the note. Admission runs first, so a refused
start makes no copy.

`dryRun: true` answers the same `{ cwd, exists, project, note }` and
changes nothing; a host with no checkout answers `cwd: null` and the note
"no checkout of <folder> on this host (looked for <path>)", which the
pickers show on a disabled host. Tests: projectLinks.test.ts (the order,
dryRun, and a real worktree in a scratch repo), crossHostThreads.test.ts,
crossHostAgents.test.ts, apptools.test.ts.

## One project across hosts: threads see each other

A message may name a thread on another host. The composer's `@` picker
lists every host's threads; for a thread on another host than the one the
draft runs on, it inserts `@thread:<host>:<id>`, the host's own id
(`env_…`), never the window's slot name (`threadToken` in
src/renderer/src/lib/threadMentions.ts). The thread attachment then carries
`environmentId` (lib/mentionAttachments.ts). Chips, links and titles read
the bare id, as the session store keys every host's rows by it.

On send, the host of the message asks the thread's host for it with
`thread.read` (contract-crosshost.ts; `CrossHostAgents.readThread`, served
in remote/crossHostThreads.ts). Unlike `thread.events`, it reads any thread
there, not only one the caller started: the person picked it. The answer is
the same digest a local reference gets (`cappedThreadDigest` in mirror.ts),
and it lands in the same `.temp-code/refs/<id>.md` file, or inline for a
thread with no project. A host out of reach, or one that does not know the
thread, leaves one line in its place: `thread "<title>" on <host> is
unreachable (<why>)`. A token naming the host itself reads the thread
there. The call gives up after 15 s.

The right panel's Agents rows (`childrenOf`, `useAgents` in
lib/threads/agents.ts) come from every host's rows: a child spawned on
another host has the parent's bare id as its `parentId`, so it shows under
its parent, and its `environmentId` names the host it lives on.

Proof: sessions-mentions.test.ts (a far digest in the refs file, inline,
unreachable, a token naming this host), crossHostAgents.test.ts and
crossHostThreads.test.ts (`thread.read`), threadMentions.test.ts,
mentionAttachments.test.ts and agents.test.ts.
