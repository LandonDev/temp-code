#!/usr/bin/env python3
"""The build-once deploy path without root, a box or GitHub: the Mac packing
step (scripts/release-pack-out.sh) on a fake built tree, then every function
of box-update-lib.sh against the result: the asset fetch over a local HTTP
server (present, absent, corrupt), the unpack checks, the lockfile rule that
decides whether node_modules are reused, the hardlinked copy, the build steps
per path, the manifest merge and the version/contract read box-update's
probe makes. Run: python3 scripts/box/test-build-once.py
"""
import functools
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import threading

here = pathlib.Path(__file__).resolve().parent
repo = here.parent.parent
SHA = '0123456789abcdef0123456789abcdef01234567'


def lib(*args, env=None, check=True):
    """Run one box-update-lib.sh function the way box-update does, as this user."""
    return subprocess.run(['bash', '-c', 'source "$0" && "$@"', str(here / 'box-update-lib.sh'), *args],
                          text=True, capture_output=True, check=check, env=env, timeout=60)


def fake_tree(root, version='1.0.5', n=5, contract=7):
    for rel, text in {
        'out/main/boot.js': "require('./index.js')\n",
        'out/main/index.js': 'console.log("main")\n',
        'out/preload/index.js': '// preload\n',
        'out/renderer/index.html': '<!doctype html><title>t</title>\n',
        'package.json': '{\n  "name": "temp-code",\n  "version": "%s",\n  "main": "./out/main/boot.js"\n}\n' % version,
        'release.json': '{\n  "n": %d,\n  "notes": "x",\n  "ts": 1\n}\n' % n,
        'bun.lock': '{ "lockfileVersion": 1, "packages": { "electron": "39.8.10" } }\n',
        'src/shared/capabilities.ts': 'export const CONTRACT_VERSION = %d\n' % contract,
        'src/main/server/historyImport.ts': '// importer\n',
        'scripts/box/temp-code-run.sh': '#!/usr/bin/env bash\nexec electron .\n',
        'scripts/box/tc-local.mjs': '// tc-local\n',
        'scripts/box/box-probe.mjs': '// probe\n',
        'scripts/box/history-map.json': '{}\n',
        'docs/box.md': '# box\n',
        'out/renderer/.DS_Store': 'junk',
    }.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    shutil.copy2(repo / 'scripts/release-pack-out.sh', root / 'scripts/release-pack-out.sh')


def pack(tree, dist, *args, check=True):
    return subprocess.run(['bash', str(tree / 'scripts/release-pack-out.sh'), '--dist', str(dist), *args],
                          text=True, capture_output=True, check=check, timeout=120)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, 'http://127.0.0.1:%d' % server.server_address[1]


def fake_build(root, lock='lock-a', electron=True):
    root.mkdir(parents=True)
    (root / 'bun.lock').write_text(lock)
    (root / 'node_modules/electron/dist').mkdir(parents=True)
    (root / 'node_modules/.bin').mkdir()
    if electron:
        binary = root / 'node_modules/electron/dist/electron'
        binary.write_text('#!/bin/sh\n')
        binary.chmod(0o755)
    (root / 'node_modules/left-pad.js').write_text('x')
    return root


with tempfile.TemporaryDirectory(prefix='tc-build-once-') as temp:
    temp = pathlib.Path(temp)
    tree = temp / 'tree'
    fake_tree(tree)
    dist = temp / 'feed/v1.0.5'
    out = pack(tree, dist, '--sha', SHA)
    asset = dist / 'temp-code-out-1.0.5.tar.gz'
    assert asset.is_file() and (dist / 'temp-code-out-1.0.5.tar.gz.sha256').is_file(), out
    line = (dist / 'temp-code-out-1.0.5.tar.gz.sha256').read_text()
    assert line == '%s  temp-code-out-1.0.5.tar.gz\n' % digest(asset), line
    assert 'packed' in out.stdout and 'contract 7' in out.stdout, out.stdout
    with tarfile.open(asset) as tar:
        names = set(tar.getnames())
        manifest = json.load(tar.extractfile('./build-manifest.json'))
        pkg = json.load(tar.extractfile('./package.json'))
    for name in ('./out/main/boot.js', './out/main/index.js', './out/preload/index.js', './out/renderer/index.html',
                 './package.json', './release.json', './bun.lock', './build-manifest.json',
                 './scripts/box/temp-code-run.sh', './scripts/box/tc-local.mjs', './scripts/box/box-probe.mjs',
                 './src/main/server/historyImport.ts', './docs/box.md'):
        assert name in names, name
    assert not any(n.endswith('.DS_Store') for n in names), names
    assert pkg['tempcodeBuild']['sha'] == SHA and pkg['version'] == '1.0.5', pkg
    assert manifest['version'] == '1.0.5' and manifest['release'] == 5 and manifest['sha'] == SHA, manifest
    assert manifest['contract'] == 7 and manifest['lockfile']['sha256'] == digest(tree / 'bun.lock'), manifest
    assert manifest['asset'] == 'temp-code-out-1.0.5.tar.gz', manifest
    # Refusals: a bad commit, a version the release number disagrees with, no out/.
    assert pack(tree, dist, '--sha', 'abc', check=False).returncode == 1
    (tree / 'release.json').write_text('{\n  "n": 6,\n  "notes": "x",\n  "ts": 1\n}\n')
    assert 'disagree' in pack(tree, dist, '--sha', SHA, check=False).stderr
    (tree / 'release.json').write_text('{\n  "n": 5,\n  "notes": "x",\n  "ts": 1\n}\n')
    shutil.rmtree(tree / 'out')
    assert 'missing out/main/boot.js' in pack(tree, dist, '--sha', SHA, check=False).stderr
    print('PASS: release-pack-out.sh packs out/, the commit in package.json, the manifest and the sha256 line')

    # A corrupt copy: the tarball under another tag with the wrong digest, and one with a malformed digest file.
    bad = temp / 'feed/v1.0.7'
    bad.mkdir()
    shutil.copy2(asset, bad / 'temp-code-out-1.0.7.tar.gz')
    (bad / 'temp-code-out-1.0.7.tar.gz.sha256').write_text('0' * 64 + '  temp-code-out-1.0.7.tar.gz\n')
    malformed = temp / 'feed/v1.0.8'
    malformed.mkdir()
    shutil.copy2(asset, malformed / 'temp-code-out-1.0.8.tar.gz')
    (malformed / 'temp-code-out-1.0.8.tar.gz.sha256').write_text('<html>not a digest</html>\n')
    server, base = serve(temp / 'feed')
    env = dict(os.environ, BOX_UPDATE_ASSET_BASE=base)
    try:
        fetched = lib('fetch_asset', '1.0.5', str(temp / 'dl'), env=env)
        got = pathlib.Path(fetched.stdout.strip())
        assert got == temp / 'dl/temp-code-out-1.0.5.tar.gz' and digest(got) == digest(asset), fetched
        absent = lib('fetch_asset', '1.0.6', str(temp / 'dl6'), env=env, check=False)
        assert absent.returncode == 3 and not list((temp / 'dl6').iterdir()), absent
        corrupt = lib('fetch_asset', '1.0.7', str(temp / 'dl7'), env=env, check=False)
        assert corrupt.returncode == 1 and 'does not match its published sha256' in corrupt.stderr, corrupt
        junk = lib('fetch_asset', '1.0.8', str(temp / 'dl8'), env=env, check=False)
        assert junk.returncode == 1 and 'not a sha256sum line' in junk.stderr, junk
    finally:
        server.shutdown()
        server.server_close()
    down = lib('fetch_asset', '1.0.5', str(temp / 'dl9'), env=env, check=False)
    assert down.returncode == 1 and 'answered 000' in down.stderr, down
    print('PASS: fetch_asset verifies the digest, answers 3 for a release without the asset, 1 for corrupt or unreachable')

    candidate = temp / 'builds/build-1'
    candidate.mkdir(parents=True)
    unpacked = lib('unpack_asset', str(got), str(candidate), '1.0.5')
    assert unpacked.stdout.strip() == SHA, unpacked
    assert (candidate / 'out/main/boot.js').is_file() and (candidate / 'scripts/box/temp-code-run.sh').is_file()
    assert json.loads((candidate / 'package.json').read_text())['tempcodeBuild']['sha'] == SHA
    (temp / 'builds/build-x').mkdir()
    wrong = lib('unpack_asset', str(got), str(temp / 'builds/build-x'), '1.0.9', check=False)
    assert wrong.returncode == 1 and 'wanted 1.0.9' in wrong.stderr, wrong
    (temp / 'junk.tar.gz').write_text('not a tarball')
    junk = lib('unpack_asset', str(temp / 'junk.tar.gz'), str(temp / 'builds/build-x'), '1.0.5', check=False)
    assert junk.returncode == 1 and 'does not extract' in junk.stderr, junk
    assert lib('expected_of', str(candidate)).stdout.strip() == '1.0.5 7'
    print('PASS: unpack_asset lays out the tree, checks the version and the commit, and the probe reads the manifest')

    # The lockfile rule: node_modules come from the current build only when bun.lock is byte-identical.
    current = fake_build(temp / 'builds/current', lock='lock-a')
    same = fake_build(temp / 'builds/same', lock='lock-a')
    changed = fake_build(temp / 'builds/changed', lock='lock-b')
    lock_a = hashlib.sha256(b'lock-a').hexdigest()
    assert lib('modules_plan', str(same), str(current)).stdout.strip() == 'reuse ' + lock_a
    assert lib('modules_plan', str(changed), str(current)).stdout.strip().startswith('install bun.lock changed (')
    assert lib('modules_plan', str(same)).stdout.strip() == 'install no current build'
    assert lib('modules_plan', str(same), '').stdout.strip() == 'install no current build'
    forced = lib('modules_plan', str(same), str(current), env=dict(os.environ, BOX_UPDATE_FRESH_MODULES='1'))
    assert forced.stdout.strip() == 'install BOX_UPDATE_FRESH_MODULES=1'
    headless = fake_build(temp / 'builds/no-electron', lock='lock-a', electron=False)
    assert lib('modules_plan', str(same), str(headless)).stdout.strip() == 'install the current build has no Electron binary'
    (candidate / 'bun.lock').unlink()
    assert lib('modules_plan', str(candidate), str(current)).stdout.strip() == 'install the candidate has no bun.lock'
    assert lib('lockfile_digest', str(current)).stdout.strip() == lock_a
    assert lib('lockfile_digest', str(candidate)).stdout == ''
    print('PASS: modules_plan reuses only on an identical bun.lock with an Electron binary, and honours the override')

    target = temp / 'builds/target'
    target.mkdir()
    lib('link_modules', str(current), str(target))
    a = (current / 'node_modules/electron/dist/electron').stat()
    b = (target / 'node_modules/electron/dist/electron').stat()
    assert a.st_ino == b.st_ino and a.st_dev == b.st_dev and b.st_mode & 0o111, (a, b)
    assert (target / 'node_modules/left-pad.js').read_text() == 'x'
    again = lib('link_modules', str(current), str(target), check=False)
    assert again.returncode == 1 and 'already exists' in again.stderr, again
    print('PASS: link_modules hardlinks the tree and refuses to overwrite one')

    steps = lambda source, modules: lib('build_script', source, modules).stdout
    assert steps('asset', 'reuse') == ''
    assert steps('asset', 'install') == ('set -euo pipefail\nbun install --frozen-lockfile\n'
                                         '[[ -x node_modules/electron/dist/electron ]] || node node_modules/electron/install.js\n'
                                         'node_modules/.bin/electron-builder install-app-deps\n')
    assert steps('source', 'reuse') == 'set -euo pipefail\nnode_modules/.bin/electron-vite build\n'
    assert steps('source', 'install').endswith('install-app-deps\nnode_modules/.bin/electron-vite build\n')
    print('PASS: build_script runs only the steps a path still needs')

    lib('write_manifest', str(candidate), 'version=1.0.5', 'contract=json:7', 'sha=' + SHA, 'deploy.ref=v1.0.5',
        'deploy.source=asset', 'deploy.nodeModules=reused', 'deploy.modulesFrom=current', 'deploy.at=2026-10-21T00:00:00Z')
    manifest = json.loads((candidate / 'build-manifest.json').read_text())
    assert manifest['builtOn'] and manifest['asset'] == 'temp-code-out-1.0.5.tar.gz', manifest  # the Mac's fields survive
    assert manifest['deploy'] == {'ref': 'v1.0.5', 'source': 'asset', 'nodeModules': 'reused',
                                  'modulesFrom': 'current', 'at': '2026-10-21T00:00:00Z'}, manifest
    assert manifest['release'] == 5 and manifest['contract'] == 7, manifest
    lib('write_manifest', str(candidate), 'deploy.nodeModules=installed')
    manifest = json.loads((candidate / 'build-manifest.json').read_text())
    assert manifest['deploy']['nodeModules'] == 'installed' and manifest['deploy']['ref'] == 'v1.0.5', manifest
    # A source checkout has no manifest until box-update writes one: the probe reads src/.
    source = temp / 'builds/source'
    fake_tree(source, version='1.0.6', n=6, contract=9)
    assert lib('expected_of', str(source)).stdout.strip() == '1.0.6 9'
    lib('write_manifest', str(source), 'contract=json:9', 'deploy.source=source', 'deploy.nodeModules=installed')
    manifest = json.loads((source / 'build-manifest.json').read_text())
    assert manifest == {'contract': 9, 'deploy': {'source': 'source', 'nodeModules': 'installed'}, 'release': 6}, manifest
    bare = temp / 'builds/bare'
    bare.mkdir()
    (bare / 'package.json').write_text('{"version":"1.0.1"}')
    assert lib('expected_of', str(bare), check=False).returncode == 1
    print('PASS: write_manifest merges the deploy block over the Mac manifest; expected_of falls back to src/')
print('PASS: build-once deploy path')
