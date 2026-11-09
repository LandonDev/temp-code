import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { previewProbeSource } from './previewProbeApp'

it('keeps TC Probe behavior and changes only the preview button drawing masks', () => {
  const original = readFileSync(resolve('scripts/mac/computer-probe-app.swift'), 'utf8')
  const quiet = previewProbeSource(original)
  expect(quiet).toContain('pingCell.highlightsBy = []')
  expect(quiet).toContain('pingCell.showsStateBy = []')
  expect(quiet).toContain('#selector(ping(_:))')
  expect(quiet).toContain('result.stringValue = "pong"')
  expect(quiet).toContain('override var canBecomeKey: Bool { false }')
  expect(quiet).toContain('Timer.scheduledTimer(withTimeInterval: 0.1')
  const added = quiet.slice(
    quiet.indexOf('\n        // The preview checks'),
    quiet.indexOf('\n\n        let stack')
  )
  expect(quiet.replace(added, '')).toBe(original)
})

it('fails rather than silently using an ambiguous or changed fixture', () => {
  expect(() => previewProbeSource('no button')).toThrow('Ping declaration changed')
  const original = readFileSync(resolve('scripts/mac/computer-probe-app.swift'), 'utf8')
  expect(() => previewProbeSource(original + original)).toThrow('Ping declaration changed')
})
