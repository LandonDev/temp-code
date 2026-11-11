import { describe, expect, it } from 'vitest'
import { hostLabels, shortHostName } from './hostNames'

describe('shortHostName', () => {
  it('drops the network domain of a hostname', () => {
    expect(shortHostName('Mac.attlocal.net')).toBe('Mac')
    expect(shortHostName('Landons-MBP.attlocal.net')).toBe('Landons-MBP')
    expect(shortHostName('studio.local')).toBe('studio')
  })

  it('keeps a bare name, an address and an odd name whole', () => {
    expect(shortHostName('tempcode-box')).toBe('tempcode-box')
    expect(shortHostName('192.168.1.20')).toBe('192.168.1.20')
    expect(shortHostName('fe80::1')).toBe('fe80::1')
    expect(shortHostName('.hidden')).toBe('.hidden')
    expect(shortHostName('  box.lan  ')).toBe('box')
  })
})

describe('hostLabels', () => {
  it('shortens every name that stays unique', () => {
    const labels = hostLabels([
      { id: 'box', name: 'tempcode-box' },
      { id: 'mac', name: 'Mac.attlocal.net' }
    ])
    expect([...labels]).toEqual([
      ['box', 'tempcode-box'],
      ['mac', 'Mac']
    ])
  })

  it('keeps whole names where two hosts would read the same, and never shortens a name the person gave', () => {
    const labels = hostLabels([
      { id: 'a', name: 'Mac.attlocal.net' },
      { id: 'b', name: 'mac.home' },
      { id: 'c', name: 'Mac', custom: true },
      { id: 'd', name: 'My.Box', custom: true }
    ])
    expect(labels.get('a')).toBe('Mac.attlocal.net')
    expect(labels.get('b')).toBe('mac.home')
    expect(labels.get('c')).toBe('Mac')
    expect(labels.get('d')).toBe('My.Box')
  })
})
