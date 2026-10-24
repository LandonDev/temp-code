import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'ios-duo-check.sh')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

type World = {
  xcode?: string
  runtime?: string
  duoType?: boolean
  sim?: boolean
  hinge?: string | null
  xcodegen?: boolean
  phone?: 'none' | 'disconnected' | 'connected'
  ddi?: 'ok' | 'bad' | 'none'
}

/** A fake Mac: an Xcode dir for the picker, a fake xcrun (TC_DUO_CHECK_XCRUN), hinge and xcodegen on PATH. */
function rig(w: World) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-duo-check-'))
  dirs.push(dir)
  const apps = join(dir, 'Applications')
  mkdirSync(join(apps, 'Xcode.app', 'Contents', 'Developer'), { recursive: true })
  writeFileSync(join(apps, 'Xcode.app', 'Contents', 'version.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${w.xcode ?? '27.1'}</string><key>ProductBuildVersion</key><string>27A9275</string></dict></plist>`)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  if (w.hinge !== null) {
    writeFileSync(join(bin, 'hinge'), `#!/bin/sh\necho "${w.hinge ?? '0.2.0'}"\n`)
    chmodSync(join(bin, 'hinge'), 0o755)
  }
  if (w.xcodegen ?? true) {
    writeFileSync(join(bin, 'xcodegen'), '#!/bin/sh\n')
    chmodSync(join(bin, 'xcodegen'), 0o755)
  }
  const runtime = w.runtime === '' ? '' : (w.runtime ?? '27.1')
  const rtId = `com.apple.CoreSimulator.SimRuntime.iOS-${runtime.replace('.', '-')}`
  const simMarker = join(dir, 'sim-created')
  const phone = w.phone ?? 'none'
  const phoneRow = phone === 'none' ? '' : `{"identifier":"PHONE-1","hardwareProperties":{"productType":"iPhone19,4","deviceType":"iPhone","reality":"physical"},"connectionProperties":{"tunnelState":"${phone === 'connected' ? 'connected' : 'disconnected'}","pairingState":"paired"},"deviceProperties":{"name":"Duo","osVersionNumber":"27.2"}}`
  const simRow = `{"identifier":"SIM-1","hardwareProperties":{"productType":"iPhone19,4","deviceType":"iPhone","reality":"simulated"},"connectionProperties":{"tunnelState":"connected"},"deviceProperties":{"osVersionNumber":"27.1"}}`
  const ddi = w.ddi ?? 'ok'
  writeFileSync(join(dir, 'xcrun'), `#!/bin/bash
echo "xcrun $*" >> "${dir}/calls.log"
case "$*" in
  "simctl list runtimes -j")
    if [ -n "${runtime}" ]; then echo '{"runtimes":[{"identifier":"${rtId}","version":"${runtime}","platform":"iOS","isAvailable":true}]}'; else echo '{"runtimes":[]}'; fi ;;
  "simctl list devicetypes -j")
    if [ "${w.duoType ?? true}" = true ]; then echo '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-Duo","name":"iPhone Duo"}]}'; else echo '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}]}'; fi ;;
  "simctl list devices -j")
    if [ "${w.sim ?? true}" = true ] || [ -f "${simMarker}" ]; then echo '{"devices":{"${rtId}":[{"name":"TempCode Duo","udid":"3483-DUO","state":"Shutdown","isAvailable":true}]}}'; else echo '{"devices":{"${rtId}":[{"name":"iPhone 17 Pro","udid":"X","state":"Shutdown","isAvailable":true}]}}'; fi ;;
  "simctl create TempCode Duo com.apple.CoreSimulator.SimDeviceType.iPhone-Duo ${rtId}")
    touch "${simMarker}"; echo 3483-DUO ;;
  "devicectl list devices --json-output "*)
    f=\${@: -1}; echo '{"result":{"devices":[${simRow}${phoneRow ? ',' + phoneRow : ''}]}}' > "$f" ;;
  "devicectl device info ddiServices --device PHONE-1 --json-output "*)
    f=\${@: -1}
    case "${ddi}" in
      ok) echo '{"result":{"buildUpdate":"27A9275","contentIsCompatible":true}}' > "$f" ;;
      bad) echo '{"result":{"buildUpdate":"27A9275","contentIsCompatible":false}}' > "$f" ;;
      none) echo '{"error":{"code":4016}}' > "$f" ;;
    esac ;;
  *) echo "fake xcrun: $*" >&2; exit 1 ;;
esac
`)
  chmodSync(join(dir, 'xcrun'), 0o755)
  return { dir, apps, bin, xcrun: join(dir, 'xcrun') }
}

function run(w: World, args: string[] = []) {
  const { apps, bin, xcrun } = rig(w)
  const { DEVELOPER_DIR: _dropped, ...base } = process.env
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...base, PATH: `${bin}:/usr/bin:/bin`, TC_XCODE_APPS_DIR: apps, TC_DUO_CHECK_XCRUN: xcrun }
  })
  return { status: r.status, lines: r.stdout.trim().split('\n'), err: r.stderr.trim() }
}

describe('scripts/ios-duo-check.sh', () => {
  it('every item present: six ok lines, exit 0', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.lines).toHaveLength(6)
    expect(r.lines.every((l) => l.startsWith('ok '))).toBe(true)
    expect(r.lines[0]).toContain('xcode: Xcode.app 27.1 27A9275')
    expect(r.lines[1]).toContain('runtime: 27.1')
    expect(r.lines[3]).toContain('simulator: TempCode Duo 3483-DUO (Shutdown)')
    expect(r.lines[4]).toContain('hinge: 0.2.0')
  })

  it('names each missing item with its fix and exits 2', () => {
    const r = run({ xcode: '27.0', runtime: '', duoType: false, sim: false, hinge: null, xcodegen: false })
    expect(r.status).toBe(2)
    expect(r.lines.filter((l) => l.startsWith('MISSING'))).toHaveLength(6)
    expect(r.lines[0]).toContain('below the 27.1')
    expect(r.lines[1]).toContain('xcodebuild -downloadPlatform iOS')
    expect(r.lines[2]).toContain('iPhone-Duo is not listed')
    expect(r.lines[3]).toContain('bun run ios:duo:check -- --create')
    expect(r.lines[4]).toContain('brew install artemnovichkov/tap/hinge')
    expect(r.lines[5]).toContain('brew install xcodegen')
  })

  it('an old hinge is missing too', () => {
    const r = run({ hinge: '0.1.3' })
    expect(r.status).toBe(2)
    expect(r.lines[4]).toContain('0.1.3 is older than 0.2.0')
  })

  it('--create makes the simulator once and reports it', () => {
    const r = run({ sim: false }, ['--create'])
    expect(r.status).toBe(0)
    expect(r.lines).toContain('created  simulator: TempCode Duo on com.apple.CoreSimulator.SimRuntime.iOS-27-1')
    expect(r.lines.find((l) => l.includes('simulator: TempCode Duo 3483-DUO'))).toBeTruthy()
    // Without a 27.1 runtime there is nothing to create on.
    expect(run({ sim: false, runtime: '' }, ['--create']).lines.some((l) => l.startsWith('created'))).toBe(false)
  })

  it('--device: the physical Duo, connected, with a compatible DDI; the simulator never counts', () => {
    expect(run({ phone: 'connected' }, ['--device'])).toMatchObject({ status: 0 })
    expect(run({ phone: 'connected' }, ['--device']).lines[6]).toContain('Duo PHONE-1 connected, iOS 27.2, DDI compatible')
    const none = run({ phone: 'none' }, ['--device'])
    expect(none.status).toBe(2)
    expect(none.lines[6]).toContain('no iPhone19,4')
    expect(run({ phone: 'disconnected' }, ['--device']).lines[6]).toContain('PHONE-1 is disconnected (iOS 27.2)')
    expect(run({ phone: 'connected', ddi: 'bad' }, ['--device']).lines[6]).toContain('DDI is not compatible')
    expect(run({ phone: 'connected', ddi: 'none' }, ['--device']).lines[6]).toContain('ddiServices did not answer')
  })

  it('an unknown argument is exit 2', () => {
    expect(run({}, ['--nope']).status).toBe(2)
  })
})
