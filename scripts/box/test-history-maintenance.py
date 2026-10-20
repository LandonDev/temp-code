#!/usr/bin/env python3
"""Root-only Linux rehearsal: private mounts, fake service/build commands, local restic repo.
Never invokes the live service or opens the live data directory.
"""
import fcntl
import json
import os
import pathlib
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def wait_for(check):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.05)
    raise RuntimeError('rehearsal timed out')


def free_lock(path):
    with open(path, 'a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False


def inside():
    if not pathlib.Path('/run/tc-history-maintenance-proof').is_file() or not any(line.split()[4] == '/srv/agents' for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()):
        sys.exit('Refusing --inside outside the private rehearsal mounts')
    agents = pathlib.Path('/srv/agents')
    tools = agents / 'tools'
    update = ['bash', str(tools / 'box-update.sh'), 'master']
    data = agents / 'temp-code-data'
    source = agents / 'source'
    source.mkdir()
    data.mkdir()
    # Empty app-shaped databases are enough for a real importer dry run.
    for directory in (source, data):
        with sqlite3.connect(directory / 'temp-code.db') as db:
            db.executescript('''
              CREATE TABLE workspaces(id TEXT PRIMARY KEY, path TEXT);
              CREATE TABLE projects(id TEXT PRIMARY KEY, workspace_id TEXT, cwd TEXT, archived INTEGER);
              CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, cwd TEXT, plan_path TEXT, archived INTEGER);
              CREATE TABLE events(session_id TEXT, seq INTEGER, ts INTEGER, payload TEXT, PRIMARY KEY(session_id,seq));
              CREATE TABLE session_folds(session_id TEXT PRIMARY KEY);
              CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
            ''')
        with sqlite3.connect(directory / 'temp-code-cold.db') as db:
            db.execute('CREATE TABLE events(session_id TEXT, seq INTEGER, ts INTEGER, payload TEXT, PRIMARY KEY(session_id,seq))')
    rehearsal = agents / 'rehearsal'
    shutil.copytree(data, rehearsal)
    run(['chown', '-R', 'agents:agents', str(agents)])
    os.environ['BOX_HISTORY_BUILD'] = str(agents / 'build')
    importer = ['bash', str(tools / 'import-history.sh'), str(source), '--dry-run', '--into', str(rehearsal)]
    lock = '/run/lock/temp-code-update.lock'
    # Pause the node child after the real wrapper has acquired both locks.
    pause_import = agents / 'pause-import'
    pause_import.touch()
    proc = subprocess.Popen(importer, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        wait_for(lambda: (agents / 'import-held').exists() or proc.poll() is not None)
        if proc.poll() is not None:
            raise RuntimeError('importer exited early: ' + proc.communicate()[0])
        refused = subprocess.run(update, capture_output=True, text=True)
        assert refused.returncode and 'maintenance lock' in refused.stderr, refused
    finally:
        pause_import.unlink()
        output, _ = proc.communicate(timeout=30)
    assert proc.returncode == 0, output
    assert not (agents / 'service.log').exists()
    print('PASS: importer dry run holds maintenance lock; box-update refuses before service/build work')
    # No database on the first deployment; pause its git fetch to test the reverse.
    shutil.rmtree(data)
    data.mkdir()
    pause = agents / 'pause-update'
    pause.touch()
    proc = subprocess.Popen(update, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        wait_for(lambda: (agents / 'update-held').exists())
        refused = subprocess.run(importer, capture_output=True, text=True)
        assert refused.returncode and 'maintenance lock' in refused.stderr, refused
    finally:
        pause.unlink()
        output, _ = proc.communicate(timeout=30)
    assert proc.returncode == 0, output
    assert 'BOOTSTRAP:' in output and 'initial deployment has no SQLite files; skipped' in output, output
    builds = agents / 'temp-code-builds'
    assert (builds / 'current').is_symlink() and not (builds / 'previous').exists()
    print('PASS: box-update holds maintenance lock; importer refuses; first deployment succeeds without current or databases')
    old = (builds / 'current').resolve()
    # Seed a database so a second update exercises the pre-update snapshot.
    with sqlite3.connect(data / 'temp-code.db') as db:
        db.execute('CREATE TABLE proof(n INTEGER)')
        db.execute('INSERT INTO proof VALUES(1)')
    run(['chown', '-R', 'agents:agents', str(data)])
    pathlib.Path('/run/temp-code-update-force-post-flip-failure').touch()
    failed = subprocess.run(update, capture_output=True, text=True)
    assert failed.returncode and 'ROLLBACK PASS:' in failed.stdout, failed
    assert (builds / 'current').resolve() == old
    assert not pathlib.Path('/var/lib/box-baseline/temp-code-update.pending').exists()
    assert 'restart-locks-held' in (agents / 'service.log').read_text()
    assert free_lock(lock) and free_lock('/run/lock/box-backup.lock')
    print('PASS: both locks held through restart and rollback; failed update restores current')
    # A first deployment failure must stop and remove current without an old build.
    (builds / 'current').unlink()
    pathlib.Path('/run/temp-code-update-force-post-flip-failure').touch()
    failed = subprocess.run(update, capture_output=True, text=True)
    assert failed.returncode and 'initial deployment stopped; no previous build' in failed.stdout, failed
    assert not (builds / 'current').exists()
    print('PASS: failed first deployment stops and clears current with no previous build')
    # Upload generation A, then replace local snapshots with B without uploading.
    snap = agents / 'backups/sqlite'
    run(['bash', str(tools / 'sqlite-snapshot.sh'), str(data), str(snap)])
    generation = json.loads((snap / 'manifest.json').read_text())['generation']
    run(['restic', 'init'])
    run(['restic', 'backup', '--quiet', '--host', 'tempcode-box', '--tag', 'daily', str(snap)])
    with sqlite3.connect(data / 'temp-code.db') as db:
        db.execute('INSERT INTO proof VALUES(2)')
    run(['bash', str(tools / 'sqlite-snapshot.sh'), str(data), str(snap)])
    assert json.loads((snap / 'manifest.json').read_text())['generation'] != generation
    output = run(['bash', str(tools / 'restore-drill.sh')])
    assert 'RESTORE DRILL PASS' in output and generation in output, output
    print('PASS: restore drill compares uploaded generation A after local generation B replaces it')


if __name__ == '__main__':
    if os.geteuid() != 0 or sys.platform != 'linux':
        sys.exit('Run as root on Linux (unshare, mount, node, restic, jq and agents user required)')
    if '--inside' in sys.argv:
        inside()
        sys.exit(0)
    with tempfile.TemporaryDirectory(prefix='tc-maintenance-proof-') as temp:
        root = pathlib.Path(temp)
        root.chmod(0o755)
        agents = root / 'agents'
        tools = agents / 'tools'
        tools.mkdir(parents=True)
        scripts = pathlib.Path(__file__).resolve().parent
        for name in ('box-update.sh', 'import-history.sh', 'sqlite-snapshot.sh', 'restore-drill.sh', 'history-map.json'):
            shutil.copy2(scripts / name, tools / name)
        build = agents / 'build'
        (build / 'src/main/server').mkdir(parents=True)
        (build / 'scripts/box').mkdir(parents=True)
        shutil.copy2(scripts.parent.parent / 'src/main/server/historyImport.ts', build / 'src/main/server/historyImport.ts')
        shutil.copy2(tools / 'history-map.json', build / 'scripts/box/history-map.json')
        (agents / 'temp-code-builds').mkdir()
        bin_dir = agents / 'home/.local/bin'
        bin_dir.mkdir(parents=True)
        mocks = {
            'node': '''#!/bin/bash
if [[ $1 == */historyImport.ts && -f /srv/agents/pause-import ]]; then
  touch /srv/agents/import-held
  while [[ -f /srv/agents/pause-import ]]; do sleep .05; done
fi
exec /usr/bin/node "$@"
''',
            'git': '''#!/bin/bash
set -eu
if [[ $1 == clone ]]; then
  dest=${@: -1}; mkdir -p "$dest/.git" "$dest/src/shared"
  echo '{"version":"1.0.999"}' > "$dest/package.json"
  echo 'export const CONTRACT_VERSION = 1' > "$dest/src/shared/capabilities.ts"
elif [[ $* == *fetch* ]]; then
  touch /srv/agents/update-held
  while [[ -f /srv/agents/pause-update ]]; do sleep .05; done
elif [[ $* == *rev-parse* ]]; then echo 0123456789012345678901234567890123456789
fi
''',
            'systemd-run': '''#!/bin/bash
for arg; do
  case $arg in --setenv=TEMP_CODE_USER_DATA=*)
    dir=${arg#--setenv=TEMP_CODE_USER_DATA=}; echo '{}' > "$dir/server.json" ;;
  esac
done
''',
            'curl': '#!/bin/bash\nexit 0\n',
            'systemctl': '''#!/bin/bash
set -eu
echo "$*" >> /srv/agents/service.log
if [[ $1 == restart && $2 == temp-code.service ]]; then
  if flock -n /run/lock/temp-code-update.lock true || flock -n /run/lock/box-backup.lock true; then
    echo 'restart without both locks' >&2; exit 1
  fi
  echo restart-locks-held >> /srv/agents/service.log
  echo '{}' > /srv/agents/temp-code-data/server.json
fi
''',
        }
        for name, text in mocks.items():
            file = bin_dir / name
            file.write_text(text)
            file.chmod(0o755)
        for name in ('state', 'run/lock', 'lib', 'restic'):
            (root / name).mkdir(parents=True)
        (root / 'run/tc-history-maintenance-proof').touch()
        (root / 'lib/box-probe.mjs').write_text('process.exit(0)\n')
        # Local throwaway repo only. No live credentials enter this namespace.
        (root / 'restic/box.env').write_text('RESTIC_REPOSITORY=/srv/agents/restic-repo\nRESTIC_PASSWORD=local-rehearsal-only\n')
        env = dict(os.environ, PATH='/srv/agents/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                   RESTIC_REPOSITORY='/srv/agents/restic-repo', RESTIC_PASSWORD='local-rehearsal-only')
        mounts = [(agents, '/srv/agents'), (root / 'state', '/var/lib/box-baseline'),
                  (root / 'run', '/run'), (root / 'lib', '/usr/local/lib/temp-code'),
                  (root / 'restic', '/etc/restic'), (tools / 'sqlite-snapshot.sh', '/usr/local/sbin/box-sqlite-snapshot')]
        runner = root / 'runner.py'
        shutil.copy2(__file__, runner)
        commands = ['set -e', 'mount --make-rprivate /']
        commands += ['mount --bind ' + shlex.quote(str(src)) + ' ' + shlex.quote(dst) for src, dst in mounts]
        commands += ['exec python3 ' + shlex.quote(str(runner)) + ' --inside']
        subprocess.run(['unshare', '--mount', '--fork', 'bash', '-c', '\n'.join(commands)], env=env, check=True)
