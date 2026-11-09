import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProbeApp, type ProbeAppBuild } from './tcProbeApp'

const PING = '        let ping = NSButton(title: "Ping", target: self, action: #selector(ping(_:)))'
const STILL_CELL = `
        // The preview checks a press that changes no pixels, including the button itself.
        guard let pingCell = ping.cell as? NSButtonCell else { fatalError("Ping has no button cell") }
        pingCell.highlightsBy = []
        pingCell.showsStateBy = []`

/** Keep AXPress and its callback, but remove AppKit's temporary press/release drawing. */
export function previewProbeSource(source: string): string {
  if (source.split(PING).length !== 2)
    throw new Error('TC Probe Ping declaration changed; update the preview fixture')
  return source.replace(PING, PING + STILL_CELL)
}

/** Compile a scratch copy; never edit the shared TC Probe source or the shipped app. */
export function buildPreviewProbeApp(root: string, dir: string, bundleId: string): ProbeAppBuild {
  const fixture = join(dir, 'preview-fixture')
  const sourceDir = join(fixture, 'scripts/mac')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(
    join(sourceDir, 'computer-probe-app.swift'),
    previewProbeSource(readFileSync(join(root, 'scripts/mac/computer-probe-app.swift'), 'utf8'))
  )
  return buildProbeApp(fixture, dir, bundleId)
}
