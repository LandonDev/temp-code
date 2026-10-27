import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/ui-preview.ts')
const dirs: string[] = []
const pages: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const page of pages.splice(0)) rmSync(page, { force: true })
})

function run(args: string[], cwd = root) {
  return spawnSync('bun', [script, ...args], { cwd, encoding: 'utf8', timeout: 60_000 })
}

function output(name: string) {
  const dark = `/tmp/ui-preview/${name}.html`
  const light = `/tmp/ui-preview/${name}.light.html`
  pages.push(dark, light)
  return { dark: readFileSync(dark, 'utf8'), light: readFileSync(light, 'utf8') }
}

function temporaryComponent(source: (name: string) => string) {
  // Keep imports under the repo so Bun can find React and the root tsconfig.
  const dir = mkdtempSync(join(root, 'scripts/.ui-preview-test-'))
  dirs.push(dir)
  const name = `Preview${randomUUID().replaceAll('-', '')}`
  writeFileSync(join(dir, 'sample.tsx'), source(name))
  return { dir, name, target: `sample.tsx#${name}` }
}

describe('ui-preview', () => {
  it('renders a named renderer export with JSON props in both themes', () => {
    const result = run([
      'src/renderer/src/components/ui/button.tsx#Button',
      '--props', '{"children":"Save","onClick":"fn"}'
    ])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const html = output('Button')
    for (const page of Object.values(html)) {
      expect(page).toContain('<!doctype html>')
      expect(page).toContain('data-slot="button"')
      expect(page).toContain('bg-primary text-primary-foreground')
      expect(page).toMatch(/<button[^>]*>Save<\/button>/)
      expect(page).toContain('width: 480px')
      expect(page).not.toContain('<script')
    }
    expect(html.dark).toContain('<html lang="en">')
    expect(html.dark).toContain('Button.light.html')
    expect(html.light).toContain('<html lang="en" class="theme-light">')
    expect(html.light).toContain('Button.html')
    expect(result.stdout).toContain('/tmp/ui-preview/Button.html\n/tmp/ui-preview/Button.light.html\n')
  })

  it('stubs CSS and nested callbacks, resolves aliases, and notes missing styles once', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      import './sample.css'
      import { cn } from '@renderer/lib/cn'
      import { motion } from 'motion/react'
      export function ${name}({ children, onReady, nested }) {
        onReady()
        nested.callbacks[0]()
        return <motion.div className={cn('sample', 'static')}>{children}</motion.div>
      }
    `)
    writeFileSync(join(dir, 'sample.css'), 'This is deliberately not valid CSS or JavaScript.')
    const result = run([target, '--props', JSON.stringify({
      children: '<Save & close>', onReady: 'fn', nested: { callbacks: ['fn'] }
    }), '--width', '320'], dir)
    expect(result.status, result.stderr).toBe(0)
    const html = output(name)
    expect(result.stdout.split('\n').filter((line) => line.startsWith('No built stylesheet')))
      .toEqual(['No built stylesheet at out/renderer/assets/*.css; writing previews without it.'])
    for (const page of Object.values(html)) {
      expect(page).toContain('width: 320px')
      expect(page).toContain('class="sample static"')
      expect(page).toContain('&lt;Save &amp; close&gt;')
      expect(page).not.toContain('deliberately not valid')
    }
  })

  it('resolves every alias of tsconfig.web.json and renders a store-backed component', () => {
    // @server/shared and @shared are the renderer's own aliases; a store read
    // through useSyncExternalStore has no server snapshot, so the render is a
    // client one into a document.
    const { dir, name, target } = temporaryComponent((name) => `
      import { useSyncExternalStore } from 'react'
      import { emptyNotes } from '@shared/notes'
      import { notesEmpty } from '@server/shared/notes'
      import { cn } from '@renderer/lib/cn'
      const subscribe = () => () => {}
      export function ${name}() {
        const empty = useSyncExternalStore(subscribe, () => notesEmpty(emptyNotes()))
        return <p className={cn('live')}>{empty ? 'notes empty' : 'notes written'}</p>
      }
    `)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    const html = output(name)
    expect(html.dark).toContain('notes empty')
    expect(html.light).toContain('notes empty')
  })

  it('renders the transcript fixture files, named exports included, in both themes', () => {
    for (const [target, name, exported] of [
      ['src/renderer/src/surfaces/transcript/ActionGroup.tsx#ActionGroup', 'ActionGroup', 'fixtures'],
      ['src/renderer/src/surfaces/transcript/ActionRow.tsx#ActionRow', 'ActionRow', 'ACTION_FIXTURES'],
    ] as const) {
      const result = run([target])
      expect(result.status, `${exported}: ${result.stderr}`).toBe(0)
      const html = output(name)
      const labels = (page: string) => page.match(/class="preview-label"/g)?.length ?? 0
      expect(labels(html.dark), name).toBeGreaterThanOrEqual(3)
      expect(labels(html.light)).toBe(labels(html.dark))
      expect(html.light).toContain('class="theme-light"')
    }
  }, 60_000)

  it('discovers adjacent fixtures and renders each name and its props in both pages', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      export function ${name}({ children, disabled, onReady, title }) {
        onReady()
        return <button disabled={disabled} title={title}>{children}</button>
      }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export default [
      { name: 'Ready <now>', props: { children: 'Save', onReady: 'fn' } },
      { name: 'Unavailable', props: { children: 'Waiting', disabled: true, onReady: () => {} } }
    ]`)
    const result = run([target, '--props', '{"title":"Shared","children":"Overridden"}'], dir)
    expect(result.status, result.stderr).toBe(0)
    for (const page of Object.values(output(name))) {
      expect(page).toContain('class="preview-label">Ready &lt;now&gt;</div>')
      expect(page).toContain('class="preview-label">Unavailable</div>')
      expect(page).toContain('<button title="Shared">Save</button>')
      expect(page).toContain('<button disabled="" title="Shared">Waiting</button>')
      expect(page).toContain('font-size: 11px')
      expect(page).not.toContain('Overridden')
    }
  })

  it('passes a fixture Set and element through untouched', () => {
    const { dir, name, target } = temporaryComponent((name) => `
      export function ${name}({ ids, icon }) {
        return <p>{[...ids].join(',')}{icon}</p>
      }
    `)
    writeFileSync(join(dir, 'sample.fixtures.tsx'), `export default [
      { name: 'Kept', props: { ids: new Set(['a', 'b']), icon: <b>i</b> } }
    ]`)
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(output(name).dark).toContain('<p>a,b<b>i</b></p>')
  })

  it('embeds all existing built styles without changing theme selectors', () => {
    const { dir, name, target } = temporaryComponent((name) => `export function ${name}() { return <span>Styled</span> }`)
    const assets = join(dir, 'out/renderer/assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'index.css'), ':root { --background: black; } html.theme-light { --background: white; }')
    writeFileSync(join(assets, 'component.css'), '.sample { color: var(--foreground); }')
    writeFileSync(join(assets, 'ignored.js'), 'not a stylesheet')
    const result = run([target], dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('No built stylesheet')
    for (const page of Object.values(output(name))) {
      expect(page).toContain('html.theme-light { --background: white; }')
      expect(page).toContain('.sample { color: var(--foreground); }')
      expect(page).toContain(`<base href="file://${assets}/"/>`)
      expect(page).not.toContain('not a stylesheet')
    }
  })

  it('names a default export after its module', () => {
    const { dir, name } = temporaryComponent(() => 'export default function Example() { return <span>Default export</span> }')
    writeFileSync(join(dir, `${name}.tsx`), readFileSync(join(dir, 'sample.tsx')))
    const result = run([`${name}.tsx#default`], dir)
    expect(result.status, result.stderr).toBe(0)
    for (const page of Object.values(output(name))) expect(page).toContain('<span>Default export</span>')
  })

  it('reports a missing export and malformed fixtures', () => {
    const { dir, target } = temporaryComponent((name) => `export function ${name}() { return <span>Example</span> }`)
    const missing = run(['sample.tsx#Missing'], dir)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('No export "Missing" in sample.tsx')
    writeFileSync(join(dir, 'sample.fixtures.tsx'), 'export default [{ name: "Missing props" }]')
    const malformed = run([target], dir)
    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('must default-export [{ name, props }]')
  })

  it.each([
    [[], 'Usage:'],
    [['sample.tsx'], 'Usage:'],
    [['sample.tsx#Example', '--width', '0'], '--width must be a positive integer'],
    [['sample.tsx#Example', '--width', 'NaN'], '--width must be a positive integer'],
    [['sample.tsx#Example', '--props', '[]'], '--props must be a JSON object']
  ])('rejects invalid arguments %j', (args, message) => {
    const result = run(args as string[])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })
})
