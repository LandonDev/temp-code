import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { inspect } from 'node:util'
import { commandMatches, createProcScan, hasEnv, parsePpid, parsePs } from './procScan'

describe('macOS process scan', () => {
  const text =
    '  12 /usr/bin/bun fakeMcpServer.ts --log /tmp/proof/calls HOME=/tmp/proof/home TEMP_CODE_ADDON=addon-1\n  13 /usr/bin/bun fakeMcpServer.ts TEMP_CODE_ADDON=addon-10\n'
  it('finds a complete environment mark and a command line match', () => {
    const rows = parsePs(text)
    expect(
      rows.filter((row) => hasEnv(row, 'TEMP_CODE_ADDON=addon-1')).map((row) => row.pid)
    ).toEqual([12])
    expect(
      rows.filter((row) => commandMatches(row, 'fakeMcpServer', '/tmp/proof')).map((row) => row.pid)
    ).toEqual([12])
    expect(hasEnv(rows[0]!, 'HOME=/tmp/proof/', true)).toBe(true)
    expect(parsePs('junk\n   \n')).toEqual([])
  })
  it('parses one parent pid and rejects missing or malformed output', () => {
    expect(parsePpid('  412\n')).toBe(412)
    expect(parsePpid('0')).toBe(0)
    for (const text of ['', 'PPID\n12', '12 13', '-1']) expect(parsePpid(text)).toBeNull()
  })
  it('uses ps with environments and a separate parent query, without /proc', () => {
    const exec = vi.fn((_: string, args: string[]) => (args[0] === '-axwwE' ? text : '  42\n'))
    const read = vi.fn(() => {
      throw new Error('no /proc on macOS')
    })
    const scan = createProcScan({ platform: 'darwin', read, exec })
    expect(scan.processes()).toEqual(parsePs(text))
    expect(scan.ppidOf(12)).toBe(42)
    expect(exec.mock.calls).toEqual([
      ['ps', ['-axwwE', '-o', 'pid=,command='], expect.objectContaining({ stdio: 'pipe' })],
      ['ps', ['-o', 'ppid=', '-p', '12'], expect.objectContaining({ stdio: 'pipe' })]
    ])
    expect(read).not.toHaveBeenCalled()
  })
  it('reads process environments larger than the default child-process buffer', () => {
    const scan = createProcScan({
      platform: 'darwin',
      exec: (_file, _args, options) => execFileSync(process.execPath, [
        '-e', 'process.stdout.write("7 probe TEMP_CODE_ADDON=large PAD=" + "x".repeat(2 * 1024 * 1024))'
      ], options)
    })
    const rows = scan.processes()
    expect(rows).toHaveLength(1)
    expect(hasEnv(rows[0]!, 'TEMP_CODE_ADDON=large')).toBe(true)
    expect(rows[0]!.command.length).toBeGreaterThan(2 * 1024 * 1024)
  })
  it('fails without exposing captured environments, stderr or the original error', () => {
    const original = Object.assign(new Error('private environment in the command'), {
      code: 'ENOBUFS', stdout: 'SECRET_TOKEN=private', stderr: 'another private value'
    })
    const scan = createProcScan({ platform: 'darwin', exec: () => { throw original } })
    let failure: unknown
    try { scan.processes() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('process scan failed: ENOBUFS')
    expect(inspect(failure)).not.toMatch(/SECRET_TOKEN|private|another/)
    expect((failure as Error).cause).toBeUndefined()
  })
})

describe('Linux process scan', () => {
  it('reads an injected /proc, skips vanished processes and parses a parent with spaces in comm', () => {
    const files: Record<string, string> = {
      '/proc/12/cmdline': 'bun\0fakeMcpServer.ts\0/tmp/proof/calls\0',
      '/proc/12/environ': 'HOME=/tmp/proof/home\0TEMP_CODE_ADDON=addon-1\0',
      '/proc/12/stat': '12 (name with ) parentheses) S 42 1 2 3'
    }
    const scan = createProcScan({
      platform: 'linux',
      listProc: () => ['12', '13', 'self'],
      read: (path) => {
        if (!(path in files)) throw new Error('gone')
        return files[path]!
      },
      exec: () => {
        throw new Error('Linux must use /proc')
      }
    })
    const rows = scan.processes()
    expect(rows).toHaveLength(1)
    expect(hasEnv(rows[0]!, 'TEMP_CODE_ADDON=addon-1')).toBe(true)
    expect(commandMatches(rows[0]!, 'fakeMcpServer', '/tmp/proof')).toBe(true)
    expect(scan.ppidOf(12)).toBe(42)
    expect(scan.ppidOf(13)).toBeNull()
  })
})
