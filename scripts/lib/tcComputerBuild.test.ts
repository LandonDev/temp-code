import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTcComputer, sourceStamp } from './tcComputerBuild'

const children = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: children.spawn,
  execFile: children.execFile
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  renameSync: vi.fn((await original<typeof import('node:fs')>()).renameSync)
}))

let root: string
const warning = '[tc-computer] swift build failed: computer use is off in this build'
const write = (path: string, contents: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}
const builtPath = 'native/tc-computer/.build/arm64-apple-macosx/release/tc-computer'
const targetPath = 'resources/native/tc-computer'
const swiftBuild = () => write(builtPath, 'fake Mach-O bytes')
const fakeExec = vi.fn(
  (command: string, _args: readonly string[], _options: ExecFileSyncOptions): string | Buffer => {
    if (command === 'sh') return '/Applications/Xcode.app/Contents/Developer\n'
    swiftBuild()
    return Buffer.alloc(0)
  }
)
const build = (extra: Partial<Parameters<typeof buildTcComputer>[0]> = {}) =>
  buildTcComputer({
    root,
    platform: 'darwin',
    exec: fakeExec as unknown as typeof execFileSync,
    ...extra
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-computer-build-'))
  write('native/tc-computer/Package.swift', '// swift package')
  write('native/tc-computer/Sources/ComputerProtocol/Wire.swift', 'struct Wire {}')
  write('native/tc-computer/Sources/ComputerProtocol/Generated/Nested.swift', 'struct Nested {}')
  write('package.json', JSON.stringify({ version: '1.2.345' }))
  vi.stubEnv('TEMP_CODE_SKIP_NATIVE', '')
  vi.stubEnv('DEVELOPER_DIR', '')
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('sourceStamp', () => {
  it('hashes source bytes and paths, including Generated, without using mtimes', () => {
    const first = sourceStamp(root)
    const path = join(root, 'native/tc-computer/Sources/ComputerProtocol/Wire.swift')
    utimesSync(path, new Date(0), new Date(0))
    expect(sourceStamp(root)).toBe(first)
    write('native/tc-computer/Tests/x.swift', 'test one')
    write('native/tc-computer/README.md', 'docs one')
    expect(sourceStamp(root)).toBe(first)
    write('native/tc-computer/Tests/x.swift', 'test two')
    write('native/tc-computer/README.md', 'docs two')
    expect(sourceStamp(root)).toBe(first)
    write('native/tc-computer/Sources/ComputerProtocol/Generated/Nested.swift', 'struct Changed {}')
    const changed = sourceStamp(root)
    expect(changed).not.toBe(first)
    renameSync(path, join(dirname(path), 'Renamed.swift'))
    expect(sourceStamp(root)).not.toBe(changed)
  })

  it('hashes the manifest and optional resolved dependencies in sorted path order', () => {
    const first = sourceStamp(root)
    write('native/tc-computer/Package.swift', '// changed manifest')
    const manifest = sourceStamp(root)
    expect(manifest).not.toBe(first)
    write('native/tc-computer/Package.resolved', 'one')
    const resolved = sourceStamp(root)
    expect(resolved).not.toBe(manifest)
    write('native/tc-computer/Package.resolved', 'two')
    expect(sourceStamp(root)).not.toBe(resolved)
    write('native/tc-computer/Sources/Z.swift', 'struct Z {}')
    write('native/tc-computer/Sources/A.swift', 'struct A {}')
    const sorted = sourceStamp(root)
    rmSync(join(root, 'native/tc-computer/Sources/Z.swift'))
    write('native/tc-computer/Sources/Z.swift', 'struct Z {}')
    expect(sourceStamp(root)).toBe(sorted)
  })
})

describe('buildTcComputer', () => {
  it('skips off macOS before reading package files', () => {
    expect(build({ root: '/does-not-exist', platform: 'linux', require: true })).toEqual({
      built: false,
      skipped: 'not-darwin'
    })
    expect(fakeExec).not.toHaveBeenCalled()
  })

  it('skips when disabled', () => {
    vi.stubEnv('TEMP_CODE_SKIP_NATIVE', '1')
    expect(build({ root: '/does-not-exist', require: true })).toEqual({
      built: false,
      skipped: 'disabled'
    })
    expect(fakeExec).not.toHaveBeenCalled()
  })

  it('builds the arm64 product with the selected Xcode and lands it by rename', () => {
    const result = build()
    expect(result).toEqual({ built: true, ms: expect.any(Number) })
    expect(fakeExec).toHaveBeenNthCalledWith(
      1,
      'sh',
      [join(root, 'scripts/ios-xcode.sh')],
      expect.objectContaining({
        cwd: root,
        env: expect.objectContaining({ TC_XCODE_MIN: '0' })
      })
    )
    expect(fakeExec).toHaveBeenNthCalledWith(
      2,
      'swift',
      [
        'build',
        '-c',
        'release',
        '--arch',
        'arm64',
        '--package-path',
        'native/tc-computer',
        '--product',
        'tc-computer'
      ],
      expect.objectContaining({
        cwd: root,
        env: expect.objectContaining({
          DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer'
        })
      })
    )
    const target = join(root, targetPath)
    expect(readFileSync(target, 'utf8')).toBe('fake Mach-O bytes')
    expect(statSync(target).mode & 0o777).toBe(0o755)
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/\/resources\/native\/\.tc-computer\..*\.tmp$/),
      target
    )
    expect(readdirSync(dirname(target)).sort()).toEqual(['tc-computer', 'tc-computer.stamp'])
    const stamp = sourceStamp(root)
    expect(JSON.parse(readFileSync(`${target}.stamp`, 'utf8'))).toEqual({
      stamp,
      version: '1.2.345',
      build: stamp.slice(0, 12)
    })
  })

  it('skips a matching stamp only when the binary also exists', () => {
    build()
    fakeExec.mockClear()
    expect(build()).toEqual({ built: false, skipped: 'up-to-date' })
    expect(fakeExec).not.toHaveBeenCalled()
    rmSync(join(root, targetPath))
    expect(build().built).toBe(true)
  })

  it.each(['not JSON', 'null', '{"stamp":"old"}'])(
    'rebuilds an invalid or stale stamp: %s',
    (stamp) => {
      write(targetPath, 'old binary')
      write(`${targetPath}.stamp`, stamp)
      expect(build().built).toBe(true)
    }
  )

  it('rebuilds when the stamp is missing or sources changed', () => {
    write(targetPath, 'old binary')
    expect(build().built).toBe(true)
    write('native/tc-computer/Sources/New.swift', 'struct New {}')
    expect(build().built).toBe(true)
    expect(fakeExec).toHaveBeenCalledTimes(4)
  })

  it('builds without DEVELOPER_DIR if the Xcode script fails', () => {
    vi.stubEnv('DEVELOPER_DIR', '/bad-xcode')
    fakeExec.mockImplementationOnce(() => {
      throw new Error('no Xcode')
    })
    expect(build().built).toBe(true)
    const options = fakeExec.mock.calls[1][2] as { env: NodeJS.ProcessEnv }
    expect(options.env).not.toHaveProperty('DEVELOPER_DIR')
  })

  it('warns and returns the Swift error, retaining the old binary and stamp', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    write(targetPath, 'old binary')
    write(`${targetPath}.stamp`, '{"stamp":"old"}')
    fakeExec
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => {
        throw new Error('compiler failed')
      })
    expect(build()).toEqual({ built: false, error: 'compiler failed' })
    expect(warn).toHaveBeenCalledWith(warning)
    expect(readFileSync(join(root, targetPath), 'utf8')).toBe('old binary')
    expect(readFileSync(join(root, `${targetPath}.stamp`), 'utf8')).toBe('{"stamp":"old"}')
  })

  it('throws on a required build failure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakeExec
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => {
        throw new Error('compiler failed')
      })
    expect(() => build({ require: true })).toThrow('compiler failed')
  })

  it('throws on a required source hash failure even in background mode', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    rmSync(join(root, 'native/tc-computer/Package.swift'))
    expect(() => build({ require: true, background: true })).toThrow()
    expect(fakeExec).not.toHaveBeenCalled()
  })

  it('warns if Swift succeeds without producing the binary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakeExec.mockImplementationOnce(() => '').mockImplementationOnce(() => Buffer.alloc(0))
    expect(build()).toEqual({ built: false, error: expect.stringContaining('ENOENT') })
    expect(warn).toHaveBeenCalledWith(warning)
    expect(existsSync(join(root, `${targetPath}.stamp`))).toBe(false)
  })

  it('cleans the temporary copy if rename fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('rename failed')
    })
    expect(build()).toEqual({ built: false, error: 'rename failed' })
    expect(readdirSync(join(root, 'resources/native'))).toEqual([])
  })

  it('returns before starting an injected background build and logs completion', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(build({ background: true })).toEqual({ built: false })
    expect(fakeExec).not.toHaveBeenCalled()
    expect(existsSync(join(root, targetPath))).toBe(false)
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[tc-computer\] built in [\d.]+s$/))
    )
    expect(readFileSync(join(root, targetPath), 'utf8')).toBe('fake Mach-O bytes')
  })

  it('keeps the event loop free while the background Swift process runs', async () => {
    const child = new EventEmitter()
    children.execFile.mockImplementation((_command, _args, _opts, callback) =>
      callback(null, '/Xcode\n')
    )
    children.spawn.mockReturnValue(child)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(build({ background: true, exec: undefined })).toEqual({ built: false })
    await vi.waitFor(() =>
      expect(children.spawn).toHaveBeenCalledWith(
        'swift',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ DEVELOPER_DIR: '/Xcode' })
        })
      )
    )
    expect(log).not.toHaveBeenCalled()
    expect(existsSync(join(root, targetPath))).toBe(false)
    swiftBuild()
    child.emit('close', 0)
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(existsSync(join(root, targetPath))).toBe(true)
  })

  it.each(['error', 'close'])(
    'warns on a background process %s without writing a stamp',
    async (event) => {
      const child = new EventEmitter()
      children.execFile.mockImplementation((_command, _args, _opts, callback) =>
        callback(new Error('no Xcode'), '')
      )
      children.spawn.mockReturnValue(child)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      build({ background: true, exec: undefined })
      await vi.waitFor(() => expect(children.spawn).toHaveBeenCalled())
      child.emit(event, event === 'error' ? new Error('spawn failed') : 1)
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(warning))
      expect(existsSync(join(root, `${targetPath}.stamp`))).toBe(false)
    }
  )
})
