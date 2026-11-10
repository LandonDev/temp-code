import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TITLE_BAR_CORNER } from './observation'
import { PREVIEW_STREAM, SHOT } from './protocol'

// Capture's numbers (native/tc-computer/Sources/Capture/CaptureTuning.swift) against the wire's.
// The ones the wire states must come from the generated `ComputerDefaults`, never a literal, so
// protocol.ts stays the one place they are written; the rest must fit inside the wire's limits.

const root = join(__dirname, '..', '..', '..')
const tuning = readFileSync(join(root, 'native/tc-computer/Sources/Capture/CaptureTuning.swift'), 'utf8')
const contract = readFileSync(join(root, 'native/tc-computer/Sources/ComputerProtocol/Generated/Contract.swift'), 'utf8')

/** The right-hand side of `public static let <name> = …`, one line. */
function value(name: string): string {
  const match = tuning.match(new RegExp(`^\\s*public static let ${name}(?:: [\\w.]+)? = (.+)$`, 'm'))
  if (!match) throw new Error(`CaptureTuning.swift has no one-line \`${name}\``)
  return match[1].trim()
}

/** A Swift integer expression of literals: `380 * 1_024`, `2_576`. */
function integer(expression: string): number {
  if (!/^[\d_\s*]+$/.test(expression)) throw new Error(`not a literal product: ${expression}`)
  return expression.split('*').reduce((product, factor) => product * Number(factor.trim().replaceAll('_', '')), 1)
}

/** `ComputerDefaults.<group>.<name>` read back from the generated Contract.swift. */
function generated(group: string, name: string): number {
  const body = contract.match(new RegExp(`public enum ${group} \\{([^}]*)\\}`))?.[1]
  const line = body?.match(new RegExp(`public static let ${name} = ([\\d.]+)`))
  if (!line) throw new Error(`Contract.swift has no ComputerDefaults.${group}.${name}`)
  return Number(line[1])
}

describe('Capture tuning and the wire', () => {
  it('takes every number the wire states from the generated defaults', () => {
    expect(value('jpegQuality')).toBe('ComputerDefaults.Shot.jpegQuality')
    expect(value('edgeDefault')).toBe('ComputerDefaults.Shot.defaultMaxEdge')
    expect(value('edgeRange')).toBe('ComputerDefaults.Shot.minMaxEdge...ComputerDefaults.Shot.maxMaxEdge')
    expect(value('pixelCap')).toBe('ComputerDefaults.Shot.maxPixels')
    expect(value('streamFPSDefault')).toBe('ComputerDefaults.PreviewStream.defaultFps')
    expect(value('streamFPSRange')).toBe('ComputerDefaults.PreviewStream.minFps...ComputerDefaults.PreviewStream.maxFps')
    expect(value('streamEdgeDefault')).toBe('ComputerDefaults.PreviewStream.defaultMaxEdge')
    expect(value('streamEdgeRange')).toBe('ComputerDefaults.PreviewStream.minMaxEdge...ComputerDefaults.Shot.maxMaxEdge')
    expect(value('unackedSlots')).toBe('ComputerDefaults.PreviewStream.maxUnacked')
    expect(value('frameQualityLadder')).toMatch(/^\[jpegQuality, /)
  })

  it('reads generated defaults equal to protocol.ts', () => {
    for (const [name, wire] of Object.entries(SHOT)) expect(generated('Shot', name), `SHOT.${name}`).toBe(wire)
    for (const [name, wire] of Object.entries(PREVIEW_STREAM)) {
      expect(generated('PreviewStream', name), `PREVIEW_STREAM.${name}`).toBe(wire)
    }
  })

  it('ignores the same title-bar corner the text names (§22.8)', () => {
    expect(value('titleBarCorner')).toBe(`CGSize(width: ${TITLE_BAR_CORNER.w}, height: ${TITLE_BAR_CORNER.h})`)
  })

  it("keeps a frame's base64 line under the wire's frame cap", () => {
    const jpeg = integer(value('frameJPEGCap'))
    const base64 = Math.ceil(jpeg / 3) * 4
    expect(base64 + 4_096).toBeLessThanOrEqual(PREVIEW_STREAM.frameMaxBytes)
  })

  it('lets the stream go smaller than a screenshot, never larger', () => {
    expect(PREVIEW_STREAM.minMaxEdge).toBeLessThan(SHOT.minMaxEdge)
    expect(PREVIEW_STREAM.defaultMaxEdge).toBeLessThanOrEqual(SHOT.maxMaxEdge)
  })
})
