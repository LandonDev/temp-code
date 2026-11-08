import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSkillDir, writeSkillTree } from './skillFiles'
import { fileBytes } from './skillStore'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tc-skill-files-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const put = (rel: string, content: string | Uint8Array, mode?: number): void => {
  const path = join(tmp, 'skill', rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mode !== undefined) chmodSync(path, mode)
}
const skillMd = '---\nname: tidy\ndescription: Tidy code.\n---\n'

describe('readSkillDir', () => {
  it('reads every file, text and binary, keeping the executable bit, and skips .git, .DS_Store and the binary cache', async () => {
    put('SKILL.md', skillMd)
    put('scripts/run.sh', '#!/bin/sh\necho hi\n', 0o755)
    put('data/blob.bin', Uint8Array.from([0, 0xff, 0xfe, 1]))
    put('.git/HEAD', 'ref: refs/heads/main\n')
    put('.DS_Store', 'x')
    put('scripts/bin/linux-x64/impeccable', 'cached engine')
    const files = await readSkillDir(join(tmp, 'skill'))
    expect(files).toEqual([
      { path: 'SKILL.md', text: skillMd },
      { path: 'data/blob.bin', base64: Buffer.from([0, 0xff, 0xfe, 1]).toString('base64') },
      { path: 'scripts/run.sh', text: '#!/bin/sh\necho hi\n', executable: true }
    ])
  })

  it('follows a link inside the folder, reads a linked skill folder, and refuses a link leaving it', async () => {
    put('SKILL.md', skillMd)
    put('lib/shared.md', 'shared')
    symlinkSync(join(tmp, 'skill', 'lib'), join(tmp, 'skill', 'alias'))
    symlinkSync(join(tmp, 'skill', 'lib', 'shared.md'), join(tmp, 'skill', 'copy.md'))
    // A link back to an ancestor reads no folder twice.
    symlinkSync(join(tmp, 'skill'), join(tmp, 'skill', 'lib', 'loop'))
    symlinkSync(join(tmp, 'skill'), join(tmp, 'linked'))
    const paths = (await readSkillDir(join(tmp, 'linked'))).map((f) => f.path)
    expect(paths).toEqual(['SKILL.md', 'alias/shared.md', 'copy.md', 'lib/shared.md'])
    writeFileSync(join(tmp, 'secret.txt'), 'outside')
    symlinkSync(join(tmp, 'secret.txt'), join(tmp, 'skill', 'leak.txt'))
    await expect(readSkillDir(join(tmp, 'skill'))).rejects.toThrow('refused: leak.txt links outside the skill folder')
  })

  it('refuses a native binary and a file over the limit', async () => {
    put('SKILL.md', skillMd)
    put('tool', Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 0o755)
    await expect(readSkillDir(join(tmp, 'skill'))).rejects.toThrow('refused: tool is a native binary; each host fetches its own')
    rmSync(join(tmp, 'skill', 'tool'))
    put('big.dat', new Uint8Array(4 * 1024 * 1024 + 1))
    await expect(readSkillDir(join(tmp, 'skill'))).rejects.toThrow(/^refused: big.dat is 4 MB, over the 4 MB a file may be/)
  })
})

describe('writeSkillTree', () => {
  it('writes the files with their folders and bits, and reads back the same', async () => {
    const files = [
      { path: 'SKILL.md', bytes: new TextEncoder().encode(skillMd), executable: false },
      { path: 'scripts/run.sh', bytes: new TextEncoder().encode('echo hi\n'), executable: true },
      { path: 'data/blob.bin', bytes: Uint8Array.from([0, 0xff]), executable: false }
    ]
    const out = join(tmp, 'gen', 'skills', 'tidy')
    await writeSkillTree(out, files)
    expect(statSync(join(out, 'scripts/run.sh')).mode & 0o777).toBe(0o755)
    expect(statSync(join(out, 'SKILL.md')).mode & 0o777).toBe(0o644)
    expect(new Uint8Array(readFileSync(join(out, 'data/blob.bin')))).toEqual(Uint8Array.from([0, 0xff]))
    const back = await readSkillDir(out)
    expect(back.map((f) => ({ path: f.path, bytes: fileBytes(f), executable: f.executable === true }))).toEqual([...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
  })

  it('writes nothing when one path would land outside the folder', async () => {
    const out = join(tmp, 'gen')
    for (const bad of ['../escape.txt', '/etc/x', 'a/../../b', 'a//b']) {
      await expect(writeSkillTree(out, [{ path: 'SKILL.md', bytes: new Uint8Array(1), executable: false }, { path: bad, bytes: new Uint8Array(1), executable: false }])).rejects.toThrow(
        /outside the skill folder/
      )
    }
    expect(readdirSync(out)).toEqual([])
    expect(existsSync(join(tmp, 'escape.txt'))).toBe(false)
  })

  it('never writes through a link it finds in the folder', async () => {
    const out = join(tmp, 'gen')
    mkdirSync(out)
    mkdirSync(join(tmp, 'elsewhere'))
    symlinkSync(join(tmp, 'elsewhere'), join(out, 'sub'))
    await expect(writeSkillTree(out, [{ path: 'sub/x.md', bytes: new Uint8Array(1), executable: false }])).rejects.toThrow(/outside the skill folder/)
    symlinkSync(join(tmp, 'elsewhere', 'f'), join(out, 'f.md'))
    await expect(writeSkillTree(out, [{ path: 'f.md', bytes: new Uint8Array(1), executable: false }])).rejects.toThrow(/is a link/)
    expect(readdirSync(join(tmp, 'elsewhere'))).toEqual([])
  })
})
