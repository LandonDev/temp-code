// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { BuildFacts } from '@server/shared/deployDrift'
import { DeployDriftMark, DriftMark } from './DeployDrift'
import { driftOf, resetDeployDriftForTest } from '../lib/deployDrift'

const build = (release: number, platform = 'linux'): BuildFacts => ({ release, version: `1.0.${release}`, sha: 'a'.repeat(40), platform })
let hello: { build?: BuildFacts } | null = null

vi.mock('../lib/connection/status', () => ({
  useEnvironmentStatus: () => ({ transport: 'open', fresh: true, lastHello: hello, lastError: null, nextRetryAt: null, route: 0, attempts: 0 })
}))
vi.mock('../lib/connection/registry', () => ({ LOCAL_ENVIRONMENT_ID: 'local', registry: { link: () => undefined, onLink: () => () => {} } }))
vi.mock('../lib/nativeWeb', () => ({ isWebMode: () => false }))

afterEach(() => {
  cleanup()
  hello = null
  resetDeployDriftForTest()
})

describe('DeployDriftMark', () => {
  it('shows +N with the deploy command when the host is behind master', () => {
    hello = { build: build(270) }
    resetDeployDriftForTest({ release: 273, version: '1.0.273', fetchedAt: 1 })
    const { container } = render(<DeployDriftMark environmentId="env_box" />)
    const mark = container.querySelector('[data-deploy-drift]')!
    expect(mark.textContent).toBe('+3')
    expect(mark.getAttribute('aria-label')).toBe(
      "3 releases behind master (runs v1.0.270, master is v1.0.273). Deploy with: ssh box 'box-update master'"
    )
    expect(mark.className).toContain('tabular-nums')
    expect(mark.className).not.toMatch(/animate|transition/)
  })
  it('says Publish for a Mac host', () => {
    hello = { build: build(272, 'darwin') }
    resetDeployDriftForTest({ release: 273, version: '1.0.273', fetchedAt: 1 })
    const { container } = render(<DeployDriftMark environmentId="local" />)
    expect(container.querySelector('[data-deploy-drift]')?.getAttribute('aria-label')).toBe(
      '1 release behind master (runs v1.0.272, master is v1.0.273). Publish with: bun run release:publish'
    )
  })
  it('renders nothing when the host is current', () => {
    hello = { build: build(273) }
    resetDeployDriftForTest({ release: 273, version: '1.0.273', fetchedAt: 1 })
    const { container } = render(<DeployDriftMark environmentId="env_box" />)
    expect(container.innerHTML).toBe('')
  })
  it('renders nothing when the host is ahead, when master is unknown, or before the hello', () => {
    hello = { build: build(275) }
    resetDeployDriftForTest({ release: 273, version: '1.0.273', fetchedAt: 1 })
    expect(render(<DeployDriftMark environmentId="env_box" />).container.innerHTML).toBe('')
    cleanup()
    hello = { build: build(270) }
    resetDeployDriftForTest(null)
    expect(render(<DeployDriftMark environmentId="env_box" />).container.innerHTML).toBe('')
    cleanup()
    hello = null
    resetDeployDriftForTest({ release: 273, version: '1.0.273', fetchedAt: 1 })
    expect(render(<DeployDriftMark environmentId="env_box" />).container.innerHTML).toBe('')
    cleanup()
    // An older host whose hello has no build block.
    hello = {}
    expect(render(<DeployDriftMark environmentId="env_box" />).container.innerHTML).toBe('')
  })
})

describe('driftOf', () => {
  it('exposes behind, both versions and the kind for the Deploy button', () => {
    expect(driftOf(build(270), { release: 273, version: '1.0.273', fetchedAt: 1 })).toEqual({
      behind: 3,
      deployedVersion: '1.0.270',
      masterVersion: '1.0.273',
      sha: 'a'.repeat(40),
      kind: 'box',
      running: 270,
      master: 273
    })
    expect(driftOf(undefined, null)).toMatchObject({ behind: null, deployedVersion: null, masterVersion: null, kind: 'box' })
    const { container } = render(<DriftMark drift={driftOf(build(273), { release: 273, version: '1.0.273', fetchedAt: 1 })} />)
    expect(container.innerHTML).toBe('')
  })
})
