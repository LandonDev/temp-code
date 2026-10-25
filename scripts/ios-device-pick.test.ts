import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'lib/pick-device.py')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

type Row = { id: string; model: string; type?: string; reality?: string; tunnel?: string; pairing?: string; name?: string; os?: string }
const row = (r: Row) => ({
  identifier: r.id,
  hardwareProperties: { productType: r.model, deviceType: r.type ?? 'iPhone', reality: r.reality ?? 'physical' },
  connectionProperties: { tunnelState: r.tunnel ?? 'disconnected', pairingState: r.pairing ?? 'paired' },
  deviceProperties: { name: r.name ?? "Landon's iPhone", osVersionNumber: r.os ?? '27.2' }
})

function pick(rows: Row[], args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-devices-'))
  dirs.push(dir)
  const file = join(dir, 'devices.json')
  writeFileSync(file, JSON.stringify({ result: { devices: rows.map(row) } }))
  return spawnSync('python3', [script, file, ...args], { encoding: 'utf8' }).stdout.trim()
}

const duo: Row = { id: 'DUO', model: 'iPhone19,4', os: '27.2' }
const proMax: Row = { id: 'PRO-MAX', model: 'iPhone18,2', os: '27.2' }
const sim: Row = { id: 'SIM', model: 'iPhone19,4', reality: 'simulated', tunnel: 'connected', os: '27.1' }
const tv: Row = { id: 'TV', model: 'AppleTV14,1', type: 'appleTV' }

describe('scripts/lib/pick-device.py', { timeout: 60_000 }, () => {
  it('the first paired iPhone when nothing narrows it; never a simulator or an Apple TV', () => {
    expect(pick([tv, sim, proMax, duo])).toBe('PRO-MAX')
  })

  it('--model picks by product type: both phones share a name', () => {
    expect(pick([proMax, duo], ['--model', 'iPhone19,4'])).toBe('DUO')
    expect(pick([proMax, duo], ['--model', 'iPhone18,2'])).toBe('PRO-MAX')
    expect(pick([proMax, duo], ['--model', 'iPhone20,1'])).toBe('')
    expect(pick([sim], ['--model', 'iPhone19,4'])).toBe('')
  })

  it('a connected phone beats one that is only paired', () => {
    expect(pick([proMax, { ...duo, tunnel: 'connected' }])).toBe('DUO')
    expect(pick([{ ...proMax, tunnel: 'connected' }, duo])).toBe('PRO-MAX')
  })

  it('--describe is the one line the build log prints', () => {
    expect(pick([{ ...duo, tunnel: 'connected' }], ['--model', 'iPhone19,4', '--describe'])).toBe("Landon's iPhone · iPhone19,4 · iOS 27.2 · connected")
  })

  it('an empty or broken listing is an empty answer', () => {
    expect(pick([])).toBe('')
    const dir = mkdtempSync(join(tmpdir(), 'tc-devices-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'devices.json'), 'not json')
    expect(spawnSync('python3', [script, join(dir, 'devices.json')], { encoding: 'utf8' }).stdout.trim()).toBe('')
  })
})
