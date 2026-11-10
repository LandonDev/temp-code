import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppInfo, Shot } from '@shared/computer/protocol'
import { formatAppsList, frontLine, mergeFront, outcomeOf, outcomeToPeer, renderText, type ComputerToolOutcome } from './result'
import { STALE_SHOTS_MS, landShot, nextShotNumber, pruneStaleShots } from './shots'

const win = (title: string, extra: Partial<NonNullable<AppInfo['windows']>[number]> = {}) => ({
  id: 1,
  title,
  frame: { x: 0, y: 0, w: 1, h: 1 },
  main: true,
  focused: false,
  minimized: false,
  onScreen: true,
  space: 'current' as const,
  ...extra
})

describe('formatAppsList', () => {
  it('one app a line, the active one first', () => {
    const apps: AppInfo[] = [
      { pid: 2, bundleId: 'com.apple.finder', name: 'Finder', active: false, hidden: true, windows: [] },
      { pid: 1, bundleId: 'com.apple.TextEdit', name: 'TextEdit', active: true, hidden: false, windows: [win('Untitled'), win('Notes.rtf', { minimized: true })] }
    ]
    expect(formatAppsList(apps, { name: 'Preview', launched: true })).toBe(
      [
        'Launched Preview',
        'TextEdit (com.apple.TextEdit) · active · windows: "Untitled", "Notes.rtf" minimized',
        'Finder (com.apple.finder) · hidden · no windows'
      ].join('\n')
    )
    expect(formatAppsList([], { name: 'Preview', launched: false })).toBe('Preview was already running')
  })
})

describe('the front line (§23.5)', () => {
  it('says nothing when the app stayed behind', () => {
    expect(frontLine('TextEdit', undefined)).toBeNull()
    expect(frontLine('TextEdit', { raised: false })).toBeNull()
  })

  it('words every outcome, the person\'s app named when known', () => {
    expect(frontLine('TextEdit', { raised: true, restored: 'restored', ms: 180 }, 'Safari')).toBe('TextEdit came to the front; Safari was put back in 180 ms')
    expect(frontLine('TextEdit', { raised: true, restored: 'restored' })).toBe("TextEdit came to the front; the person's app was put back")
    expect(frontLine('TextEdit', { raised: true, restored: 'person-chose' })).toBe('TextEdit came to the front; the person chose it, so it stays in front')
    expect(frontLine('TextEdit', { raised: true, restored: 'failed' })).toBe('TextEdit came to the front and could not be put back: tell the person')
    expect(frontLine('TextEdit', { raised: true, restored: 'hid-app' })).toBe('TextEdit kept taking the front, so it is hidden')
    expect(frontLine('TextEdit', { raised: true })).toBe('TextEdit came to the front')
  })

  it('says how long after the call a late steal came', () => {
    expect(frontLine('IntelliJ IDEA', { raised: true, restored: 'restored', ms: 90 }, 'Safari', 14_200)).toBe(
      'IntelliJ IDEA came to the front 14 s after the call; Safari was put back in 90 ms'
    )
  })

  it('merges two segments\' reports into the worse one', () => {
    const restored = { raised: true, restored: 'restored' as const, ms: 50 }
    const hid = { raised: true, restored: 'hid-app' as const }
    expect(mergeFront(undefined, undefined)).toBeUndefined()
    expect(mergeFront({ raised: false }, restored)).toEqual(restored)
    expect(mergeFront(restored, { raised: false })).toEqual(restored)
    expect(mergeFront(hid, restored)).toEqual(hid)
    expect(mergeFront(restored, hid)).toEqual(hid)
  })

  it("closes an action call's steps with the front line", () => {
    const step = { index: 0, action: 'left_click' as const, status: 'ok' as const, tier: 'ax' as const, effect: 'changed' as const }
    const o = outcomeOf([{ action: 'left_click', element: 3 }], { steps: [step], front: { raised: true, restored: 'restored', ms: 40 } }, [], new Map(), { app: 'TC Probe' }, 'Safari')
    expect(o.steps.at(-1)).toBe('TC Probe came to the front; Safari was put back in 40 ms')
  })
})

describe('the launch lines', () => {
  it('say what opened where, the other windows that changed and the front', () => {
    const text = formatAppsList([], {
      name: 'TextEdit',
      launched: false,
      open: ['/tmp/probe.txt'],
      window: { id: 9, title: 'probe.txt' },
      others: [{ id: 8, title: 'Untitled — iCloud' }],
      front: { raised: true, restored: 'restored', ms: 120 },
      person: 'Safari'
    })
    expect(text).toBe(
      [
        'TextEdit was already running',
        'Opened probe.txt in window "probe.txt"',
        'Its other windows changed: "Untitled — iCloud"',
        'TextEdit came to the front; Safari was put back in 120 ms'
      ].join('\n')
    )
  })

  it('says when no new window appeared', () => {
    expect(formatAppsList([], { name: 'Google Chrome', launched: true, open: ['https://a.test/x', 'https://b.test'] })).toBe(
      'Launched Google Chrome\nOpened 2 items; no new window appeared (it may be a tab or an existing window)'
    )
  })
})

describe('the peer form', () => {
  it('drops the screenshot lines and carries the pictures as base64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-computer-peer-'))
    const path = join(dir, '0001.jpg')
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff]))
    const o: ComputerToolOutcome = {
      steps: ['screenshot'],
      shots: [{ label: 'step 1', where: 1, path, mimeType: 'image/jpeg', width: 10, height: 8 }],
      body: 'app "X" · window "W" · 10×8',
      isError: false
    }
    expect(renderText(o)).toBe(`screenshot\nscreenshot 1 (step 1): ${path} (10×8)\n\napp "X" · window "W" · 10×8`)
    const peer = await outcomeToPeer(o)
    expect(peer.text).toBe('screenshot\n\napp "X" · window "W" · 10×8')
    expect(peer.images).toEqual([{ label: 'step 1', data: '/9j/', mimeType: 'image/jpeg', width: 10, height: 8 }])
  })
})

describe('shots', () => {
  it('lands under the next free number, never over a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-computer-land-'))
    const src = join(dir, 'src.png')
    writeFileSync(src, 'png')
    const landing = join(dir, 'landing')
    expect(await nextShotNumber(landing)).toBe(1)
    mkdirSync(landing)
    writeFileSync(join(landing, '0003.png'), 'x')
    expect(await nextShotNumber(landing)).toBe(4)
    const shot = { path: src, format: 'png', width: 2, height: 2 } as Shot
    const a = await landShot(shot, landing, 3, 'observation', 'observation')
    expect(a).toMatchObject({ n: 4, mimeType: 'image/png', path: join(landing, '0004.png') })
  })

  it('prunes service session dirs untouched for a day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-computer-stale-'))
    mkdirSync(join(dir, 'shots', 'old'), { recursive: true })
    mkdirSync(join(dir, 'shots', 'new'), { recursive: true })
    const now = Date.now()
    const old = new Date(now - STALE_SHOTS_MS - 60_000)
    utimesSync(join(dir, 'shots', 'old'), old, old)
    await pruneStaleShots(dir, now)
    expect(readdirSync(join(dir, 'shots'))).toEqual(['new'])
  })
})
