import { chmodSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
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
 * folder, a native binary, or past the limits. With `dropNative` a native
 * binary is left out and its path pushed there instead (the one-time
 * import keeps the rest of such a skill).
 */
export async function readSkillDir(dir: string, opts: { dropNative?: string[] } = {}): Promise<SkillFile[]> {
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
      if (isNativeBinary(bytes)) {
        if (!opts.dropNative) throw new Error(`refused: ${relPath} is a native binary; each host fetches its own`)
        opts.dropNative.push(relPath)
        total -= info.size
        continue
      }
      out.push({ path: relPath, bytes, executable: (info.mode & 0o111) !== 0 })
    }
  }

  await walk(root, '')
  return out.map(wireFile)
}

/** The modes a written tree takes: 0755/0644, or 0555/0444 for a tree nothing may edit in place (a materialized generation). */
export interface TreeModes {
  readOnly?: boolean
}
const fileMode = (executable: boolean, modes: TreeModes): number => (modes.readOnly ? (executable ? 0o555 : 0o444) : executable ? 0o755 : 0o644)

/** Each file's target under `root`, refused before anything is written when a path is not clean or would land outside. */
function plannedTargets(root: string, files: readonly StoredFile[]): { file: StoredFile; target: string }[] {
  return files.map((f) => {
    const target = join(root, ...f.path.split('/'))
    if (!validRelPath(f.path) || !inside(root, target) || relative(root, target).startsWith('..')) throw new Error(`refused: ${JSON.stringify(f.path)} is outside the skill folder`)
    return { file: f, target }
  })
}

const outsideRefusal = (file: StoredFile): Error => new Error(`refused: ${file.path} is outside the skill folder`)
const linkRefusal = (file: StoredFile): Error => new Error(`refused: ${file.path} is a link; a skill writes files`)

/**
 * Write a skill's files under `dir` (made if missing): parent folders,
 * contents, and the executable bit as 0755 or 0644 (0555 or 0444 with
 * `readOnly`). A path that is not a clean relative path, or that would land
 * outside `dir`, is refused before anything is written.
 */
export async function writeSkillTree(dir: string, files: readonly StoredFile[], modes: TreeModes = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  const root = await realpath(dir)
  for (const { file, target } of plannedTargets(root, files)) {
    await mkdir(dirname(target), { recursive: true })
    // A folder made above may be a link that an earlier write planted; its real place must still be inside.
    if (!inside(root, await realpath(dirname(target)))) throw outsideRefusal(file)
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw linkRefusal(file)
    await writeFile(target, file.bytes)
    await chmod(target, fileMode(file.executable, modes))
  }
}

/** writeSkillTree's synchronous twin, for the materializer's one-skill steps (skills/materialize.ts); the same checks. */
export function writeSkillTreeSync(dir: string, files: readonly StoredFile[], modes: TreeModes = {}): void {
  mkdirSync(dir, { recursive: true })
  const root = realpathSync(dir)
  for (const { file, target } of plannedTargets(root, files)) {
    mkdirSync(dirname(target), { recursive: true })
    if (!inside(root, realpathSync(dirname(target)))) throw outsideRefusal(file)
    let link = false
    try {
      link = lstatSync(target).isSymbolicLink()
    } catch {
      /* not there yet */
    }
    if (link) throw linkRefusal(file)
    writeFileSync(target, file.bytes, { mode: fileMode(file.executable, modes) })
    chmodSync(target, fileMode(file.executable, modes))
  }
}
