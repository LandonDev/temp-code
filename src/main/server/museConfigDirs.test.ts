import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureMuseDirs, museAccountDir, museConfigDirFor, recaptureMuseDir } from './museConfigDirs'

const blobOf = (email: string, token = 'dca:a') => JSON.stringify({ schema_version: 1, providers: { meta: { access_token: token, api_key: 'LLM|1|k', mechanism: 'oauth', user_email: email } } }, null, 2) + '\n'

let base = ''
afterEach(() => {
  configureMuseDirs(null)
  if (base) rmSync(base, { recursive: true, force: true })
})

describe('museConfigDirFor', () => {
  it('writes the vault blob as auth.json 0600 and links the shared entries of the real dir', () => {
    base = mkdtempSync(join(tmpdir(), 'muse-dirs-'))
    const userDir = join(base, 'config', 'muse')
    mkdirSync(join(userDir, 'skills'), { recursive: true })
    writeFileSync(join(userDir, 'settings.json'), '{"schema_version":1}')
    writeFileSync(join(userDir, 'auth.json'), blobOf('live@x'))
    writeFileSync(join(userDir, '.auth.json.lock'), '')
    const blobs: Record<string, string> = { 'landon@example.com': blobOf('landon@example.com') }
    const saved: string[] = []
    configureMuseDirs({ root: join(base, 'muse-accounts'), readBlob: (a) => blobs[a] ?? null, saveBlob: (a, b) => saved.push(a + ':' + b), userConfigDir: userDir })

    expect(museConfigDirFor(null)).toBeNull()
    expect(museConfigDirFor('nobody@x')).toBeNull()
    const dir = museConfigDirFor('landon@example.com')!
    expect(dir).toBe(museAccountDir(join(base, 'muse-accounts'), 'landon@example.com'))
    const auth = join(dir, 'muse', 'auth.json')
    expect(readFileSync(auth, 'utf8')).toBe(blobs['landon@example.com'])
    expect(statSync(auth).mode & 0o777).toBe(0o600)
    expect(readlinkSync(join(dir, 'muse', 'settings.json'))).toBe(join(userDir, 'settings.json'))
    expect(readlinkSync(join(dir, 'muse', 'skills'))).toBe(join(userDir, 'skills'))
    expect(() => lstatSync(join(dir, 'muse', '.auth.json.lock'))).toThrow()
    // The login is the account's own, never the live one.
    expect(lstatSync(auth).isSymbolicLink()).toBe(false)

    // A second call changes nothing on an identical blob and drops a link whose target left.
    const before = statSync(auth).mtimeMs
    rmSync(join(userDir, 'skills'), { recursive: true })
    expect(museConfigDirFor('landon@example.com')).toBe(dir)
    expect(statSync(auth).mtimeMs).toBe(before)
    expect(() => lstatSync(join(dir, 'muse', 'skills'))).toThrow()

    // The CLI rotated the token: recapture saves it back; an identical file or a logout does not.
    expect(recaptureMuseDir('landon@example.com')).toBe(false)
    writeFileSync(auth, blobOf('landon@example.com', 'dca:rotated'))
    expect(recaptureMuseDir('landon@example.com')).toBe(true)
    expect(saved).toEqual(['landon@example.com:' + blobOf('landon@example.com', 'dca:rotated')])
    writeFileSync(auth, '{"schema_version":1,"providers":{}}\n')
    expect(recaptureMuseDir('landon@example.com')).toBe(false)
    expect(saved).toHaveLength(1)
  })
})
