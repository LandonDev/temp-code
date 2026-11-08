import { describe, expect, it } from 'vitest'
import { isSecretPath, validRelPath } from './secretPaths'
import * as harnessSet from '../main/server/remote/harnessSet'

describe('secret paths', () => {
  it('names credentials and keys by their file name', () => {
    for (const p of ['auth.json', 'a/.credentials.json', 'x/settings.local.json', 'k.pem', 'deep/dir/id.KEY', 'a.p8']) expect(isSecretPath(p), p).toBe(true)
    for (const p of ['SKILL.md', 'scripts/run.sh', 'auth.json.md', 'keys/readme.txt']) expect(isSecretPath(p), p).toBe(false)
  })

  it('takes only a normalized relative posix path', () => {
    for (const p of ['SKILL.md', 'a/b/c.txt', '.hidden/x']) expect(validRelPath(p), p).toBe(true)
    for (const p of ['', '/abs', 'a//b', 'a/', './a', 'a/./b', '../x', 'a/../b', 'a\\b', 'a\0b', 'x'.repeat(1025)]) expect(validRelPath(p), p).toBe(false)
  })

  it('is what the harness set re-exports', () => {
    expect(harnessSet.isSecretPath).toBe(isSecretPath)
    expect(harnessSet.validRelPath).toBe(validRelPath)
  })
})
