import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENVIRONMENT_FILE, ENVIRONMENT_ID, loadEnvironmentId } from './environment'

let dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tc-env-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('loadEnvironmentId', () => {
  it('creates a well-formed id and rereads the same one', () => {
    const dir = scratch()
    const id = loadEnvironmentId(dir)
    expect(id).toMatch(ENVIRONMENT_ID)
    expect(loadEnvironmentId(dir)).toBe(id)
    const record = JSON.parse(readFileSync(join(dir, ENVIRONMENT_FILE), 'utf8'))
    expect(record.id).toBe(id)
    expect(typeof record.createdAt).toBe('number')
    expect(readdirSync(dir)).toEqual([ENVIRONMENT_FILE]) // no temp file left behind
  })
  it('creates the directory when missing', () => {
    const dir = join(scratch(), 'nested', 'userData')
    expect(loadEnvironmentId(dir)).toMatch(ENVIRONMENT_ID)
  })
  it('replaces a corrupt file instead of failing', () => {
    const dir = scratch()
    writeFileSync(join(dir, ENVIRONMENT_FILE), '{nope')
    expect(loadEnvironmentId(dir)).toMatch(ENVIRONMENT_ID)
  })
  it('concurrent creators agree on one id', async () => {
    const dir = scratch()
    // Ten processes racing for the same file: every one must come back
    // with the id that landed on disk.
    const script = `process.stdout.write(require(${JSON.stringify(join(__dirname, '.out-environment.cjs'))}).loadEnvironmentId(process.argv[1]))`
    const { buildSync } = await import('esbuild')
    buildSync({
      entryPoints: [join(__dirname, 'environment.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: join(__dirname, '.out-environment.cjs'),
      logLevel: 'silent'
    })
    const { execFile } = await import('node:child_process')
    try {
      const ids = await Promise.all(
        Array.from({ length: 10 }, () =>
          new Promise<string>((resolve, reject) =>
            execFile(process.execPath, ['-e', script, dir], (err, out) => (err ? reject(err) : resolve(out)))
          )
        )
      )
      expect(new Set(ids).size).toBe(1)
      expect(ids[0]).toBe(loadEnvironmentId(dir))
    } finally {
      rmSync(join(__dirname, '.out-environment.cjs'), { force: true })
    }
  })
})
