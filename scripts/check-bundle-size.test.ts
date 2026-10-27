import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badJsxTags, checkBundle, scanAssets } from './check-bundle-size'
import type { BundleMap } from './bundle-map'

describe('badJsxTags', () => {
  it('names a lowercase component binding inlined into a JSX tag', () => {
    expect(badJsxTags('jsx("current", { ...props })')).toEqual(['current'])
    expect(badJsxTags('jsxs("current", {})')).toEqual(['current'])
    expect(badJsxTags('React.createElement("current", null)')).toEqual(['current'])
  })

  it('passes HTML, SVG in any case, custom elements and component references', () => {
    const source = [
      'jsx("div", {})',
      'jsxs("svg", {})',
      'jsx("foreignObject", {})',
      'jsx("linearGradient", {})',
      'jsx("my-widget", {})',
      'jsx(Current, {})',
      'createElement("documentmock", NS.HTML, [])',
    ].join(';')
    expect(badJsxTags(source)).toEqual([])
  })

  it('names each bad tag once', () => {
    expect(badJsxTags('jsx("current");jsx("current");jsx("lazy")')).toEqual(['current', 'lazy'])
  })
})

describe('checkBundle', () => {
  const map: BundleMap = {
    chunks: {
      'assets/index-a.js': { type: 'chunk', entry: true, bytes: 1024, imports: [], dynamicImports: [], modules: {} },
    },
  }

  it('fails a bundle whose chunk renders a bad tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-bundle-'))
    try {
      writeFileSync(join(dir, 'index-a.js'), 'jsx("current", {})')
      writeFileSync(join(dir, 'other-b.js'), 'jsx("div", {})')
      const verdict = checkBundle(map, 4096, scanAssets(dir))
      expect(verdict.ok).toBe(false)
      expect(verdict.badTags).toEqual(['index-a.js: current'])
      expect(verdict.lines.at(-1)).toContain('renders "current" as a DOM tag')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes a clean bundle', () => {
    expect(checkBundle(map, 4096, []).ok).toBe(true)
  })
})
