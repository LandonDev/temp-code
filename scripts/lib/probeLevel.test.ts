import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('scripts/mac/computer-probe-app.swift'), 'utf8')
const classBody = (name: string): string => {
  const at = source.indexOf(`final class ${name}: NSWindow {`)
  return source.slice(at, source.indexOf('\n}\n', at))
}

describe("TC Probe's windows", () => {
  it('float above ordinary windows on every Space, beside a full-screen app, and never hide on deactivation', () => {
    const float = source.slice(source.indexOf('enum ProbeLevel'), source.indexOf('/// A window the person can neither click nor bring forward.'))
    expect(float).toContain('window.level = .floating')
    expect(float).toContain('window.collectionBehavior.formUnion([.canJoinAllSpaces, .fullScreenAuxiliary])')
    expect(float).toContain('window.hidesOnDeactivate = false')
    // the stealer plays an ordinary app
    expect(float).toContain('guard !steals else { return }')
  })

  it('every window class the probe opens floats, and the inert ones still never become key', () => {
    for (const name of ['InertWindow', 'SideWindow', 'KeyableWindow']) expect(classBody(name)).toContain('ProbeLevel.float(self)')
    expect(classBody('InertWindow')).toContain('override var canBecomeKey: Bool { false }')
    expect(classBody('SideWindow')).toContain('override var canBecomeKey: Bool { false }')
    // no window class of its own outside the three
    expect(source.match(/final class \w+: NSWindow \{/g)).toHaveLength(3)
  })

  it('keeps the web leg’s cover an ordinary window', () => {
    const cover = source.slice(source.indexOf('"TC Probe Cover"'), source.indexOf('cover.orderFrontRegardless()'))
    expect(cover).toContain('cover.level = .normal')
    expect(cover).toContain('cover.collectionBehavior = []')
  })
})
