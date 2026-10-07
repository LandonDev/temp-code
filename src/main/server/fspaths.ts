import { execFileBudgeted as execFileP } from './spawnBudget'
import { createReadStream, realpathSync } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from 'node:path'
import { createInterface } from 'node:readline'
import type { FsFileMtime, FsPathEntry, FsPathInfo, FsProjectFile } from '@shared/contract-fsgit'


const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_EMBED_BYTES = 20 * 1024 * 1024
const MAX_STAT_FILES = 64
const MAX_PROJECT_FILES = 20_000
const MAX_WALK_DIRS = 4_000

const SKIPPED_WALK_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.vercel',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.idea',
  'Pods',
  'vendor',
  'bower_components',
  '.yarn',
  '.pnpm-store'
])

interface IgnoreRules {
  exact: Set<string>
  suffixes: string[]
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith(`~${sep}`) || path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  return resolve(path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function findProjectRoot(start: string): Promise<string> {
  let current = start
  while (true) {
    if ((await exists(join(current, '.git'))) || (await exists(join(current, '.gitignore')))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

async function loadIgnoreRules(from: string): Promise<IgnoreRules> {
  const exact = new Set<string>(['.git'])
  const suffixes: string[] = []
  const root = await findProjectRoot(from)
  const text = await readFile(join(root, '.gitignore'), 'utf8').catch(() => '')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const normalized = line.replace(/[\\/]$/, '')
    if (normalized.includes('/') || normalized.includes('\\')) continue
    if (normalized.startsWith('*.')) {
      const extension = normalized.slice(2)
      if (extension && !extension.includes('*')) suffixes.push(`.${extension}`)
    } else {
      exact.add(normalized)
    }
  }
  return { exact, suffixes }
}

function isIgnored(rules: IgnoreRules, name: string): boolean {
  return rules.exact.has(name) || rules.suffixes.some((suffix) => name.endsWith(suffix))
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function fileLabel(path: string, fallback: string): string {
  return basename(path) || fallback
}

function alreadyExists(label: string): string {
  return `A file or folder ${label} already exists at this location. Please choose a different name.`
}

function resolveUnder(parent: string, name: string): string {
  if (name.startsWith('/') || name.startsWith('\\')) {
    throw new Error('A file or folder name cannot start with a slash.')
  }
  const trimmed = name.replace(/[\\/]+$/, '')
  if (!trimmed || /^\s+$/.test(trimmed)) {
    throw new Error('A file or folder name must be provided.')
  }
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || Buffer.byteLength(segment) > 255) {
      throw new Error(
        `The name ${trimmed} is not valid as a file or folder name. Please choose a different name.`
      )
    }
  }
  const destination = join(parent, ...segments)
  if (!isWithin(parent, destination)) throw new Error('Invalid path')
  return destination
}

function isPrivateDir(path: string): boolean {
  if (extname(path) === '.app') return true
  if (process.platform !== 'darwin') return false
  const guarded = [join(homedir(), 'Library'), join(homedir(), '.Trash'), '/Library', '/System']
  return guarded.some((item) => resolve(path) === resolve(item))
}

function isIndexableRoot(root: string): boolean {
  if (isPrivateDir(root) || dirname(root) === root) return false
  const broad = [homedir(), '/Users', '/Applications', '/Volumes', '/home']
  return !broad.some((item) => resolve(root) === resolve(item))
}

function pathHasSkippedDir(path: string): boolean {
  return path.split('/').some((part) => SKIPPED_WALK_DIRS.has(part))
}

async function gitProjectFiles(root: string): Promise<FsProjectFile[] | null> {
  let stdout: string
  try {
    const result = await execFileP(
      'git',
      ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
    stdout = result.stdout
  } catch {
    return null
  }
  const files: FsProjectFile[] = []
  for (const raw of stdout.split('\0')) {
    if (!raw) continue
    const relativePath = raw.replaceAll('\\', '/')
    if (relativePath.endsWith('/') || pathHasSkippedDir(relativePath)) continue
    const path = join(root, relativePath)
    const name = basename(path)
    if (!name || name === '.DS_Store') continue
    files.push({ name, path, relative: relativePath })
    if (files.length >= MAX_PROJECT_FILES) break
  }
  return files
}

async function walkProjectFiles(root: string): Promise<FsProjectFile[]> {
  const rules = await loadIgnoreRules(root)
  const files: FsProjectFile[] = []
  const dirs = [root]
  let visited = 0
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    visited += 1
    if (visited > MAX_WALK_DIRS || files.length >= MAX_PROJECT_FILES) break
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      let isDir = entry.isDirectory()
      if (!entry.isDirectory() && !entry.isFile()) {
        isDir = await stat(path)
          .then((metadata) => metadata.isDirectory())
          .catch(() => false)
      }
      if (isDir) {
        if (
          SKIPPED_WALK_DIRS.has(entry.name) ||
          isIgnored(rules, entry.name) ||
          isPrivateDir(path)
        ) {
          continue
        }
        dirs.push(path)
        continue
      }
      if (isIgnored(rules, entry.name)) continue
      const relativePath = relative(root, path).split(sep).join('/')
      files.push({ name: entry.name, path, relative: relativePath })
      if (files.length >= MAX_PROJECT_FILES) break
    }
  }
  return files
}

export async function fsListPath(path: string): Promise<FsPathEntry[]> {
  const dir = expandHome(path)
  const rules = await loadIgnoreRules(dir)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw new Error(`${dir}: ${errorMessage(error)}`)
  }
  const output: FsPathEntry[] = []
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const entryPath = join(dir, entry.name)
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      isDir = await stat(entryPath)
        .then((metadata) => metadata.isDirectory())
        .catch(() => false)
    }
    output.push({
      name: entry.name,
      path: entryPath,
      isDir,
      ignored: isIgnored(rules, entry.name)
    })
  }
  output.sort(
    (a, b) =>
      Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  )
  return output
}

export async function fsProjectFiles(cwd: string): Promise<FsProjectFile[]> {
  const root = expandHome(cwd)
  const metadata = await stat(root).catch(() => null)
  if (!metadata?.isDirectory()) throw new Error(`${root}: Not a directory`)
  if (!isIndexableRoot(root)) return []
  return (await gitProjectFiles(root)) ?? walkProjectFiles(root)
}

export async function fsCreatePath(parent: string, name: string, isDir: boolean): Promise<string> {
  const parentDir = expandHome(parent)
  const destination = resolveUnder(parentDir, name)
  const label = fileLabel(destination, name)
  if (await exists(destination)) throw new Error(alreadyExists(label))
  try {
    if (isDir) {
      await mkdir(destination, { recursive: true })
    } else {
      await mkdir(dirname(destination), { recursive: true })
      const handle = await open(destination, 'wx')
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(alreadyExists(label))
    throw new Error(errorMessage(error))
  }
  return destination
}

async function sameEntry(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [aMeta, bMeta] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)])
  return Boolean(aMeta && bMeta && aMeta.dev === bMeta.dev && aMeta.ino === bMeta.ino)
}

export async function fsRenamePath(path: string, name: string): Promise<string> {
  const from = expandHome(path)
  if (!(await exists(from))) throw new Error(`${from}: No such file or directory`)
  const parent = dirname(from)
  if (parent === from) throw new Error('File has no parent directory.')
  const destination = resolveUnder(parent, name)
  if (await sameEntry(from, destination)) {
    if (from === destination) return from
    const temporary = join(parent, `.${fileLabel(from, 'tmp')}.monocode-rename-${Date.now()}`)
    await rename(from, temporary)
    try {
      await rename(temporary, destination)
    } catch (error) {
      await rename(temporary, from).catch(() => {})
      throw new Error(errorMessage(error))
    }
    return destination
  }
  if (await exists(destination)) {
    throw new Error(alreadyExists(fileLabel(destination, name)))
  }
  if (isWithin(from, destination)) throw new Error('Cannot move a folder into itself.')
  await mkdir(dirname(destination), { recursive: true })
  await rename(from, destination)
  return destination
}

export async function fsDeletePath(path: string): Promise<void> {
  const target = expandHome(path)
  if (!(await exists(target))) throw new Error(`${target}: No such file or directory`)
  const metadata = await lstat(target)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await unlink(target)
  } else {
    await rm(target, { recursive: true })
  }
}

function splitStemExt(name: string): [string, string] {
  const parsed = parse(name)
  if (!parsed.ext || !parsed.name) return [name, '']
  return [parsed.name, parsed.ext]
}

async function uniqueNameIn(dir: string, name: string): Promise<string> {
  const [stem, extension] = splitStemExt(name)
  for (let number = 0; number <= 1000; number += 1) {
    const candidate =
      number === 0
        ? name
        : number === 1
          ? `${stem} copy${extension}`
          : `${stem} copy ${number}${extension}`
    if (!(await exists(join(dir, candidate)))) return candidate
  }
  return `${stem} copy ${process.hrtime.bigint()}${extension}`
}

async function copyRecursive(from: string, to: string, active = new Set<string>()): Promise<void> {
  const metadata = await stat(from).catch((error) => {
    throw new Error(`${from}: ${errorMessage(error)}`)
  })
  if (!metadata.isDirectory()) {
    await copyFile(from, to).catch((error) => {
      throw new Error(`${to}: ${errorMessage(error)}`)
    })
    return
  }
  const canonical = await realpath(from)
  if (active.has(canonical)) {
    throw new Error('Cannot copy a folder with a recursive symbolic link.')
  }
  active.add(canonical)
  try {
    await mkdir(to).catch((error) => {
      throw new Error(`${to}: ${errorMessage(error)}`)
    })
    const entries = await readdir(from, { withFileTypes: true }).catch((error) => {
      throw new Error(`${from}: ${errorMessage(error)}`)
    })
    for (const entry of entries) {
      await copyRecursive(join(from, entry.name), join(to, entry.name), active)
    }
  } finally {
    active.delete(canonical)
  }
}

export async function fsCopyPath(from: string, destParent: string): Promise<string> {
  const source = expandHome(from)
  if (!(await exists(source))) throw new Error(`${source}: No such file or directory`)
  const destinationParent = expandHome(destParent)
  const destinationMetadata = await stat(destinationParent).catch(() => null)
  if (!destinationMetadata?.isDirectory()) {
    throw new Error(`${destinationParent} is not a folder`)
  }
  const sourceMetadata = await stat(source)
  if (sourceMetadata.isDirectory()) {
    const [canonicalSource, canonicalParent] = await Promise.all([
      realpath(source),
      realpath(destinationParent)
    ])
    if (isWithin(source, destinationParent) || isWithin(canonicalSource, canonicalParent)) {
      throw new Error('Cannot paste a folder into itself.')
    }
  }
  const name = await uniqueNameIn(destinationParent, fileLabel(source, source || 'copy'))
  const destination = join(destinationParent, name)
  await copyRecursive(source, destination)
  return destination
}

export async function fsMovePath(from: string, destParent: string): Promise<string> {
  const source = expandHome(from)
  if (!(await exists(source))) throw new Error(`${source}: No such file or directory`)
  const destinationParent = expandHome(destParent)
  const destinationMetadata = await stat(destinationParent).catch(() => null)
  if (!destinationMetadata?.isDirectory()) {
    throw new Error(`${destinationParent} is not a folder`)
  }
  const sourceMetadata = await stat(source)
  if (sourceMetadata.isDirectory() && isWithin(source, destinationParent)) {
    throw new Error('Cannot paste a folder into itself.')
  }
  const name = fileLabel(source, source || 'item')
  const destination = join(destinationParent, name)
  if (await sameEntry(source, destination)) return source
  if (await exists(destination)) throw new Error(alreadyExists(name))
  await rename(source, destination)
  return destination
}

export async function fsReadPreview(
  path: string,
  maxLines: number,
  startLine?: number
): Promise<string[]> {
  const target = expandHome(path)
  const metadata = await stat(target).catch((error) => {
    throw new Error(`${target}: ${errorMessage(error)}`)
  })
  if (!metadata.isFile()) throw new Error('Not a file')
  const limit = Math.max(1, Math.min(12, Math.trunc(maxLines)))
  const start = Math.max(1, Math.trunc(startLine ?? 1))
  const input = createReadStream(target, { encoding: 'utf8' })
  const reader = createInterface({ input, crlfDelay: Infinity })
  const lines: string[] = []
  let lineNumber = 0
  try {
    for await (const raw of reader) {
      lineNumber += 1
      if (lineNumber < start) continue
      if (lines.length >= limit) break
      if (raw.includes('\0')) throw new Error('Binary file')
      const characters = Array.from(raw)
      lines.push(characters.length > 200 ? `${characters.slice(0, 199).join('')}…` : raw)
    }
  } finally {
    reader.close()
    input.destroy()
  }
  return lines
}

export async function fsStatFiles(paths: string[]): Promise<FsFileMtime[]> {
  if (paths.length > MAX_STAT_FILES) throw new Error('Too many paths')
  return Promise.all(
    paths.map(async (path) => {
      const metadata = await stat(expandHome(path)).catch(() => null)
      return {
        path,
        mtimeMs: metadata?.isFile() ? Math.trunc(metadata.mtimeMs) : null
      }
    })
  )
}

export async function fsInspectPaths(paths: string[]): Promise<FsPathInfo[]> {
  const output: FsPathInfo[] = []
  for (const input of paths) {
    const path = expandHome(input)
    const metadata = await stat(path).catch(() => null)
    if (!metadata) continue
    output.push({
      path,
      name: basename(path) || path || 'attachment',
      size: metadata.size,
      isDir: metadata.isDirectory()
    })
  }
  return output
}

export async function fsReadBase64(path: string): Promise<string> {
  const target = expandHome(path)
  const metadata = await stat(target).catch((error) => {
    throw new Error(`${target}: ${errorMessage(error)}`)
  })
  if (!metadata.isFile()) throw new Error('Not a file')
  if (metadata.size > MAX_ATTACHMENT_EMBED_BYTES) {
    throw new Error('File is too large to attach inline (maximum 20 MB).')
  }
  return (await readFile(target)).toString('base64')
}

export async function fsReadText(path: string): Promise<string> {
  const target = expandHome(path)
  const metadata = await stat(target).catch((error) => {
    throw new Error(`${target}: ${errorMessage(error)}`)
  })
  if (!metadata.isFile()) throw new Error('Not a file')
  if (metadata.size > MAX_TEXT_FILE_BYTES) {
    throw new Error('File is too large to edit (maximum 8 MB).')
  }
  const bytes = await readFile(target)
  if (bytes.includes(0)) throw new Error('Binary files cannot be edited.')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('File is not valid UTF-8.')
  }
}

export async function fsWriteText(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_TEXT_FILE_BYTES) {
    throw new Error('File is too large to save (maximum 8 MB).')
  }
  const requested = expandHome(path)
  const destination = (await exists(requested)) ? await realpath(requested) : requested
  const metadata = await stat(destination).catch(() => null)
  if (metadata?.isDirectory()) throw new Error('Cannot save text to a directory.')
  const parent = dirname(destination)
  if (parent === destination) throw new Error('File has no parent directory.')
  const name = basename(destination)
  if (!name) throw new Error('Invalid file name.')

  let temporaryPath: string | null = null
  let handle: FileHandle | null = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(
      parent,
      `.${name}.monocode-${process.pid}-${process.hrtime.bigint()}-${attempt}.tmp`
    )
    try {
      handle = await open(candidate, 'wx')
      temporaryPath = candidate
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new Error(`${candidate}: ${errorMessage(error)}`)
    }
  }
  if (!temporaryPath || !handle) throw new Error('Could not create a temporary save file.')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    if (metadata) await chmod(temporaryPath, metadata.mode)
    await handle.close()
    handle = null
    await rename(temporaryPath, destination)
    temporaryPath = null
    const directory = await open(parent, 'r').catch(() => null)
    if (directory) {
      await directory.sync().catch(() => {})
      await directory.close()
    }
  } catch (error) {
    throw new Error(errorMessage(error))
  } finally {
    if (handle) await handle.close().catch(() => {})
    if (temporaryPath) await unlink(temporaryPath).catch(() => {})
  }
}

/** Whether a path sits inside one of the roots — by either spelling (a
 *  symlinked root such as /tmp vs /private/tmp must not fail), and only on
 *  a path-segment boundary (/repo must not admit /repo-other). A file that
 *  does not exist yet still resolves, so a plan or report poll can start
 *  before the model writes the file. */
export function withinRoots(path: string, roots: string[]): boolean {
  // The real spelling of a path whose tail may not exist yet: resolve the
  // deepest existing ancestor and put the missing tail back.
  const real = (p: string): string => {
    const tail: string[] = []
    let head = p
    for (;;) {
      try {
        return join(realpathSync(head), ...tail.reverse())
      } catch {
        const parent = dirname(head)
        if (parent === head) return p
        tail.push(basename(head))
        head = parent
      }
    }
  }
  const abs = resolve(path)
  const candidates = [abs, real(abs)]
  const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + sep)
  return roots
    .flatMap((r) => [resolve(r), real(resolve(r))])
    .some((root) => candidates.some((p) => inside(p, root)))
}
