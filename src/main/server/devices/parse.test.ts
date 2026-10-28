import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  newestXcode,
  parseDevicectlDevices,
  parseLoadAvg,
  parseSimctlDevices,
  parseSimulatorCpu,
  resolveXcode,
  runtimeLabel,
  versionSort,
  xcodeAppOf,
  xcodeVersionFromPlist
} from './parse'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('simctl list -j devices', () => {
  it('a Mac with runtimes but no device answers none (captured)', () => {
    expect(parseSimctlDevices(fixture('simctl-devices-empty.json'))).toEqual([])
  })

  it('flattens the runtimes, drops unavailable devices, booted first then newest runtime', () => {
    const rows = parseSimctlDevices(fixture('simctl-devices-booted.json'))
    expect(rows.map((r) => [r.name, r.runtime, r.state, r.stateText])).toEqual([
      ['iPhone 17 Pro', 'iOS 27.0', 'booted', undefined],
      ['TempCode proof', 'iOS 26.2', 'other', 'Shutting Down'],
      ['iPad Pro 13-inch (M4)', 'iOS 27.0', 'shutdown', undefined]
    ])
    expect(rows[0]!.udid).toBe('DC72C36B-03C7-4A69-B999-8DC4750E7D0D')
  })

  it('refuses what is not simctl', () => {
    expect(() => parseSimctlDevices('nope')).toThrow('no JSON')
    expect(() => parseSimctlDevices('{"runtimes":[]}')).toThrow('no devices')
  })

  it('names runtimes as a person reads them', () => {
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-27-0')).toBe('iOS 27.0')
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.tvOS-26-2')).toBe('tvOS 26.2')
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.watchOS-11-5-1')).toBe('watchOS 11.5.1')
    expect(runtimeLabel('something-else')).toBe('something-else')
  })
})

describe('devicectl list devices', () => {
  it('reads the phones and iPads with their connection, leaving the Apple TV out (captured)', () => {
    const rows = parseDevicectlDevices(fixture('devicectl-devices.json'))
    expect(rows.map((r) => [r.name, r.model, r.os, r.connection, r.transport])).toEqual([
      ['Landon’s iPhone', 'iPhone 17 Pro Max', 'iOS 27.2', 'paired', 'Wi-Fi'],
      ['Landon Hale’s iPad', 'iPad Pro 13-inch (M4)', 'iOS 27.0', 'unavailable', undefined]
    ])
    expect(rows[0]!.udid).toBe('00008150-00117DA636D8C01C')
  })

  it('a device with a tunnel up is connected, over USB when wired', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            identifier: 'x',
            connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'wired' },
            deviceProperties: { name: 'Test phone', osVersionNumber: '26.0' },
            hardwareProperties: { deviceType: 'iPhone', marketingName: 'iPhone 16 Pro', platform: 'iOS', udid: 'U1' }
          },
          {
            identifier: 'y',
            connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected' },
            deviceProperties: { name: 'Other', osVersionNumber: '18.5' },
            hardwareProperties: { deviceType: 'iPhone', productType: 'iPhone15,2', platform: 'iOS', udid: 'U2' }
          },
          {
            identifier: 'z',
            connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'samemachine' },
            deviceProperties: { name: 'Duo', osVersionNumber: '27.1' },
            hardwareProperties: { deviceType: 'iPhone', marketingName: 'iPhone Duo', platform: 'iOS', udid: 'U3' }
          }
        ]
      }
    })
    const rows = parseDevicectlDevices(json)
    expect(rows.map((r) => [r.udid, r.connection, r.transport, r.model])).toEqual([
      ['U3', 'connected', undefined, 'iPhone Duo'],
      ['U1', 'connected', 'USB', 'iPhone 16 Pro'],
      ['U2', 'paired', undefined, 'iPhone15,2']
    ])
  })

  it('refuses what is not devicectl', () => {
    expect(() => parseDevicectlDevices('')).toThrow('no JSON')
    expect(() => parseDevicectlDevices('{"result":{}}')).toThrow('no devices')
  })
})

describe('simulator CPU from ps', () => {
  it('sums the processes under a booted device directory (captured ps, with rss and etime columns too)', () => {
    const udid = 'DC72C36B-03C7-4A69-B999-8DC4750E7D0D'
    const cpu = parseSimulatorCpu(fixture('ps-simulators.txt'), [udid])
    // Two TempCode processes live in that device's containers, both idle; the CoreSimulator service is nobody's.
    expect(cpu.get(udid)).toBe(0)
    expect(cpu.size).toBe(1)
  })

  it('adds up and ignores other devices and unparsable lines', () => {
    const ps = [
      '  PID  %CPU COMMAND',
      '  100  12.5 /Library/Developer/CoreSimulator/Devices/AAAAAAAA-0000-0000-0000-000000000001/data/launchd_sim',
      '  101   7.3 /Users/x/Library/Developer/CoreSimulator/Devices/aaaaaaaa-0000-0000-0000-000000000001/data/Containers/Bundle/App.app/App',
      '  102  50.0 /Library/Developer/CoreSimulator/Devices/BBBBBBBB-0000-0000-0000-000000000002/data/launchd_sim',
      '  103   3.0 /Applications/Simulator.app/Contents/MacOS/Simulator'
    ].join('\n')
    const cpu = parseSimulatorCpu(ps, ['AAAAAAAA-0000-0000-0000-000000000001'])
    expect(cpu.get('AAAAAAAA-0000-0000-0000-000000000001')).toBe(19.8)
    expect(cpu.has('BBBBBBBB-0000-0000-0000-000000000002')).toBe(false)
    expect(parseSimulatorCpu(ps, []).size).toBe(0)
  })
})

describe('the Xcode in use', () => {
  it('reads the version out of version.plist (captured)', () => {
    expect(xcodeVersionFromPlist(fixture('xcode-version.plist'))).toBe('27.0')
    expect(xcodeVersionFromPlist('<plist/>')).toBeUndefined()
  })

  it('DEVELOPER_DIR wins, as scripts/ios-device.sh honours it', () => {
    const info = resolveXcode({
      developerDir: '/Applications/Xcode-beta.app/Contents/Developer',
      apps: ['/Applications/Xcode.app', '/Applications/Xcode-beta.app'],
      versionPlist: (app) => (app.endsWith('beta.app') ? fixture('xcode-version.plist') : null)
    })
    expect(info).toEqual({ path: '/Applications/Xcode-beta.app', name: 'Xcode-beta', version: '27.0', from: 'developerDir' })
  })

  it('else the newest Xcode*.app as `sort -V | tail -1` orders them', () => {
    expect(newestXcode(['/Applications/Xcode.app', '/Applications/Xcode-26.1.app', '/Applications/Xcode-26.app'])).toBe(
      '/Applications/Xcode-26.1.app'
    )
    expect(newestXcode(['/Applications/Xcode-beta.app'])).toBe('/Applications/Xcode-beta.app')
    expect(newestXcode(['/Applications/Xcode.app', '/Applications/Xcode-beta.app'])).toBe('/Applications/Xcode-beta.app')
    // coreutils puts letters after digits: a beta beside a numbered one wins, as the script would pick it.
    expect(newestXcode(['/Applications/Xcode-26.app', '/Applications/Xcode-beta.app'])).toBe('/Applications/Xcode-beta.app')
    expect(['Xcode-26.1.app', 'Xcode.app', 'Xcode-26.app', 'Xcode-26.0.1.app'].sort(versionSort)).toEqual([
      'Xcode.app',
      'Xcode-26.app',
      'Xcode-26.0.1.app',
      'Xcode-26.1.app'
    ])
    expect(newestXcode(['/Applications/Numbers.app'])).toBeNull()
    const info = resolveXcode({ apps: ['/Applications/Xcode-26.app', '/Applications/Xcode-27.app'], versionPlist: () => null })
    expect(info).toEqual({ path: '/Applications/Xcode-27.app', name: 'Xcode-27', from: 'newest' })
  })

  it('falls back to xcode-select, and the Command Line Tools are no Xcode', () => {
    expect(resolveXcode({ apps: [], xcodeSelect: '/Applications/Xcode.app/Contents/Developer', versionPlist: () => null })).toEqual({
      path: '/Applications/Xcode.app',
      name: 'Xcode',
      from: 'xcodeSelect'
    })
    expect(resolveXcode({ apps: [], xcodeSelect: '/Library/Developer/CommandLineTools', versionPlist: () => null })).toBeNull()
    expect(xcodeAppOf('/Library/Developer/CommandLineTools')).toBeNull()
  })

  it('compares versions by segment', () => {
    expect(compareVersions('27.0', '26.2')).toBe(1)
    expect(compareVersions('26.2', '26.10')).toBe(-1)
    expect(compareVersions('26', '26.0')).toBe(0)
  })
})

describe('load', () => {
  it('reads sysctl and uptime (captured: 44.97 on 16 cores)', () => {
    const text = fixture('load.txt')
    expect(text.split('\n')[0]).toBe('16')
    expect(parseLoadAvg(text)).toBe(44.97)
    expect(parseLoadAvg('12:59  up 1 day, load averages: 2.10 2.40 2.51')).toBe(2.1)
    expect(parseLoadAvg('nothing')).toBeNull()
  })
})
