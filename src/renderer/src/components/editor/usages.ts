import { useApp } from '../../state/store'
import { monaco } from './monaco'
import { referencesAt } from './lsp'

/**
 * IDEA's Show Usages popup (the Code Vision lens click): an anchored
 * panel — "Method <sig> of <container>   N usages" — listing each usage
 * as `File.java <line>  <excerpt>` with the call bolded, arrow/enter
 * navigation, and the current row's path in the footer. Cross-file rows
 * jump through the same file-surface reveal as everything else.
 */

interface UsageRow {
  uri: monaco.Uri
  relPath: string | null
  fileName: string
  line: number
  column: number
  excerpt: string
}

let open: { dispose: () => void } | null = null

function close(): void {
  open?.dispose()
  open = null
}

export async function showUsages(
  editor: monaco.editor.ICodeEditor,
  symbolName: string,
  position: monaco.IPosition
): Promise<void> {
  close()
  const model = editor.getModel()
  if (!model) return
  const refs = await referencesAt(model, position)
  const entryProject = useApp
    .getState()
    .projects.find((p) => model.uri.path.startsWith(p.cwd.endsWith('/') ? p.cwd : `${p.cwd}/`))
  const root = entryProject
    ? entryProject.cwd.endsWith('/')
      ? entryProject.cwd
      : `${entryProject.cwd}/`
    : null
  const simpleName = symbolName.split('(')[0]

  const rows: UsageRow[] = []
  for (const ref of (refs ?? []).slice(0, 100)) {
    const uri = monaco.Uri.parse(ref.uri)
    const target = monaco.editor.getModel(uri)
    const line = ref.range.start.line + 1
    const excerpt = target ? target.getLineContent(line).trim() : ''
    rows.push({
      uri,
      relPath: root && uri.path.startsWith(root) ? uri.path.slice(root.length) : null,
      fileName: uri.path.split('/').pop() ?? '',
      line,
      column: ref.range.start.character + 1,
      excerpt
    })
  }
  if (rows.length === 0) return

  // package of the anchor file, for the IDEA header
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(model.getValue())?.[1]
  const cls =
    model.uri.path
      .split('/')
      .pop()
      ?.replace(/\.(java|kt)$/, '') ?? ''

  const node = document.createElement('div')
  node.className = 'tc-usages'
  const header = document.createElement('div')
  header.className = 'tc-usages-header'
  const title = document.createElement('span')
  title.innerHTML = `<b>Method ${escapeHtml(symbolName)}</b> of ${escapeHtml(pkg ? `${pkg}.${cls}` : cls)}`
  const count = document.createElement('span')
  count.className = 'tc-usages-count'
  count.textContent = rows.length === 1 ? '1 usage' : `${rows.length} usages`
  header.append(title, count)
  const list = document.createElement('div')
  list.className = 'tc-usages-list'
  const footer = document.createElement('div')
  footer.className = 'tc-usages-footer'
  node.append(header, list, footer)

  let at = 0
  const rowEls: HTMLElement[] = rows.map((row, i) => {
    const el = document.createElement('div')
    el.className = 'tc-usages-row'
    const file = document.createElement('span')
    file.className = 'tc-usages-file'
    file.textContent = row.fileName
    const line = document.createElement('span')
    line.className = 'tc-usages-line'
    line.textContent = String(row.line)
    const code = document.createElement('span')
    code.className = 'tc-usages-code'
    code.innerHTML = escapeHtml(row.excerpt).replace(
      new RegExp(`\\b${escapeRegExp(simpleName)}\\b`),
      (m) => `<b>${m}</b>`
    )
    el.append(file, line, code)
    el.addEventListener('mousemove', () => select(i))
    el.addEventListener('click', () => jump(i))
    list.append(el)
    return el
  })

  const select = (i: number): void => {
    at = Math.max(0, Math.min(i, rows.length - 1))
    rowEls.forEach((el, j) => el.classList.toggle('tc-usages-selected', j === at))
    footer.textContent = rows[at].relPath ?? rows[at].uri.path
    rowEls[at].scrollIntoView({ block: 'nearest' })
  }
  const jump = (i: number): void => {
    const row = rows[i]
    close()
    if (row.relPath && entryProject) {
      useApp.getState().openFileSurface(entryProject.id, row.relPath, {
        lineNumber: row.line,
        column: row.column
      })
    } else {
      editor.setPosition({ lineNumber: row.line, column: row.column })
      editor.revealLineInCenter(row.line)
    }
  }
  select(0)

  const widget: monaco.editor.IContentWidget = {
    getId: () => 'tc.usages',
    getDomNode: () => node,
    getPosition: () => ({
      position,
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE
      ]
    })
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      select(at + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      select(at - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      jump(at)
    }
  }
  window.addEventListener('keydown', onKey, true)
  const blurSub = editor.onDidChangeModel(close)
  editor.addContentWidget(widget)
  open = {
    dispose: () => {
      window.removeEventListener('keydown', onKey, true)
      blurSub.dispose()
      editor.removeContentWidget(widget)
    }
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
