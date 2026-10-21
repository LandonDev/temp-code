import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { HostDevicesReport } from '@server/shared/contract-hostdevices'
import { mountProbe } from '../test/renderProbe'
import { MacDevicesRow, type MacDevicesRowProps } from './MacDevices'

const host = { environmentId: 'env_mac', name: 'Landon’s Mac', local: true }

const report = (over: Partial<HostDevicesReport> = {}): HostDevicesReport => ({
  environmentId: 'env_mac',
  at: 1,
  simulators: [
    {
      udid: 'AAA',
      name: 'iPhone 17 Pro',
      runtime: 'iOS 27.0',
      state: 'booted',
      cpu: 12.4,
      holder: { sessionId: 's1', title: 'iOS: Home', status: 'running' }
    },
    { udid: 'BBB', name: 'iPad Pro 13-inch (M4)', runtime: 'iOS 27.0', state: 'shutdown', holder: null }
  ],
  phones: [
    { udid: 'P1', name: 'Landon’s iPhone', model: 'iPhone 17 Pro Max', os: 'iOS 27.2', connection: 'connected', transport: 'USB', holder: null }
  ],
  xcode: { path: '/Applications/Xcode-beta.app', name: 'Xcode-beta', version: '27.0', from: 'newest' },
  load: { oneMinute: 2.1, cores: 10 },
  problems: [],
  ...over
})

function mount(over: Partial<MacDevicesRowProps> = {}) {
  const props: MacDevicesRowProps = {
    host,
    report: report(),
    error: null,
    onShutdown: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onOpenXcode: vi.fn(async () => {}),
    onOpenSession: vi.fn(),
    ...over
  }
  const probe = mountProbe(<MacDevicesRow {...props} />)
  return { probe, props, root: probe.container }
}

describe('MacDevicesRow', () => {
  let unmount: (() => void) | null = null
  afterEach(() => {
    unmount?.()
    unmount = null
  })

  it('the summary line, one row per device with its state dot and holder', () => {
    const { probe, root } = mount()
    unmount = probe.unmount
    expect(root.querySelector('[data-summary]')!.textContent).toBe(
      '3 simulators, 1 booted · iPhone 17 Pro Max connected · load 2.1 / 10 cores'.replace('3 simulators', '2 simulators')
    )
    const rows = [...root.querySelectorAll('[role="row"]')].slice(1)
    expect(rows.length).toBe(3)
    expect(rows[0]!.textContent).toContain('iPhone 17 Pro · iOS 27.0')
    expect(rows[0]!.textContent).toContain('Booted · 12% CPU')
    expect(rows[0]!.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('on')
    expect(rows[0]!.querySelector('[data-holder]')!.textContent).toBe('iOS: Home, running')
    expect(rows[1]!.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('off')
    expect(rows[1]!.querySelector('[data-holder]')!.textContent).toBe('—')
    expect(rows[2]!.textContent).toContain('iPhone 17 Pro Max')
    expect(rows[2]!.textContent).toContain('Connected · USB')
    expect(root.textContent).toContain('Xcode-beta 27.0')
  })

  it('the holder links to its thread', () => {
    const { probe, props } = mount()
    unmount = probe.unmount
    fireEvent.click(screen.getByRole('button', { name: 'iOS: Home, running' }))
    expect(props.onOpenSession).toHaveBeenCalledWith('s1')
  })

  it('Shutdown shows on a booted simulator only; Open in Xcode on a phone', async () => {
    const { probe, props } = mount()
    unmount = probe.unmount
    expect(screen.getAllByRole('button', { name: 'Shutdown' }).length).toBe(1)
    expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Shutdown' }))
    expect(props.onShutdown).toHaveBeenCalledWith('AAA')
    // While one action runs every other is disabled; once it settles they come back.
    expect((screen.getByRole('button', { name: 'Open in Xcode' }) as HTMLButtonElement).disabled).toBe(true)
    await probe.act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Open in Xcode' }))
    expect(props.onOpenXcode).toHaveBeenCalled()
  })

  it('Delete asks first, naming the thread that holds the simulator, and deletes on confirm', async () => {
    const { probe, props } = mount()
    unmount = probe.unmount
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
    expect(screen.getByText('Held by iOS: Home, running. Delete anyway?')).toBeTruthy()
    expect(props.onDelete).not.toHaveBeenCalled()
    await probe.act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    })
    expect(props.onDelete).toHaveBeenCalledTimes(1)
    expect(props.onDelete).toHaveBeenCalledWith('AAA')
  })

  it('a simulator nobody holds confirms with what is removed', () => {
    const { probe } = mount()
    unmount = probe.unmount
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    expect(screen.getByText('iPad Pro 13-inch (M4) (iOS 27.0) and its data are removed from this Mac.')).toBeTruthy()
  })

  it('the empty state is one muted line', () => {
    const { probe, root } = mount({ report: report({ simulators: [], phones: [] }) })
    unmount = probe.unmount
    expect(root.querySelector('[data-empty]')!.textContent).toBe('No simulators')
    expect(root.querySelector('[role="table"]')).toBeNull()
    expect(root.querySelector('[data-summary]')!.textContent).toBe('No simulators · load 2.1 / 10 cores')
  })

  it('a phone with no simulator still gets the table, with the muted line in place of the simulators', () => {
    const { probe, root } = mount({ report: report({ simulators: [] }) })
    unmount = probe.unmount
    expect(root.querySelector('[data-empty]')!.textContent).toBe('No simulators')
    expect(root.querySelectorAll('[role="row"]').length).toBe(2)
  })

  it('before the first report: Looking…; a failure with no report shows it', () => {
    const { probe, root } = mount({ report: null })
    unmount = probe.unmount
    expect(root.querySelector('[data-summary]')!.textContent).toBe('Looking…')
    const failed = mount({ report: null, error: 'Landon’s Mac is not linked right now' })
    expect(failed.root.textContent).toContain('Landon’s Mac is not linked right now')
    failed.probe.unmount()
  })
})
