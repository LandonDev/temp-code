import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectDevTargets, frameworkOf, iosCommand, pnpmPackages, runnerOf } from './devTargets'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-devtargets-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const put = (rel: string, body: string | object) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
const ids = async () => (await detectDevTargets(root, 'site')).map((t) => `${t.id} ${t.kind} ${t.framework} :: ${t.command.split('\n')[0]}`)

describe('detectDevTargets', () => {
  it('reads a single web app with its lockfile', async () => {
    put('package.json', { scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', test: 'vitest' } })
    put('bun.lock', '')
    expect(await ids()).toEqual(['.#dev web vite :: bun run dev'])
  })

  it('offers one target per package, the root first, then the workspace apps by name, each saying what it starts', async () => {
    put('package.json', { workspaces: ['apps/*', 'packages/*'], scripts: { dev: 'turbo dev', 'dev:api': 'tsx api.ts', start: 'node server.js' } })
    put('bun.lock', '')
    put('apps/web/package.json', { name: 'web', scripts: { start: 'next start', dev: 'next dev', storybook: 'storybook dev' } })
    put('apps/admin/package.json', { name: 'admin', scripts: { serve: 'vite preview', preview: 'vite preview' } })
    put('packages/ui/package.json', { name: 'ui', scripts: { dev: 'tsc --watch', build: 'tsc' } })
    const targets = await detectDevTargets(root, 'acme')
    expect(targets.map((t) => [t.id, t.name, t.command, t.what])).toEqual([
      ['.#dev', 'acme', 'bun run dev', 'Dev server'],
      ['apps/admin#serve', 'admin', 'bun run serve', 'Vite dev server'],
      ['apps/web#dev', 'web', 'bun run dev', 'Next.js dev server']
    ])
  })

  it('reads a monorepo of sites through its workspaces, each with its own name', async () => {
    put('package.json', { workspaces: ['apps/*'], scripts: { lint: 'eslint .' } })
    put('pnpm-lock.yaml', '')
    put('apps/web/package.json', { name: '@acme/web', scripts: { dev: 'next dev' } })
    put('apps/docs/package.json', { name: 'docs', scripts: { dev: 'astro dev', start: 'astro preview' } })
    put('apps/empty/README.md', 'x')
    const targets = await detectDevTargets(root, 'acme')
    expect(targets.map((t) => [t.id, t.name, t.framework, t.command])).toEqual([
      ['apps/docs#dev', 'docs', 'astro', 'pnpm run dev'],
      ['apps/web#dev', 'web', 'next', 'pnpm run dev']
    ])
  })

  it('reads pnpm-workspace.yaml when package.json names no workspaces', async () => {
    expect(pnpmPackages("packages:\n  - 'sites/*'\n  - \"tools/cli\" # one\nother: 1\n  - nope")).toEqual(['sites/*', 'tools/cli'])
    put('package.json', {})
    put('pnpm-workspace.yaml', "packages:\n  - 'sites/*'\n")
    put('sites/a/package.json', { scripts: { dev: 'vite' } })
    expect(await ids()).toEqual(['sites/a#dev web vite :: npm run dev'])
  })

  it('marks an Expo app as Mac-only and leaves its generated ios/ alone', async () => {
    put('package.json', { dependencies: { expo: '^52' }, scripts: { start: 'expo start', ios: 'expo run:ios' } })
    put('yarn.lock', '')
    put('ios/App.xcworkspace/contents.xcworkspacedata', '')
    expect(await ids()).toEqual(['.#start expo expo :: yarn start'])
    const [expo] = await detectDevTargets(root, 'site')
    expect([expo.macOnly, expo.what]).toEqual([true, 'Expo app'])
  })

  it('leaves out an Electron app and anything that is not a server', async () => {
    put('package.json', { scripts: { dev: 'electron-vite dev', start: 'electron-vite preview', 'dev:types': 'tsc --watch' } })
    expect(await ids()).toEqual([])
  })

  it('finds an Xcode app as a Mac-only target, a workspace over its project, XcodeGen two folders down', async () => {
    put('Shop.xcodeproj/project.pbxproj', '')
    put('Shop.xcworkspace/contents.xcworkspacedata', '')
    put('ios/TempCode/project.yml', 'name: TempCode\noptions: {}\n')
    const targets = await detectDevTargets(root, 'shop')
    expect(targets.map((t) => [t.id, t.name, t.kind, t.macOnly, t.dir, t.what])).toEqual([
      ['ios:./Shop.xcworkspace', 'Shop', 'ios', true, '', 'iOS app in the Simulator'],
      ['ios:ios/TempCode/project.yml', 'TempCode', 'ios', true, 'ios/TempCode', 'iOS app in the Simulator']
    ])
  })
})

describe('the pieces', () => {
  it('names the framework and the runner', () => {
    expect(frameworkOf('next dev --turbo')).toBe('next')
    expect(frameworkOf('bun --hot src/index.ts')).toBe('bun')
    expect(frameworkOf('./run.sh')).toBeNull()
    expect(runnerOf(['bun.lockb'])('dev')).toBe('bun run dev')
    expect(runnerOf([])('dev')).toBe('npm run dev')
  })

  it('writes an iOS script the shell parses', () => {
    for (const cmd of [iosCommand('', 'Shop.xcworkspace', "/tmp/it's"), iosCommand('ios/App', 'project.yml', '/tmp/dd'), iosCommand('', 'Shop.xcodeproj', '/tmp/dd')]) {
      expect(() => execFileSync('sh', ['-n', '-c', cmd])).not.toThrow()
    }
    expect(iosCommand('', 'Shop.xcworkspace', '/tmp/dd')).toContain("xcodebuild -workspace 'Shop.xcworkspace' -scheme \"$SCHEME\"")
  })
})
