import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'ios-duo-pose.sh')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/**
 * A fake `hinge` and `xcrun` on PATH. hinge keeps the angle and orientation in
 * a state dir and logs every call; xcrun answers `devicectl device info
 * displays` from that state (the inner panel lit from 100°), or as the test
 * says with TC_FAKE_ACTIVE=both|none.
 */
function rig(): { bin: string; state: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-duo-pose-'))
  dirs.push(dir)
  const state = join(dir, 'state')
  const log = join(dir, 'calls.log')
  writeFileSync(join(dir, 'angle'), '180')
  writeFileSync(join(dir, 'orientation'), 'portrait')
  writeFileSync(join(dir, 'hinge'), `#!/bin/bash
echo "hinge $*" >> "${log}"
shift 2  # -d <udid>
case "$1" in
  close) echo 0 > "${dir}/angle" ;;
  open) echo 180 > "${dir}/angle" ;;
  orient) echo "$2" > "${dir}/orientation" ;;
  posture) echo "angle: $(cat "${dir}/angle").0"; echo "orientation: $(cat "${dir}/orientation")" ;;
  [0-9]*) echo "$1" > "${dir}/angle" ;;
  *) echo "fake hinge: $*" >&2; exit 1 ;;
esac
`)
  writeFileSync(join(dir, 'xcrun'), `#!/bin/bash
echo "xcrun $*" >> "${log}"
angle=$(cat "${dir}/angle")
case "\${TC_FAKE_ACTIVE:-}" in
  both) a1=true; a3=true ;;
  none) a1=false; a3=false ;;
  *) if [ "$angle" -ge 100 ]; then a1=false; a3=true; else a1=true; a3=false; fi ;;
esac
printf '{"result":{"displays":[{"name":"LCD","displayId":1,"active":%s},{"name":"LCD-1","displayId":3,"active":%s}]}}\\n' "$a1" "$a3"
`)
  chmodSync(join(dir, 'hinge'), 0o755)
  chmodSync(join(dir, 'xcrun'), 0o755)
  return { bin: dir, state, log }
}

function run(bin: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TC_DUO_SETTLE_BUDGET: '2', TC_DUO_SCENE_SETTLE: '0', ...env }
  })
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}
const calls = (log: string) => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('hinge ') && !l.includes('posture'))

describe('scripts/ios-duo-pose.sh', () => {
  it('folded: close, portrait, the outer panel lit', () => {
    const { bin, log } = rig()
    expect(run(bin, ['U', 'folded'])).toMatchObject({ status: 0, out: 'LCD' })
    expect(calls(log)).toEqual(['hinge -d U close', 'hinge -d U orient portrait'])
  })

  it('aliases are the same poses: fl is folded-landscape, up is unfolded-portrait', () => {
    const { bin, log } = rig()
    expect(run(bin, ['U', 'fl']).out).toBe('LCD')
    expect(calls(log)).toEqual(['hinge -d U close', 'hinge -d U orient landscape-left'])
    const second = rig()
    expect(run(second.bin, ['U', 'up']).out).toBe('LCD-1')
    expect(calls(second.log)).toEqual(['hinge -d U open', 'hinge -d U orient landscape-left'])
  })

  it('unfolded opens and lights the inner panel', () => {
    const { bin, log } = rig()
    expect(run(bin, ['U', 'ul']).out).toBe('LCD-1')
    expect(calls(log)).toEqual(['hinge -d U open', 'hinge -d U orient portrait'])
  })

  it('half-open closes first, then 130: the lit panel is path-dependent above 100°', () => {
    const { bin, log } = rig()
    expect(run(bin, ['U', 'half-open']).out).toBe('LCD-1')
    expect(calls(log)).toEqual(['hinge -d U close', 'hinge -d U 130', 'hinge -d U orient portrait'])
  })

  it('a pose whose panel never lights fails after the budget, naming what it read', () => {
    const { bin } = rig()
    const r = run(bin, ['U', 'folded'], { TC_FAKE_ACTIVE: 'none' })
    expect(r.status).toBe(1)
    expect(r.err).toContain('folded did not settle in 2s')
    expect(r.err).toContain('asked angle 0 portrait on LCD')
    expect(r.err).toContain('on neither')
  })

  it('lit prints the active panel, and falls back to the table by angle when neither or both read active', () => {
    const { bin } = rig()
    expect(run(bin, ['U', 'lit']).out).toBe('LCD-1')
    expect(run(bin, ['U', 'lit'], { TC_FAKE_ACTIVE: 'both' }).out).toBe('LCD-1')
    run(bin, ['U', 'folded'])
    expect(run(bin, ['U', 'lit'], { TC_FAKE_ACTIVE: 'none' }).out).toBe('LCD')
  })

  it('state is one JSON line', () => {
    const { bin } = rig()
    run(bin, ['U', 'fl'])
    expect(JSON.parse(run(bin, ['U', 'state']).out)).toEqual({ angle: 0, orientation: 'landscape-left', lit: 'LCD' })
  })

  it('an unknown tag is exit 2 and touches nothing', () => {
    const { bin, log } = rig()
    const r = run(bin, ['U', 'sideways'])
    expect(r.status).toBe(2)
    expect(r.err).toContain('unknown pose sideways')
    expect(() => readFileSync(log)).toThrow()
    expect(run(bin, ['U']).status).toBe(2)
  })
})
