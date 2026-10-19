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

## Remaining stages

Runtime, Electron, tunnel, backup, heartbeat, and verification details will be
recorded after the live checks finish.

## User steps

- Rotate the root password in the ReliableSite panel.
- Optional: attach Ubuntu Pro with your own token and enable Livepatch. No
  Pro subscription or token was attached by these scripts.
