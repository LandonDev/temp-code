import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fsCopyPath,
  fsCreatePath,
  fsDeletePath,
  fsInspectPaths,
  fsListPath,
  fsMovePath,
  fsProjectFiles,
  fsReadBase64,
  fsReadPreview,
  fsReadText,
  fsRenamePath,
  fsStatFiles,
  fsWriteText
} from './fspaths'

const execFileP = promisify(execFile)
const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `temp-code-m3b-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('filesystem path operations', () => {
  it('lists folders first, includes symlinked folders, marks simple ignores, and hides .DS_Store', async () => {
    const root = await tempRoot('list')
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'z.txt'), 'z')
    await writeFile(join(root, 'debug.log'), 'log')
    await writeFile(join(root, '.DS_Store'), 'hidden')
    await writeFile(join(root, '.gitignore'), '*.log\nignored\n')
    await mkdir(join(root, 'ignored'))
    await symlink(join(root, 'folder'), join(root, 'linked-folder'))

    const entries = await fsListPath(root)
    expect(entries.map((entry) => entry.name)).not.toContain('.DS_Store')
    expect(entries.find((entry) => entry.name === 'linked-folder')?.isDir).toBe(true)
    expect(entries.find((entry) => entry.name === 'debug.log')?.ignored).toBe(true)
    expect(entries.find((entry) => entry.name === 'ignored')?.ignored).toBe(true)
    const firstFile = entries.findIndex((entry) => !entry.isDir)
    expect(entries.slice(0, firstFile).every((entry) => entry.isDir)).toBe(true)
    expect(entries.find((entry) => entry.name === 'folder')?.path).toBe(join(root, 'folder'))
  })

  it('uses git ls-files for tracked and untracked non-ignored project files', async () => {
    const root = await tempRoot('project-git')
    await execFileP('git', ['init', root])
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'tracked.txt'), 'tracked')
    await writeFile(join(root, 'untracked.txt'), 'untracked')
    await writeFile(join(root, 'ignored.txt'), 'ignored')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'tracked.js'), 'tracked vendor')
    await execFileP('git', [
      '-C',
      root,
      'add',
      '.gitignore',
      'tracked.txt',
      'node_modules/tracked.js'
    ])

    const files = await fsProjectFiles(root)
    expect(files.map((file) => file.relative).sort()).toEqual([
      '.gitignore',
      'tracked.txt',
      'untracked.txt'
    ])
    expect(files.find((file) => file.relative === 'tracked.txt')).toEqual({
      name: 'tracked.txt',
      path: join(root, 'tracked.txt'),
      relative: 'tracked.txt'
    })
  })

  it('falls back to a guarded filesystem walk outside git', async () => {
    const root = await tempRoot('project-walk')
    await writeFile(join(root, '.gitignore'), '*.tmp\n')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'keep.ts'), 'ok')
    await writeFile(join(root, 'skip.tmp'), 'no')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'skip.js'), 'no')
    await symlink(join(root, 'src'), join(root, 'linked-src'))

    const files = await fsProjectFiles(root)
    expect(files.map((file) => file.relative).sort()).toEqual(['.gitignore', 'src/keep.ts'])
  })

  it('creates nested files and folders, refuses overwrite, and deletes recursively', async () => {
    const root = await tempRoot('create-delete')
    const file = await fsCreatePath(root, 'one/two/file.txt', false)
    const folder = await fsCreatePath(root, 'nested/folder/', true)
    expect(await readFile(file, 'utf8')).toBe('')
    expect((await stat(folder)).isDirectory()).toBe(true)
    await expect(fsCreatePath(root, 'one/two/file.txt', false)).rejects.toThrow(
      'A file or folder file.txt already exists'
    )
    await fsDeletePath(join(root, 'one'))
    await expect(stat(join(root, 'one'))).rejects.toThrow()
    await expect(fsDeletePath(join(root, 'missing'))).rejects.toThrow('No such file or directory')
  })

  it('renames case-only names and allows a nested relative destination', async () => {
    const root = await tempRoot('rename')
    const original = join(root, 'readme.md')
    await writeFile(original, 'hello')

    const renamed = await fsRenamePath(original, 'README.md')
    expect(renamed).toBe(join(root, 'README.md'))
    expect(await readFile(renamed, 'utf8')).toBe('hello')

    const nested = await fsRenamePath(renamed, 'docs/README.md')
    expect(nested).toBe(join(root, 'docs', 'README.md'))
    expect(await readFile(nested, 'utf8')).toBe('hello')
  })

  it('copies recursively to unique sibling names and rejects copying a folder into itself', async () => {
    const root = await tempRoot('copy')
    const source = join(root, 'source')
    const child = join(source, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(source, 'note.txt'), 'hello')

    const copied = await fsCopyPath(source, root)
    expect(basename(copied)).toBe('source copy')
    expect(await readFile(join(copied, 'note.txt'), 'utf8')).toBe('hello')
    await expect(fsCopyPath(source, child)).rejects.toThrow('Cannot paste a folder into itself.')
  })

  it('stops recursive copy when a symbolic link points back to an active ancestor', async () => {
    const root = await tempRoot('copy-loop')
    const source = join(root, 'source')
    await mkdir(join(source, 'child'), { recursive: true })
    await symlink(source, join(source, 'child', 'back'))

    await expect(fsCopyPath(source, root)).rejects.toThrow(
      'Cannot copy a folder with a recursive symbolic link.'
    )
  })

  it('moves into a destination parent and rejects collisions and self-descendants', async () => {
    const root = await tempRoot('move')
    const source = join(root, 'source')
    const child = join(source, 'child')
    const destinationParent = join(root, 'destination')
    await mkdir(child, { recursive: true })
    await mkdir(destinationParent)

    await expect(fsMovePath(source, child)).rejects.toThrow('Cannot paste a folder into itself.')
    await mkdir(join(destinationParent, 'source'))
    await expect(fsMovePath(source, destinationParent)).rejects.toThrow(
      'A file or folder source already exists'
    )
    await rm(join(destinationParent, 'source'), { recursive: true })
    expect(await fsMovePath(source, destinationParent)).toBe(join(destinationParent, 'source'))
  })
})

describe('filesystem reads and writes', () => {
  it('reads bounded preview windows, clamps line count, truncates long lines, and rejects NUL', async () => {
    const root = await tempRoot('preview')
    const path = join(root, 'preview.txt')
    const long = 'x'.repeat(240)
    await writeFile(path, ['one', 'two', long, 'four', 'five'].join('\n'))

    expect(await fsReadPreview(path, 2, 2)).toEqual(['two', `${'x'.repeat(199)}…`])
    expect(await fsReadPreview(path, 0)).toEqual(['one'])
    const many = join(root, 'many.txt')
    await writeFile(many, Array.from({ length: 20 }, (_, index) => String(index + 1)).join('\n'))
    expect(await fsReadPreview(many, 99)).toHaveLength(12)
    await writeFile(path, 'fine\nbad\0line\n')
    await expect(fsReadPreview(path, 2)).rejects.toThrow('Binary file')
  })

  it('stats at most 64 files and reports null for missing paths and folders', async () => {
    const root = await tempRoot('stat')
    const file = join(root, 'file.txt')
    const missing = join(root, 'missing.txt')
    await writeFile(file, 'ok')
    const result = await fsStatFiles([file, missing, root])
    expect(result[0]).toMatchObject({ path: file })
    expect(result[0].mtimeMs).toEqual(expect.any(Number))
    expect(result.slice(1)).toEqual([
      { path: missing, mtimeMs: null },
      { path: root, mtimeMs: null }
    ])
    await expect(fsStatFiles(Array.from({ length: 65 }, () => file))).rejects.toThrow(
      'Too many paths'
    )
  })

  it('inspects existing paths, expands home, follows symlinks, and omits failures', async () => {
    const root = await tempRoot('inspect')
    const file = join(root, 'file.txt')
    const link = join(root, 'linked.txt')
    await writeFile(file, 'hello')
    await symlink(file, link)
    const result = await fsInspectPaths([file, link, join(root, 'missing'), '~'])
    expect(result[0]).toEqual({ path: file, name: 'file.txt', size: 5, isDir: false })
    expect(result[1]).toEqual({ path: link, name: 'linked.txt', size: 5, isDir: false })
    expect(result.at(-1)).toMatchObject({ isDir: true })
    expect(result.at(-1)?.path).not.toBe('~')
  })

  it('returns bare base64 and enforces the 20 MiB cap', async () => {
    const root = await tempRoot('base64')
    const file = join(root, 'file.bin')
    await writeFile(file, Buffer.from([0, 1, 2, 255]))
    expect(await fsReadBase64(file)).toBe('AAEC/w==')
    await truncate(file, 20 * 1024 * 1024 + 1)
    await expect(fsReadBase64(file)).rejects.toThrow(
      'File is too large to attach inline (maximum 20 MB).'
    )
  })

  it('reads strict UTF-8 and rejects NUL, invalid UTF-8, directories, and files over 8 MiB', async () => {
    const root = await tempRoot('read-text')
    const file = join(root, 'file.txt')
    await writeFile(file, 'héllo')
    expect(await fsReadText(file)).toBe('héllo')
    await writeFile(file, Buffer.from('bad\0text'))
    await expect(fsReadText(file)).rejects.toThrow('Binary files cannot be edited.')
    await writeFile(file, Buffer.from([0xc3, 0x28]))
    await expect(fsReadText(file)).rejects.toThrow('File is not valid UTF-8.')
    await expect(fsReadText(root)).rejects.toThrow('Not a file')
    await truncate(file, 8 * 1024 * 1024 + 1)
    await expect(fsReadText(file)).rejects.toThrow('File is too large to edit (maximum 8 MB).')
  })

  it('writes by atomic replacement, preserves mode, resolves symlinks, and cleans temporary files', async () => {
    const root = await tempRoot('write-text')
    const target = join(root, 'target.txt')
    const link = join(root, 'linked.txt')
    await writeFile(target, 'old')
    await chmod(target, 0o640)
    const oldInode = (await stat(target)).ino
    await symlink(target, link)

    await fsWriteText(link, 'new content')
    expect(await readFile(target, 'utf8')).toBe('new content')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o640)
    expect((await stat(target)).ino).not.toBe(oldInode)
    expect((await readdir(root)).filter((name) => name.includes('.monocode-'))).toEqual([])

    const created = join(root, 'created.txt')
    await fsWriteText(created, 'created')
    expect(await readFile(created, 'utf8')).toBe('created')
    await expect(fsWriteText(root, 'no')).rejects.toThrow('Cannot save text to a directory.')
    await expect(fsWriteText(created, 'x'.repeat(8 * 1024 * 1024 + 1))).rejects.toThrow(
      'File is too large to save (maximum 8 MB).'
    )
  })
})
