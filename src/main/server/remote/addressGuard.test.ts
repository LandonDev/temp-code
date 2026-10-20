import { describe, expect, it } from 'vitest'
import { guardedLookup, isForbiddenHostname, isLoopbackAddress, isPrivateAddress, resolveGuarded } from './addressGuard'

/** R2 M3: the address guard every webhook target passes at creation and at connect. */
describe('isPrivateAddress', () => {
  it('refuses every v4 range a webhook must not reach', () => {
    for (const ip of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.100.100.200', '192.0.0.192', '192.0.2.1', '198.18.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255'])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.1.1', '8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })
  it('refuses every v6 range, the mapped and embedded v4 forms, and junk', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fe80::a:b:c:d', 'fc00::1', 'fd00:ec2::254', 'fdab::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::10.0.0.1', '64:ff9b::7f00:1'])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:93.184.216.34'])
      expect(isPrivateAddress(ip), ip).toBe(false)
    expect(isPrivateAddress('bot.example')).toBe(true)
    expect(isPrivateAddress('')).toBe(true)
  })
  it('knows the loopback forms apart from the rest', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(ip), ip).toBe(true)
    for (const ip of ['10.0.0.1', '169.254.169.254', 'fe80::1', '::ffff:10.0.0.1', '93.184.216.34', 'x']) expect(isLoopbackAddress(ip), ip).toBe(false)
  })
})

describe('isForbiddenHostname', () => {
  it('refuses bare labels and the internal suffixes', () => {
    for (const h of ['localhost', 'LOCALHOST.', 'metadata', 'instance-data', 'app.localhost', 'printer.local', 'metadata.google.internal', 'kubernetes.default.svc', 'db.svc.cluster.local', '1.0.0.10.in-addr.arpa', 'router.home.arpa'])
      expect(isForbiddenHostname(h), h).toBe(true)
    for (const h of ['bot.example', 'hooks.slack.com', 'api.openai.com']) expect(isForbiddenHostname(h), h).toBe(false)
  })
})

describe('resolveGuarded', () => {
  const resolving = (...ips: string[]) => ({ resolve: async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) })
  it('answers a public literal or a name that resolves only to public addresses', async () => {
    expect(await resolveGuarded('93.184.216.34')).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(await resolveGuarded('[2606:4700::1111]')).toEqual([{ address: '2606:4700::1111', family: 6 }])
    expect(await resolveGuarded('bot.example', resolving('93.184.216.34', '2606:4700::1111'))).toHaveLength(2)
  })
  it('refuses private literals, forbidden names, a private answer among public ones, and a name that does not resolve', async () => {
    for (const host of ['127.0.0.1', '[::1]', '169.254.169.254', '10.0.0.1', '[fd00:ec2::254]', 'localhost', 'metadata.google.internal'])
      await expect(resolveGuarded(host, resolving('93.184.216.34')), host).rejects.toThrow('private or local')
    await expect(resolveGuarded('bot.example', resolving('93.184.216.34', '10.0.0.5'))).rejects.toThrow('private or local')
    await expect(resolveGuarded('bot.example', resolving())).rejects.toThrow('does not resolve')
    await expect(resolveGuarded('bot.example', { resolve: async () => { throw new Error('ENOTFOUND') } })).rejects.toThrow('does not resolve')
  })
  it('lets loopback through only when asked, never another private range', async () => {
    expect(await resolveGuarded('127.0.0.1', { allowLoopback: true })).toEqual([{ address: '127.0.0.1', family: 4 }])
    expect(await resolveGuarded('[::1]', { allowLoopback: true })).toEqual([{ address: '::1', family: 6 }])
    await expect(resolveGuarded('169.254.169.254', { allowLoopback: true })).rejects.toThrow('private or local')
    await expect(resolveGuarded('10.0.0.1', { allowLoopback: true })).rejects.toThrow('private or local')
  })
})

describe('guardedLookup', () => {
  const answer = (host: string, opts: { all?: boolean; family?: number }, guard = {}): Promise<[NodeJS.ErrnoException | null, unknown, number | undefined]> =>
    new Promise((r) => guardedLookup({ resolve: async () => [{ address: '2606:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }], ...guard })(host, opts, (err, address, family) => r([err, address, family])))
  it('answers the socket in both shapes, honouring the family', async () => {
    expect(await answer('bot.example', { family: 4 })).toEqual([null, '93.184.216.34', 4])
    expect(await answer('bot.example', { all: true })).toEqual([null, [{ address: '2606:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }], undefined])
    expect((await answer('bot.example', { family: 4, all: true }))[1]).toEqual([{ address: '93.184.216.34', family: 4 }])
  })
  it('fails the connect for a refused target, with a code and no address', async () => {
    const [err, address] = await answer('bot.example', { family: 4 }, { resolve: async () => [{ address: '10.0.0.5', family: 4 }] })
    expect(err?.code).toBe('EREFUSEDTARGET')
    expect(address).toBeUndefined()
    const [missing] = await answer('bot.example', { family: 6 }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    expect(missing?.code).toBe('ENOTFOUND')
  })
})
