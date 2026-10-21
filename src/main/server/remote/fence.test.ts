import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { FENCED_PARAMS, FenceError, expandPath, fenceRequest, fencedPaths, insideRoots } from './fence'

/** R2 H1/H2: the real-path fence every remote request passes before a handler runs. */
let dir: string
let root: string
let outside: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-fence-'))
  root = join(dir, 'repo')
  outside = join(dir, 'elsewhere')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(dir, 'repo-other'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'a')
  writeFileSync(join(outside, 'secret'), 's')
  symlinkSync(join(outside, 'secret'), join(root, 'link-out'))
  symlinkSync(root, join(dir, 'alias'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('insideRoots', () => {
  it('admits a file under a root, by either spelling of the root', () => {
    expect(insideRoots(join(root, 'src', 'a.ts'), [root])).toBe(true)
    expect(insideRoots(root, [root])).toBe(true)
    expect(insideRoots(join(dir, 'alias', 'src', 'a.ts'), [root])).toBe(true)
    expect(insideRoots(join(root, 'src', 'a.ts'), [join(dir, 'alias')])).toBe(true)
    // /tmp vs /private/tmp on macOS: the real spelling of the file against the given root.
    expect(insideRoots(join(realpathSync(root), 'src', 'a.ts'), [root])).toBe(true)
  })
  it('admits a path that does not exist yet inside a root', () => {
    expect(insideRoots(join(root, 'new', 'file.md'), [root])).toBe(true)
    expect(insideRoots(join(outside, 'new', 'file.md'), [root])).toBe(false)
  })
  it('refuses escapes, prefix siblings, and a symlink that points out', () => {
    expect(insideRoots(join(root, '..', 'elsewhere', 'secret'), [root])).toBe(false)
    expect(insideRoots(join(dir, 'repo-other', 'x'), [root])).toBe(false)
    expect(insideRoots(join(root, 'link-out'), [root])).toBe(false)
    expect(insideRoots('/etc/passwd', [root])).toBe(false)
    expect(insideRoots(join(root, 'src', 'a.ts'), [])).toBe(false)
  })
  it('reads ~ the way the handlers do', () => {
    expect(expandPath('~')).toBe(homedir())
    expect(expandPath('~/x')).toBe(join(homedir(), 'x'))
    expect(insideRoots('~/.ssh/id_rsa', [root])).toBe(false)
  })
})

describe('FENCED_PARAMS', () => {
  const PATH_KEYS = new Set(['path', 'paths', 'cwd', 'parent', 'from', 'destParent', 'sourcePath', 'projectPath', 'options'])
  /** Fenced elsewhere, or a key that only looks like a path (`from` is a host id on accounts.*, harness.manifest and session.move (local-only), whose relPaths are checked against the sync set in harnessSet.ts). */
  const OWN_FENCE = new Set(['fs.media', 'file.read', 'attachment.read', 'accounts.push', 'accounts.pull', 'harness.manifest', 'session.move'])
  const paramsOf = (option: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null => {
    let schema = (option as z.ZodObject<{ params: z.ZodTypeAny }>).shape.params
    while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
      schema = (schema._def as unknown as { innerType: z.ZodTypeAny }).innerType
    return schema instanceof z.ZodObject ? schema : null
  }
  it('covers every path-taking method that is not scoped by an id or fenced on its own', () => {
    const missing: string[] = []
    for (const option of ClientRequestSchema.options as z.ZodTypeAny[]) {
      const method = (option as z.ZodObject<{ method: z.ZodLiteral<string> }>).shape.method.value
      const params = paramsOf(option)
      if (!params) continue
      const keys = Object.keys(params.shape)
      if (keys.some((k) => /Id$/.test(k))) continue // relative to a project, workspace or session
      if (!keys.some((k) => PATH_KEYS.has(k))) continue
      if (OWN_FENCE.has(method)) continue
      if (!(method in FENCED_PARAMS)) missing.push(method)
    }
    expect(missing).toEqual([])
  })
  it('names the right params', () => {
    const req = (method: string, params: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
    expect(fencedPaths(req('fs.readText', { path: '/a' }))).toEqual(['/a'])
    expect(fencedPaths(req('fs.statFiles', { paths: ['/a', '/b'] }))).toEqual(['/a', '/b'])
    expect(fencedPaths(req('fs.copyPath', { from: '/a', destParent: '/b' }))).toEqual(['/a', '/b'])
    expect(fencedPaths(req('fs.createPath', { parent: '/r', name: '../x', isDir: false }))).toEqual(['/r', '/x'])
    expect(fencedPaths(req('fs.renamePath', { path: '/r/a', name: 'b' }))).toEqual(['/r/a', '/r/b'])
    expect(fencedPaths(req('git.log', { cwd: '/r' }))).toEqual(['/r'])
    expect(fencedPaths(req('git.clone', { url: 'https://x/y', parent: '/p' }))).toEqual(['/p'])
    expect(fencedPaths(req('search.project', { options: { cwd: '/r', query: 'q' } }))).toEqual(['/r'])
    expect(fencedPaths(req('workspace.create', { path: '/w' }))).toEqual(['/w'])
    expect(fencedPaths(req('session.create', { provider: 'claude', model: 'm' }))).toEqual([])
    expect(fencedPaths(req('session.list', {}))).toBeNull()
  })
})

describe('fenceRequest', () => {
  const req = (method: string, params: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
  it('passes a request inside the roots and ignores methods without paths', () => {
    expect(() => fenceRequest(req('fs.readText', { path: join(root, 'src', 'a.ts') }), [root])).not.toThrow()
    expect(() => fenceRequest(req('session.list', {}), [])).not.toThrow()
  })
  it('throws the one typed error, naming the method and never the path', () => {
    let caught: unknown
    try {
      fenceRequest(req('fs.readText', { path: join(outside, 'secret') }), [root])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(FenceError)
    expect((caught as FenceError).code).toBe('outside-roots')
    expect((caught as Error).message).toBe('forbidden: fs.readText is outside app-managed roots')
    expect((caught as Error).message).not.toContain(outside)
    expect(() => fenceRequest(req('fs.statFiles', { paths: [join(root, 'src', 'a.ts'), '/etc/hosts'] }), [root])).toThrow(FenceError)
    expect(() => fenceRequest(req('fs.createPath', { parent: root, name: '../escape', isDir: true }), [root])).toThrow(FenceError)
    expect(() => fenceRequest(req('fs.readText', { path: join(root, 'link-out') }), [root])).toThrow(FenceError)
  })
})
