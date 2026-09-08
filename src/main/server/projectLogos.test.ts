import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ProjectLogos } from './projectLogos'

let root: string
let logos: ProjectLogos
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-logos-'))
  logos = new ProjectLogos(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
it('copies, reselects its saved file, replaces suffix and removes only this project', async () => {
  const png = join(root, 'source.PNG')
  const svg = join(root, 'source.svg')
  await writeFile(png, 'png content')
  await writeFile(svg, '<svg/>')
  const saved = await logos.save('foo/bar', png)
  expect(saved.startsWith(join(root, 'project-logos'))).toBe(true)
  expect(await readFile(saved, 'utf8')).toBe('png content')
  expect(await logos.save('foo/bar', saved)).toBe(saved)
  const other = await logos.save('foo-bar', png)
  expect(other).not.toBe(saved)
  const replacement = await logos.save('foo/bar', svg)
  expect(replacement.endsWith('.svg')).toBe(true)
  await expect(readFile(saved)).rejects.toThrow()
  expect(await readFile(replacement, 'utf8')).toBe('<svg/>')
  await logos.remove('foo/bar')
  expect(await readdir(join(root, 'project-logos'))).toHaveLength(1)
  expect(await readFile(other, 'utf8')).toBe('png content')
  await logos.remove('foo/bar')
})
it('rejects wrong types and oversized uploads without removing the old logo', async () => {
  const png = join(root, 'source.png')
  await writeFile(png, 'old')
  const saved = await logos.save('../project', png)
  await writeFile(png, Buffer.alloc(2 * 1024 * 1024 + 1))
  await expect(logos.save('../project', png)).rejects.toThrow('too large')
  await expect(logos.save('../project', join(root, 'bad.txt'))).rejects.toThrow('Logo must')
  expect(await readFile(saved, 'utf8')).toBe('old')
  expect(await readdir(join(root, 'project-logos'))).toHaveLength(1)
})
it('serializes concurrent saves for a project', async () => {
  const a = join(root, 'a.png')
  const b = join(root, 'b.svg')
  await writeFile(a, 'a')
  await writeFile(b, 'b')
  const [, saved] = await Promise.all([logos.save('p', a), logos.save('p', b)])
  expect(await readdir(join(root, 'project-logos'))).toHaveLength(1)
  expect(await readFile(saved, 'utf8')).toBe('b')
})
