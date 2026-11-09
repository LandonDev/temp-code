import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppInfo, Shot } from '@shared/computer/protocol'
import { formatAppsList, outcomeToPeer, renderText, type ComputerToolOutcome } from './result'
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
