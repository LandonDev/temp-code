/**
 * What the React Compiler would and would not compile in the renderer.
 *
 *   bun scripts/react-compiler-tally.ts
 *
 * Runs babel-plugin-react-compiler over src/renderer/src/**\/*.{ts,tsx}
 * (tests and test stubs excluded) with the build's options plus a logger,
 * never writing a transformed byte, and tallies the compiler's own events:
 * CompileSuccess, CompileSkip (by reason), CompileError (by category and
 * reason) and PipelineError, per function and per file. The report lands in
 * scripts/.out/react-compiler/tally.md; nothing in the tree changes.
 */
import { transformAsync } from '@babel/core'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = resolve(ROOT, 'src/renderer/src')
const OUT = resolve(ROOT, 'scripts/.out/react-compiler/tally.md')

type Fn = { file: string; name: string; line: number }
type Skip = Fn & { reason: string }
type Fail = Fn & { category: string; reason: string }

const ok: Fn[] = []
const skipped: Skip[] = []
const failed: Fail[] = []
const pipeline: { file: string; message: string }[] = []
const other = new Map<string, number>()

function fnName(ev: Record<string, unknown>): string {
  return typeof ev.fnName === 'string' && ev.fnName ? ev.fnName : '(anonymous)'
}
function fnLine(ev: Record<string, unknown>): number {
  const loc = ev.fnLoc as { start?: { line?: number } } | null | undefined
  return loc?.start?.line ?? 0
}

const files: string[] = []
for await (const p of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: SRC, absolute: true })) {
  if (/\.test\.tsx?$/.test(p) || /\.dom\.test\.tsx$/.test(p) || p.includes('/test/stubs/')) continue
  files.push(p)
}
files.sort()

for (const file of files) {
  const rel = relative(ROOT, file)
  const code = await Bun.file(file).text()
  const logger = {
    logEvent(_filename: string | null, ev: Record<string, unknown>) {
      const kind = String(ev.kind)
      if (kind === 'CompileSuccess') ok.push({ file: rel, name: fnName(ev), line: fnLine(ev) })
      else if (kind === 'CompileSkip')
        skipped.push({ file: rel, name: fnName(ev), line: fnLine(ev), reason: String(ev.reason ?? '') })
      else if (kind === 'CompileError') {
        const d = (ev.detail ?? {}) as Record<string, unknown>
        const opts = (d.options ?? d) as Record<string, unknown>
        failed.push({
          file: rel,
          name: fnName(ev),
          line: fnLine(ev),
          category: String(opts.category ?? opts.severity ?? 'Unknown'),
          reason: String(opts.reason ?? d.reason ?? '').split('\n')[0]
        })
      } else if (kind === 'PipelineError') pipeline.push({ file: rel, message: String(ev.data ?? '') })
      else other.set(kind, (other.get(kind) ?? 0) + 1)
    }
  }
  try {
    await transformAsync(code, {
      filename: file,
      configFile: false,
      babelrc: false,
      code: false,
      ast: false,
      parserOpts: { plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] },
      plugins: [
        [
          'babel-plugin-react-compiler',
          { target: '19', compilationMode: 'infer', panicThreshold: 'none', logger }
        ]
      ]
    })
  } catch (e) {
    pipeline.push({ file: rel, message: (e as Error).message.split('\n')[0] })
  }
}

// ── report ───────────────────────────────────────────────────────────────

const byKey = <T>(xs: T[], key: (x: T) => string): [string, number][] => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}
const fileSet = (xs: Fn[]) => new Set(xs.map((x) => x.file))
const rows = (xs: [string, number][]) => xs.map(([k, n]) => `| ${k} | ${n} |`).join('\n')

const perFile = new Map<string, { ok: number; skip: Skip[]; fail: Fail[] }>()
const slot = (f: string) => {
  let s = perFile.get(f)
  if (!s) perFile.set(f, (s = { ok: 0, skip: [], fail: [] }))
  return s
}
for (const f of ok) slot(f.file).ok += 1
for (const s of skipped) slot(s.file).skip.push(s)
for (const f of failed) slot(f.file).fail.push(f)
const refused = [...perFile].filter(([, s]) => s.skip.length || s.fail.length)
refused.sort((a, b) => b[1].skip.length + b[1].fail.length - (a[1].skip.length + a[1].fail.length))

const md = `# React Compiler tally — ${new Date().toISOString().slice(0, 10)}

babel-plugin-react-compiler 1.0.0, \`target: '19'\`, \`compilationMode: 'infer'\`, \`panicThreshold: 'none'\`,
over ${files.length} files under src/renderer/src (tests and test/stubs excluded). Nothing was written.

## Totals

| outcome | functions | files |
|---|---|---|
| compiled | ${ok.length} | ${fileSet(ok).size} |
| skipped | ${skipped.length} | ${fileSet(skipped).size} |
| errored (bailed out) | ${failed.length} | ${fileSet(failed).size} |
| pipeline errors | ${pipeline.length} | ${new Set(pipeline.map((p) => p.file)).size} |
| files with any refusal | | ${refused.length} |
${other.size ? `\nOther logger events: ${[...other].map(([k, n]) => `${k} ${n}`).join(', ')}\n` : ''}
## Skips by reason

| reason | functions |
|---|---|
${rows(byKey(skipped, (s) => s.reason || '(none)'))}

## Errors by category

| category | functions |
|---|---|
${rows(byKey(failed, (f) => f.category))}

## Errors by reason

| reason | functions |
|---|---|
${rows(byKey(failed, (f) => f.reason || '(none)'))}

## Per file (files the compiler refused something in)

${refused
  .map(
    ([file, s]) =>
      `### ${file} — compiled ${s.ok}, skipped ${s.skip.length}, errored ${s.fail.length}\n` +
      [
        ...s.fail.map((f) => `- error L${f.line} ${f.name}: [${f.category}] ${f.reason}`),
        ...s.skip.map((k) => `- skip L${k.line} ${k.name}: ${k.reason}`)
      ].join('\n')
  )
  .join('\n\n')}
${pipeline.length ? `\n## Pipeline errors\n\n${pipeline.map((p) => `- ${p.file}: ${p.message}`).join('\n')}\n` : ''}`

// Cross-check against eslint-plugin-react-hooks: scripts/.out/react-compiler/
// lint-files.json (a sorted array of files its compiler-class rules flag,
// exhaustive-deps and set-state-in-effect excluded) when present.
let notes = ''
const lintPath = resolve(OUT, '..', 'lint-files.json')
if (existsSync(lintPath)) {
  const lint = new Set(JSON.parse(readFileSync(lintPath, 'utf8')) as string[])
  const refusedSet = new Set(refused.map(([f]) => f))
  const unflagged = [...refusedSet].filter((f) => !lint.has(f)).sort()
  const compiledAnyway = [...lint].filter((f) => !refusedSet.has(f)).sort()
  notes = `\n## Cross-check with lint (${lint.size} files flagged)\n\n` +
    `Refused by the compiler, not flagged by lint (${unflagged.length}):\n` +
    unflagged.map((f) => `- ${f}: ${perFile.get(f)!.fail.map((x) => x.category).filter((c, i, a) => a.indexOf(c) === i).join(', ')}`).join('\n') +
    `\n\nFlagged by lint, nothing refused (${compiledAnyway.length}):\n` +
    compiledAnyway.map((f) => `- ${f}`).join('\n') + '\n'
}

mkdirSync(resolve(OUT, '..'), { recursive: true })
writeFileSync(OUT, md + notes)
console.log(
  `files ${files.length} · compiled ${ok.length} · skipped ${skipped.length} · errored ${failed.length} · pipeline ${pipeline.length} · files with a refusal ${refused.length}`
)
console.log(`wrote ${relative(ROOT, OUT)}`)
