#!/usr/bin/env bun
/**
 * The renderer's first-paint budget, checked after every `electron-vite
 * build` (package.json `build`, the release gate in scripts/release.ts):
 *
 *   1. the index chunk plus everything it imports statically (what a launch
 *      parses before the rail paints) stays under BUDGET_BYTES;
 *   2. none of the lazy surfaces (surfaces/chunks.ts) is in that closure — a
 *      static import from the main chunk would silently fold a chunk back in
 *      long before the budget noticed.
 *
 * Reads out/bundle-map.json (the bundleMap plugin in electron.vite.config.ts).
 * `bun scripts/bundle-map.ts` prints the map when this fails.
 *
 *   bun scripts/check-bundle-size.ts            # check
 *   bun scripts/check-bundle-size.ts --print    # the numbers, no verdict
 */
import { entryChunk, loadBundleMap, staticClosure } from './bundle-map'

/** Measured 2026-10-21 after the split: 4.56 MiB for the closure (8.07 MiB
 *  before). 5 MiB leaves room for ordinary growth of the surfaces that belong
 *  in the first paint (about 10%), not for a chunk-sized regression: xterm
 *  alone is 0.3 MiB, CodeMirror 0.8, recharts 0.9. */
// 16 KiB of headroom over 5 MiB (2026-10-23): the empty-transcript fix landed at 5120.7 kB; move a surface out of the entry to win it back.
// 2026-10-27: the UI standard's Base UI primitives stay out of the first paint
// except the dialog every Modal rides: the tooltip loads its primitive on the
// first hover or in the idle slot (components/ui/tooltip.tsx), the menus and
// select ride the search, inbox and notes views' chunks, sonner the toaster's,
// the right panel its own. Measured 5,643.9 kB with everything in the entry.
export const BUDGET_BYTES = 5 * 1024 * 1024 + 16 * 1024

/** Module ids (suffixes, matched against the end of the id) that must never
 *  be in the entry chunk's static closure. */
export const NEVER_IN_ENTRY = [
  // packages
  'node_modules/@xterm/xterm/lib/xterm.mjs',
  'node_modules/@codemirror/view/dist/index.js',
  'node_modules/@codemirror/state/dist/index.js',
  'node_modules/@codemirror/merge/dist/index.js',
  'node_modules/recharts/es6/index.js',
  'node_modules/qrcode/lib/browser.js',
  'node_modules/@tanstack/virtual-core/dist/esm/index.js',
  // surfaces
  'src/renderer/src/surfaces/SettingsView.tsx',
  'src/renderer/src/surfaces/AliaxPagesView.tsx',
  'src/renderer/src/surfaces/DiffPane.tsx',
  'src/renderer/src/surfaces/DiffBody.tsx',
  'src/renderer/src/surfaces/FileEditor.tsx',
  'src/renderer/src/surfaces/editorSearch.ts',
  'src/renderer/src/surfaces/editorGit.ts',
  'src/renderer/src/surfaces/TerminalView.tsx',
  'src/renderer/src/surfaces/threads/ResearchView.tsx',
  'src/renderer/src/surfaces/threads/ImplementationView.tsx',
  'src/renderer/src/surfaces/threads/PlanView.tsx',
  'src/renderer/src/surfaces/threads/OrchestrationView.tsx',
  'src/renderer/src/surfaces/HtmlRenderFrame.tsx',
  'src/renderer/src/surfaces/MediaViewer.tsx',
  'src/renderer/src/surfaces/ReleaseNotesSurface.tsx',
  'src/renderer/src/chrome/Lightbox.tsx',
  // Every menu, context menu and popover body rides menuChunk (chrome/menuRows.tsx).
  'src/renderer/src/chrome/menuBody.tsx',
  'src/renderer/src/chrome/CustomizeGroupDialog.tsx',
  // The action-opened dialogs ride dialogsChunk (chrome/dialogs.ts), the changelog parser releaseNotesChunk.
  'src/renderer/src/chrome/ProjectDialogs.tsx',
  'src/renderer/src/chrome/ThreadDefaultsDialog.tsx',
  'src/renderer/src/chrome/PreambleDialog.tsx',
  'src/renderer/src/chrome/RemoteFolderDialog.tsx',
  'src/renderer/src/chrome/WhatsNewDialog.tsx',
  'src/renderer/src/chrome/ThreadBatchDialog.tsx',
  'src/renderer/src/lib/releaseNotesParse.ts',
  // The rail's virtualizer rides virtualChunk; the rail lists its cards plainly until it lands.
  'src/renderer/src/chrome/railVirtualRows.tsx',
  'src/renderer/src/aliax/pages.tsx'
]

export type Verdict = { ok: boolean; closureBytes: number; chunks: string[]; leaked: string[]; lines: string[] }

export function checkBundle(map = loadBundleMap(), budget = BUDGET_BYTES): Verdict {
  const [entryFile] = entryChunk(map)
  const closure = staticClosure(map, entryFile)
  const closureBytes = closure.reduce((n, f) => n + map.chunks[f].bytes, 0)
  const leaked: string[] = []
  for (const file of closure) {
    const row = map.chunks[file]
    if (row.type !== 'chunk') continue
    for (const id of Object.keys(row.modules)) {
      const hit = NEVER_IN_ENTRY.find((suffix) => id.endsWith(suffix))
      if (hit) leaked.push(`${hit} (in ${file})`)
    }
  }
  const lines = [
    `entry closure: ${(closureBytes / 1024).toFixed(1)} kB over ${closure.length} chunk(s); budget ${(budget / 1024).toFixed(1)} kB`,
    ...closure.map((f) => `  ${(map.chunks[f].bytes / 1024).toFixed(1).padStart(8)} kB  ${f}`)
  ]
  if (closureBytes > budget) lines.push(`FAIL: the first-paint closure is over budget by ${((closureBytes - budget) / 1024).toFixed(1)} kB`)
  for (const l of leaked) lines.push(`FAIL: ${l} is in the entry chunk; a static import pulled a lazy surface back in`)
  return { ok: closureBytes <= budget && leaked.length === 0, closureBytes, chunks: closure, leaked, lines }
}

if (import.meta.main) {
  const verdict = checkBundle()
  for (const line of verdict.lines) console.log(line)
  if (process.argv.includes('--print')) process.exit(0)
  if (!verdict.ok) {
    console.log('bun scripts/bundle-map.ts lists what the entry chunk holds')
    process.exit(1)
  }
  console.log('bundle ok')
}
