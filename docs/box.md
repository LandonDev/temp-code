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
maintenance window. Automatic reboot is off. Check `/var/run/reboot-required`.

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
- Restore drill (done once on 2026-10-19, repeat after any change):
  `restic restore latest --target /srv/prod/restore-check --include /srv/agents/backups/sqlite`,
  then `sqlite3 <file> 'PRAGMA quick_check'`, then remove the target.

The Mac side is scripts/mac/backup.sh installed by scripts/mac/install-backup.sh
as the launchd agent `dev.landon.tempcode.backup` (03:30 daily, log in
`~/Library/Logs/tempcode-backup.log`): same snapshot step over
`~/Library/Application Support/temp-code`, including `checkpoints/`.

## Heartbeat (installed, disabled)

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
- **U — launcher:** run app child processes as agents within `agents.slice`;
  use the lingering user manager or an explicit system unit. Do not use root
  or the Docker socket. Preserve the 7677 listener and app data while adding
  update and rollback handling. Bun's path is `/srv/agents/home/.bun/bin/bun`.
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

Live checks on 2026-10-19:

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
- Optional: attach Ubuntu Pro with your own token and enable Livepatch. No
  Pro subscription or token was attached by these scripts.
- Supply R2 bucket credentials and a restic encryption password in the paths
  above, test a restore, then enable backups.
- When the hub ships, set its HTTPS URL and token, test a heartbeat, then
  enable that timer.

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
| Checkout | `/srv/agents/temp-code`, owned by agents, detached at the deployed commit |
| Data (database, environment.json, tls, server.json) | `/srv/agents/temp-code-data`, mode 700 |
| Unit | `/etc/systemd/system/temp-code.service`: `User=agents`, `Slice=agents.slice`, `Restart=always`, `LimitNOFILE=1048576` |
| ExecStart | `scripts/box/temp-code-run.sh`: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a … dbus-run-session -- node_modules/electron/dist/electron .` |
| Environment | `/etc/temp-code.env` (root, 600, managed): `TEMP_CODE_USER_DATA=/srv/agents/temp-code-data`, `TEMP_CODE_HEADLESS=1`, `TEMP_CODE_CLAIM_SHIM=1`, `AGENT_CLI_CREDENTIAL_STORE=file`, `TEMP_CODE_REMOTE_PORT=7677`, `NODE_ENV=production`, `SHELL=/bin/bash` |
| Secrets | `/etc/temp-code.secrets.env` (root, 600, optional, never written by the scripts); the unit reads it when present |
| AppArmor | `/etc/apparmor.d/temp-code` grants userns to the checkout's Electron, like the stage 55 proof |
| Local admin | `tc-local <method> [json]` (`/usr/local/bin`, runs `scripts/box/tc-local.mjs`) over the port in `<data>/server.json` |
| Logs | `journalctl -u temp-code` |

Stage `85-temp-code.sh` installs all of it and is safe to rerun:

```sh
scripts/box/apply.sh --from 85 --through 90        # deploy origin/master, verify
TEMP_CODE_REF=v1.0.240 scripts/box/apply.sh --from 85 --through 85   # a tag or sha
```

It fetches, checks out the ref detached and resets the tree hard, runs
`bun install --frozen-lockfile`, fetches Electron's binary and rebuilds
node-pty against it (bun runs no dependency lifecycle scripts), runs
`electron-vite build` (the renderer is what `/ui` serves), and restarts the
unit when the build, the env file or the unit changed. `TEMP_CODE_REF=local`
builds the tree as it sits, for a tree synced by hand. Stage 90 checks the
unit, its slice and user, the listener and the AppArmor profile.

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

Proofs from the Mac: `TC_PAIR_CODES=<code1>,<code2> bun scripts/e2e-box-remote.ts`
(hello, bearer key, ticket, the socket on the ticket, Chrome on `/pair`, the
Secure cookie, the socket on the cookie, the Access gate on `/ui`). The
gateway's own proofs run on the box against fake upstreams:
`bun run script:e2e-gateway-unauthorized` and `script:e2e-gateway-failover`
in the checkout as agents. The hidden preview window is proven with
`tc-local app.htmlPreview` against a live session (see the log entry).

### Signing accounts in (thread G, with the user)

Nothing here copies credentials from the Mac; each CLI signs in on the box,
as agents, into the plain files aliax-core reads on Linux. The host picks the
new files up on its own (it owns the Aliax marker, so Claude tokens refresh).

```sh
ssh box
runuser -u agents -- env HOME=/srv/agents/home PATH=/srv/agents/home/.local/bin:/srv/agents/home/.npm-global/bin:/usr/bin:/bin bash -l
claude            # /login inside, pick "Claude account with subscription"; finish the browser step on the Mac; writes ~/.claude/.credentials.json
codex login --device-auth    # prints a code and a URL to open on the Mac; writes ~/.codex/auth.json
cursor-agent login           # same shape, if the cursor driver is wanted
gh auth login --web          # for the GitHub inbox and PR tools
```

Then prove one turn each from the Mac's browser on `/ui`, or over the socket:
create a workspace (`workspace.create` with a path under `/srv/agents/work`),
a thread (`session.create`, provider `claude`, model `claude-haiku-5-5` or the
cheapest Codex row, reasoning `low`), and `session.send` a one-line prompt;
the reply row arrives in `/ui`. API keys for the other providers go in
`/etc/temp-code.secrets.env`, then `systemctl restart temp-code`.

Still darwin-only by design: appshots, the Aliax browser-cookie sign-ins,
the IntelliJ engine's pinned artifact (`lsp.ts` has only `darwin-arm64`; the
Linux pin waits for a build that has not expired), and vibrancy. Known gap:
the local socket is the implicit admin for any process on the box's loopback,
as on a Mac; the box has only `prod` as another user.
