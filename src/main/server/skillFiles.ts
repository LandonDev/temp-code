import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { SkillFile } from '@shared/contract-skills'
import { validRelPath } from '@shared/secretPaths'
import { SKILL_BINARY_CACHE, SKILL_MAX_BYTES, SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES, isNativeBinary, sizeWords } from '@shared/skills'
import { wireFile, type StoredFile } from './skillStore'

/**
 * A skill folder on disk, both ways. `readSkillDir` is what `skill_write
 * { dir }` and the skills store core's one-time import read through;
 * `writeSkillTree` is the materializer's primitive. Neither ever reaches
 * outside the folder it was given.
 */

const SKIP_DIRS = new Set(['.git'])
const SKIP_NAMES = new Set(['.DS_Store'])

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

/**
 * Every file of the skill folder `dir`, posix paths relative to it: text
 * when it decodes as UTF-8, else base64, the executable bit kept. Follows
 * symlinks that stay inside the folder; skips `.git`, `.DS_Store` and the
 * binary cache (`scripts/bin/`). Throws `refused: …` at a link leaving the
 * folder, a native binary, or past the limits.
 */
export async function readSkillDir(dir: string): Promise<SkillFile[]> {
  const root = await realpath(dir)
  if (!(await stat(root)).isDirectory()) throw new Error(`refused: ${dir} is not a folder`)
  const out: StoredFile[] = []
  let total = 0

  // A folder reached twice through links reads twice, as a CLI would see it; only a link back to a folder being walked is skipped.
  const walk = async (real: string, rel: string, ancestors: ReadonlySet<string> = new Set()): Promise<void> => {
    if (ancestors.has(real)) return
    const within = new Set(ancestors).add(real)
    const entries = await readdir(real, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (SKIP_NAMES.has(entry.name)) continue
      let path = join(real, entry.name)
      let info = await lstat(path)
      if (info.isSymbolicLink()) {
        const target = await realpath(path).catch(() => null)
        if (!target) continue // a dangling link carries nothing
        if (!inside(root, target)) throw new Error(`refused: ${relPath} links outside the skill folder`)
        path = target
        info = await stat(path)
      }
      if (info.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKILL_BINARY_CACHE.test(`${relPath}/`)) continue
        await walk(path, relPath, within)
        continue
      }
      if (!info.isFile() || SKILL_BINARY_CACHE.test(relPath)) continue
      if (!validRelPath(relPath)) throw new Error(`refused: ${JSON.stringify(relPath)} is not a path a skill can hold`)
      if (out.length >= SKILL_MAX_FILES) throw new Error(`refused: a skill holds at most ${SKILL_MAX_FILES} files`)
      if (info.size > SKILL_MAX_FILE_BYTES) throw new Error(`refused: ${relPath} is ${sizeWords(info.size)}, over the ${sizeWords(SKILL_MAX_FILE_BYTES)} a file may be`)
      total += info.size
      if (total > SKILL_MAX_BYTES) throw new Error(`refused: the skill is over the ${sizeWords(SKILL_MAX_BYTES)} a skill may be`)
      const bytes = new Uint8Array(await readFile(path))
      if (isNativeBinary(bytes)) throw new Error(`refused: ${relPath} is a native binary; each host fetches its own`)
      out.push({ path: relPath, bytes, executable: (info.mode & 0o111) !== 0 })
    }
  }

  await walk(root, '')
  return out.map(wireFile)
}

/**
 * Write a skill's files under `dir` (made if missing): parent folders,
 * contents, and the executable bit as 0755 or 0644. A path that is not a
 * clean relative path, or that would land outside `dir`, is refused before
 * anything is written.
 */
export async function writeSkillTree(dir: string, files: readonly StoredFile[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const root = await realpath(dir)
  const targets = files.map((f) => {
    const target = join(root, ...f.path.split('/'))
    if (!validRelPath(f.path) || !inside(root, target) || relative(root, target).startsWith('..')) throw new Error(`refused: ${JSON.stringify(f.path)} is outside the skill folder`)
    return { file: f, target }
  })
  for (const { file, target } of targets) {
    await mkdir(dirname(target), { recursive: true })
    // A folder made above may be a link that an earlier write planted; its real place must still be inside.
    if (!inside(root, await realpath(dirname(target)))) throw new Error(`refused: ${file.path} is outside the skill folder`)
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error(`refused: ${file.path} is a link; a skill writes files`)
    await writeFile(target, file.bytes)
    await chmod(target, file.executable ? 0o755 : 0o644)
  }
}
