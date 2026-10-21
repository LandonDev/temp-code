import { describe, expect, it } from 'vitest'
import { deleteSimulatorConfirm, devicesSummary, holderText, type HostDevicesReport } from './contract-hostdevices'

const sim = (over: Partial<HostDevicesReport['simulators'][number]> = {}): HostDevicesReport['simulators'][number] => ({
  udid: 'AAA',
  name: 'iPhone 17 Pro',
  runtime: 'iOS 27.0',
  state: 'shutdown',
  holder: null,
  ...over
})

describe('the words the panes share', () => {
  it('the delete confirm names the thread that holds the simulator', () => {
    expect(deleteSimulatorConfirm(sim({ holder: { sessionId: 's', title: 'iOS: Home', status: 'running' } }))).toEqual({
      title: 'Delete iPhone 17 Pro?',
      body: 'Held by iOS: Home, running. Delete anyway?'
    })
    expect(deleteSimulatorConfirm(sim())).toEqual({
      title: 'Delete iPhone 17 Pro?',
      body: 'iPhone 17 Pro (iOS 27.0) and its data are removed from this Mac.'
    })
    expect(holderText({ sessionId: 's', title: 'Proof' })).toBe('Proof')
  })

  it('the summary line', () => {
    const load = { oneMinute: 2.1, cores: 10 }
    expect(
      devicesSummary({
        simulators: [sim({ state: 'booted' }), sim({ udid: 'B' }), sim({ udid: 'C' })],
        phones: [{ udid: 'P', name: 'Mine', model: 'iPhone 16 Pro', os: 'iOS 26.0', connection: 'connected', holder: null }],
        load
      })
    ).toBe('3 simulators, 1 booted · iPhone 16 Pro connected · load 2.1 / 10 cores')
    expect(devicesSummary({ simulators: [], phones: [], load: { oneMinute: 44.97, cores: 16 } })).toBe('No simulators · load 45.0 / 16 cores')
    expect(
      devicesSummary({
        simulators: [sim()],
        phones: [{ udid: 'P', name: 'Mine', model: 'iPhone 17 Pro Max', os: 'iOS 27.2', connection: 'paired', holder: null }],
        load
      })
    ).toBe('1 simulator · iPhone 17 Pro Max paired · load 2.1 / 10 cores')
  })
})
