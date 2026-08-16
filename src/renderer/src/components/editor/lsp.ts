import type { ProjectMeta } from '@shared/domain'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { monaco } from './monaco'
import { registerWillRename } from '../../lib/file-events'
import { entryForUri, onModelSaved, openFile, registerSaveHook, type OpenedFile } from './models'

/**
 * The LSP client (docs/PLAN-3.md M13). The pool lives in main; this side
 * speaks raw JSON-RPC over `/lsp/<serverId>` — one WS text frame per LSP
 * message — and surfaces the protocol through Monaco's provider APIs.
 * Hand-rolled on purpose: monaco 0.56's bundled client pins rootUri to
 * null and syncs every model to every server, neither of which survives
 * contact with jdtls or a multi-project pool.
 *
 * One connection per (project, lang-kind). Providers register globally per
 * language id and route through the connection that owns the model's
 * project — LSP stays an enhancement: no connection, provider returns
 * nothing, the editor keeps working.
 */

export type LangKind = 'java' | 'web'

/** Dev-only didChange→publishDiagnostics latency log. */
const LSP_DEBUG = import.meta.env.DEV

/** Languages the IntelliJ engine serves (docs/PLAN-4.md M19). */
const IDEA_LANGS = new Set(['java', 'kotlin'])

/** monaco language id → pool kind (null = no server serves it). */
export function kindForLanguage(languageId: string): LangKind | null {
  if (languageId === 'java') return 'java'
  if (['typescript', 'tsx', 'javascript', 'jsx'].includes(languageId)) return 'web'
  return null
}

/** monaco language id → LSP textDocument languageId. */
const LSP_LANGUAGE: Record<string, string> = {
  typescript: 'typescript',
  tsx: 'typescriptreact',
  javascript: 'javascript',
  jsx: 'javascriptreact',
  java: 'java',
  kotlin: 'kotlin'
}

// ── LSP wire types (the slice we speak) ──────────────────────────────

interface LspPosition {
  line: number
  character: number
}
interface LspRange {
  start: LspPosition
  end: LspPosition
}
interface LspLocation {
  uri: string
  range: LspRange
}
interface LspLocationLink {
  targetUri: string
  targetSelectionRange: LspRange
}
interface LspTextEdit {
  range: LspRange
  newText: string
}
interface LspDiagnostic {
  range: LspRange
  message: string
  severity?: number
  source?: string
  code?: string | number
  tags?: number[]
  data?: unknown
}
interface LspCommand {
  title: string
  command: string
  arguments?: unknown[]
}
interface LspCodeAction {
  title: string
  kind?: string
  isPreferred?: boolean
  diagnostics?: LspDiagnostic[]
  edit?: LspWorkspaceEdit
  command?: LspCommand
  data?: unknown
}
interface LspInlayHint {
  position: LspPosition
  label: string | { value: string }[]
  kind?: number
  paddingLeft?: boolean
  paddingRight?: boolean
}
interface LspCompletionItem {
  label: string | { label: string }
  labelDetails?: { detail?: string; description?: string }
  command?: LspCommand
  kind?: number
  tags?: number[]
  detail?: string
  documentation?: string | { value: string }
  insertText?: string
  insertTextFormat?: number
  filterText?: string
  sortText?: string
  preselect?: boolean
  textEdit?: (LspTextEdit & { insert?: LspRange; replace?: LspRange }) | undefined
  additionalTextEdits?: LspTextEdit[]
  commitCharacters?: string[]
}
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: (
    | { textDocument: { uri: string }; edits: LspTextEdit[] }
    | { kind: 'create' | 'rename' | 'delete'; uri?: string; oldUri?: string; newUri?: string }
  )[]
}
interface LspSymbol {
  name: string
  kind: number
  location?: LspLocation
  range?: LspRange
  selectionRange?: LspRange
  children?: LspSymbol[]
  containerName?: string
}

// ── conversions ──────────────────────────────────────────────────────

const toLspPos = (p: monaco.Position): LspPosition => ({
  line: p.lineNumber - 1,
  character: p.column - 1
})
const toMonacoRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1
})
const toLspRange = (r: monaco.IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 }
})
// LSP CompletionItemKind (1-based) → monaco CompletionItemKind
const CIK = monaco.languages.CompletionItemKind
// index = LSP CompletionItemKind - 1 (kind 1 = Text … 25 = TypeParameter)
const COMPLETION_KINDS: monaco.languages.CompletionItemKind[] = [
  CIK.Text,
  CIK.Method,
  CIK.Function,
  CIK.Constructor,
  CIK.Field,
  CIK.Variable,
  CIK.Class,
  CIK.Interface,
  CIK.Module,
  CIK.Property,
  CIK.Unit,
  CIK.Value,
  CIK.Enum,
  CIK.Keyword,
  CIK.Snippet,
  CIK.Color,
  CIK.File,
  CIK.Reference,
  CIK.Folder,
  CIK.EnumMember,
  CIK.Constant,
  CIK.Struct,
  CIK.Event,
  CIK.Operator,
  CIK.TypeParameter
]
const SK = monaco.languages.SymbolKind
const SYMBOL_KINDS: monaco.languages.SymbolKind[] = [
  SK.File,
  SK.File,
  SK.Module,
  SK.Namespace,
  SK.Package,
  SK.Class,
  SK.Method,
  SK.Property,
  SK.Field,
  SK.Constructor,
  SK.Enum,
  SK.Interface,
  SK.Function,
  SK.Variable,
  SK.Constant,
  SK.String,
  SK.Number,
  SK.Boolean,
  SK.Array,
  SK.Object,
  SK.Key,
  SK.Null,
  SK.EnumMember,
  SK.Struct,
  SK.Event,
  SK.Operator,
  SK.TypeParameter
]
const SEVERITIES = [
  monaco.MarkerSeverity.Error, // unset — treat as error
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Warning,
  monaco.MarkerSeverity.Info,
  monaco.MarkerSeverity.Hint
]

const docString = (d?: string | { value: string }): string =>
  typeof d === 'string' ? d : (d?.value ?? '')

const toMarkers = (diagnostics: LspDiagnostic[]): monaco.editor.IMarkerData[] =>
  diagnostics.map((d) => ({
    ...toMonacoRange(d.range),
    message: d.message,
    severity: SEVERITIES[d.severity ?? 1],
    source: d.source,
    code: d.code === undefined ? undefined : String(d.code),
    tags: (d.tags ?? []).map((t) =>
      t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated
    )
  }))

// M16: which files the IntelliJ engine currently owns squiggles for, and
// which projects have proven the engine warm (first non-empty pull).
const ideaDiagUris = new Set<string>()
const ideaDiagTrusted = new Set<string>()

/** The engine dropped: put jdtls's cached diagnostics back on screen. */
function restoreJdtlsMarkers(projectId: string): void {
  const std = settledStd.get(projectId)
  for (const uri of [...ideaDiagUris]) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (!model) {
      ideaDiagUris.delete(uri)
      continue
    }
    const entry = entryForUri(model.uri)
    if (entry?.projectId !== projectId) continue
    ideaDiagUris.delete(uri)
    monaco.editor.setModelMarkers(model, `lsp-idea-${projectId}`, [])
    const cached = std?.diagnostics.get(uri)
    if (cached) monaco.editor.setModelMarkers(model, `lsp-java-${projectId}`, toMarkers(cached))
  }
}

// ── the connection ───────────────────────────────────────────────────

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class LspConnection {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private openDocs = new Map<string, { model: monaco.editor.ITextModel; version: number }>()
  private modelSubs = new Map<string, monaco.IDisposable>()
  private disposed = false
  private initP: Promise<void> | null = null
  readonly capabilities: Record<string, unknown> = {}
  /** Last published diagnostics per URI (LSP-shaped, feeds codeAction context). */
  readonly diagnostics = new Map<string, LspDiagnostic[]>()
  /** Active $/progress messages by token (latest wins the busy line). */
  private progress = new Map<string | number, string>()
  private changedAt = new Map<string, number>()

  constructor(
    readonly project: ProjectMeta,
    readonly kind: LangKind,
    private serverId: string,
    private wsPath: string,
    private settings: Record<string, unknown>,
    /** 'idea' = the IntelliJ engine (docs/PLAN-4.md): same java models,
     *  push diagnostics ignored (M16 pulls), no semantic registration yet. */
    readonly engine: 'standard' | 'idea' = 'standard'
  ) {}

  get rootUri(): string {
    return monaco.Uri.file(this.project.cwd).toString()
  }

  get alive(): boolean {
    return !this.disposed && this.ws?.readyState === WebSocket.OPEN
  }

  /** Stable across server restarts — a new generation clears the old one's markers. */
  private get markerOwner(): string {
    return `lsp-${this.engine === 'idea' ? 'idea' : this.kind}-${this.project.id}`
  }

  async connect(): Promise<void> {
    this.initP ??= this.doConnect()
    return this.initP
  }

  private async doConnect(): Promise<void> {
    const port = await window.api.getServerPort()
    const ws = new WebSocket(`ws://127.0.0.1:${port}${this.wsPath}`)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = (): void => resolve()
      ws.onerror = (): void => reject(new Error('lsp tunnel failed to open'))
    })
    ws.onmessage = (e): void => this.onMessage(String(e.data))
    ws.onclose = (): void => void this.onClose()
    const init = await this.request<{ capabilities: Record<string, unknown> }>('initialize', {
      processId: null,
      clientInfo: { name: 'temp-code' },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: this.project.name }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              // Structured labels: name | dim signature | right-aligned type.
              // jdtls collapses `label` to the bare member name when this is
              // advertised and ships the rest in labelDetails.
              labelDetailsSupport: true,
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
            },
            contextSupport: true
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {
            signatureInformation: { documentationFormat: ['markdown', 'plaintext'] }
          },
          definition: {},
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: {},
          formatting: {},
          foldingRange: {},
          documentHighlight: {},
          inlayHint: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  'quickfix',
                  'refactor',
                  'refactor.extract',
                  'refactor.inline',
                  'refactor.rewrite',
                  'source',
                  'source.organizeImports',
                  'source.fixAll'
                ]
              }
            },
            isPreferredSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ['edit'] }
          },
          // Servers use their own legend from the init result; this is the
          // spec superset so both jdtls and vtsls register statically.
          semanticTokens: {
            requests: { full: true, range: true },
            formats: ['relative'],
            tokenTypes: [
              'namespace',
              'type',
              'class',
              'enum',
              'interface',
              'struct',
              'typeParameter',
              'parameter',
              'variable',
              'property',
              'enumMember',
              'event',
              'function',
              'method',
              'macro',
              'keyword',
              'modifier',
              'comment',
              'string',
              'number',
              'regexp',
              'operator',
              'decorator'
            ],
            tokenModifiers: [
              'declaration',
              'definition',
              'readonly',
              'static',
              'deprecated',
              'abstract',
              'async',
              'modification',
              'documentation',
              'defaultLibrary'
            ],
            multilineTokenSupport: false,
            overlappingTokenSupport: false
          }
        },
        workspace: {
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ['create', 'rename', 'delete']
          },
          configuration: true,
          symbol: {},
          workspaceFolders: true,
          executeCommand: {}
        },
        window: { workDoneProgress: true }
      },
      initializationOptions: this.settings
    })
    Object.assign(this.capabilities, init.capabilities)
    monaco.editor.removeAllMarkers(this.markerOwner)
    this.notify('initialized', {})
    const settings = (this.settings as { settings?: unknown }).settings
    if (settings) this.notify('workspace/didChangeConfiguration', { settings })
    if (this.engine !== 'idea') maybeRegisterSemanticTokens(this)
    // Sync every already-open matching model.
    for (const model of monaco.editor.getModels()) this.maybeOpen(model)
  }

  private setBusy(text: string | null): void {
    const { lspBusy } = useApp.getState()
    if ((lspBusy[this.project.id] ?? null) === text) return
    useApp.setState({ lspBusy: { ...lspBusy, [this.project.id]: text } })
  }

  private async onClose(): Promise<void> {
    for (const p of this.pending.values()) p.reject(new Error('lsp connection closed'))
    this.pending.clear()
    this.openDocs.clear()
    for (const sub of this.modelSubs.values()) sub.dispose()
    this.modelSubs.clear()
    this.diagnostics.clear()
    this.progress.clear()
    this.changedAt.clear()
    this.setBusy(null)
    // The IntelliJ engine dropped: hand its files' squiggles back to jdtls
    // from the standard connection's cache (docs/PLAN-4.md M16).
    if (this.engine === 'idea') restoreJdtlsMarkers(this.project.id)
    if (this.disposed) return
    // The pool restarted (crash policy) or evicted us. One re-ensure — the
    // pool's own crash policy bounds retries; an error there ends here too.
    this.initP = null
    try {
      const res = await client.request<{ serverId: string; wsPath: string; status: string }>(
        'lsp.ensure',
        { projectId: this.project.id, lang: this.engine === 'idea' ? 'idea' : this.kind }
      )
      if (this.disposed || res.status === 'error') return
      this.serverId = res.serverId
      this.wsPath = res.wsPath
      await this.connect()
    } catch {
      // pool says no — squiggles fade, editing continues
    }
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number | string
      method?: string
      params?: unknown
      result?: unknown
      error?: { message: string }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.method && msg.id !== undefined) {
      void this.onServerRequest(msg.id, msg.method, msg.params)
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params)
    } else if (msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', ...payload }))
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params })
  }

  private respond(id: number | string, result: unknown): void {
    this.send({ id, result })
  }

  private async onServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    switch (method) {
      case 'workspace/configuration': {
        const items = (params as { items: { section?: string }[] }).items
        this.respond(
          id,
          items.map((i) => this.lookupSetting(i.section))
        )
        break
      }
      case 'workspace/applyEdit': {
        await applyWorkspaceEdit(this.project, (params as { edit: LspWorkspaceEdit }).edit)
        this.respond(id, { applied: true })
        break
      }
      case 'workspace/semanticTokens/refresh':
        // jdtls asks for this once indexing lands — repaint or stay stale.
        this.respond(id, null)
        semanticRefresh.get(this.kind)?.fire()
        break
      case 'workspace/inlayHint/refresh':
        this.respond(id, null)
        inlayRefresh.fire()
        break
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/codeLens/refresh':
        this.respond(id, null)
        break
      case 'window/showMessageRequest':
        this.respond(id, null)
        break
      default:
        this.send({ id, error: { code: -32601, message: `unhandled: ${method}` } })
    }
  }

  private lookupSetting(section?: string): unknown {
    const settings = (this.settings as { settings?: Record<string, unknown> }).settings ?? {}
    if (!section) return settings
    let cur: unknown = settings
    for (const part of section.split('.')) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part]
      else return null
    }
    return cur ?? null
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      // The IntelliJ engine's markers come from the pull loop (M16), never
      // from push — jdtls owns the push path.
      if (this.engine === 'idea') return
      const { uri, diagnostics } = params as { uri: string; diagnostics: LspDiagnostic[] }
      this.diagnostics.set(uri, diagnostics)
      const model = monaco.editor.getModel(monaco.Uri.parse(uri))
      if (!model) return
      if (LSP_DEBUG) {
        const t = this.changedAt.get(uri)
        if (t !== undefined) {
          this.changedAt.delete(uri)
          console.debug(
            `[lsp] ${this.kind} diagnostics after ${Math.round(performance.now() - t)}ms`
          )
        }
      }
      // While the IntelliJ engine owns a file's squiggles, jdtls only
      // feeds the cache (restored from there if the engine drops).
      if (this.kind === 'java' && ideaDiagUris.has(uri)) return
      monaco.editor.setModelMarkers(model, this.markerOwner, toMarkers(diagnostics))
    } else if (method === '$/progress') {
      const { token, value } = params as {
        token: string | number
        value: { kind: string; title?: string; message?: string; percentage?: number }
      }
      if (value.kind === 'end') this.progress.delete(token)
      else {
        const text = value.message ?? value.title ?? this.progress.get(token) ?? ''
        const pct = value.percentage != null ? ` ${Math.round(value.percentage)}%` : ''
        if (text) this.progress.set(token, `${text}${pct}`)
      }
      const latest = [...this.progress.values()].pop() ?? null
      this.setBusy(latest)
    } else if (method === 'language/status') {
      // jdtls-specific import/index status ("47% Starting Java Language Server").
      const { type, message } = params as { type: string; message?: string }
      if (type === 'Started' || type === 'ServiceReady') this.setBusy(null)
      else if (message && (type === 'Starting' || type === 'Error')) this.setBusy(message)
    }
  }

  /** Does this connection own the model? (language kind + project root) */
  owns(model: monaco.editor.ITextModel): boolean {
    if (this.engine === 'idea') {
      if (!IDEA_LANGS.has(model.getLanguageId())) return false
    } else if (kindForLanguage(model.getLanguageId()) !== this.kind) return false
    const root = this.project.cwd.endsWith('/') ? this.project.cwd : `${this.project.cwd}/`
    return model.uri.scheme === 'file' && model.uri.path.startsWith(root)
  }

  maybeOpen(model: monaco.editor.ITextModel): void {
    if (!this.owns(model)) return
    const uri = model.uri.toString()
    if (this.openDocs.has(uri)) return
    const doc = { model, version: 1 }
    this.openDocs.set(uri, doc)
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: LSP_LANGUAGE[model.getLanguageId()] ?? model.getLanguageId(),
        version: doc.version,
        text: model.getValue()
      }
    })
    this.schedulePull(uri)
    this.modelSubs.set(
      uri,
      model.onDidChangeContent((e) => {
        doc.version++
        this.schedulePull(uri)
        if (LSP_DEBUG) this.changedAt.set(uri, performance.now())
        this.notify('textDocument/didChange', {
          textDocument: { uri, version: doc.version },
          // monaco sorts an event's changes in reverse document order, so
          // sequential application per the LSP spec is position-safe.
          contentChanges: e.changes.map((c) => ({
            range: {
              start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
              end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 }
            },
            text: c.text
          }))
        })
      })
    )
    model.onWillDispose(() => this.closeDoc(uri))
  }

  private closeDoc(uri: string): void {
    if (!this.openDocs.delete(uri)) return
    this.modelSubs.get(uri)?.dispose()
    this.modelSubs.delete(uri)
    this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  didSave(model: monaco.editor.ITextModel): void {
    if (!this.openDocs.has(model.uri.toString())) return
    this.notify('textDocument/didSave', { textDocument: { uri: model.uri.toString() } })
  }

  // ── pull diagnostics (docs/PLAN-4.md M16, IntelliJ engine only) ────
  // IDEA's inspection results replace jdtls markers per file once the
  // engine proves warm (first non-empty pull); empties from a cold engine
  // never wipe jdtls's truth.

  private pullTimers = new Map<string, ReturnType<typeof setTimeout>>()

  schedulePull(uri: string): void {
    if (this.engine !== 'idea') return
    clearTimeout(this.pullTimers.get(uri))
    this.pullTimers.set(
      uri,
      setTimeout(() => void this.pullDiagnostics(uri), 500)
    )
  }

  private async pullDiagnostics(uri: string): Promise<void> {
    if (!this.alive) return
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (!model) return
    const r = await this.request<{ kind?: string; items?: LspDiagnostic[] } | null>(
      'textDocument/diagnostic',
      { textDocument: { uri } }
    ).catch(() => null)
    if (!r || r.kind === 'unchanged') return
    const items = r.items ?? []
    if (items.length === 0 && !ideaDiagTrusted.has(this.project.id)) return
    ideaDiagTrusted.add(this.project.id)
    this.diagnostics.set(uri, items)
    ideaDiagUris.add(uri)
    // IDEA owns this file's squiggles now — retire jdtls's.
    monaco.editor.setModelMarkers(model, `lsp-java-${this.project.id}`, [])
    monaco.editor.setModelMarkers(model, this.markerOwner, toMarkers(items))
  }

  dispose(): void {
    this.disposed = true
    this.ws?.close()
  }
}

// ── workspace edits (rename, organize imports, applyEdit) ────────────

/** Offset for an LSP position in raw text (for files with no open model). */
function offsetAt(text: string, pos: LspPosition): number {
  let offset = 0
  let line = 0
  while (line < pos.line) {
    const nl = text.indexOf('\n', offset)
    if (nl < 0) return text.length
    offset = nl + 1
    line++
  }
  return Math.min(offset + pos.character, text.length)
}

function applyEditsToText(text: string, edits: LspTextEdit[]): string {
  const resolved = edits
    .map((e) => ({
      start: offsetAt(text, e.range.start),
      end: offsetAt(text, e.range.end),
      t: e.newText
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const e of resolved) out = out.slice(0, e.start) + e.t + out.slice(e.end)
  return out
}

async function applyEditsToFile(
  project: ProjectMeta,
  uri: string,
  edits: LspTextEdit[]
): Promise<void> {
  const path = monaco.Uri.parse(uri).path
  const model = monaco.editor.getModel(monaco.Uri.parse(uri))
  if (model) {
    model.pushEditOperations(
      [],
      edits.map((e) => ({ range: toMonacoRange(e.range) as monaco.Range, text: e.newText })),
      () => null
    )
    return // an open model autosaves through the registry
  }
  const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
  if (!path.startsWith(root)) return // outside the project — not ours to write
  const rel = path.slice(root.length)
  const res = await client.request<{ content: string; tooLarge?: boolean }>('fs.read', {
    projectId: project.id,
    path: rel
  })
  if (res.tooLarge) return
  await client.request('fs.write', {
    projectId: project.id,
    path: rel,
    content: applyEditsToText(res.content, edits)
  })
}

export async function applyWorkspaceEdit(
  project: ProjectMeta,
  edit: LspWorkspaceEdit
): Promise<void> {
  const rel = (uri: string): string | null => {
    const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
    const path = monaco.Uri.parse(uri).path
    return path.startsWith(root) ? path.slice(root.length) : null
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ('textDocument' in change) {
        await applyEditsToFile(project, change.textDocument.uri, change.edits)
      } else if (change.kind === 'create' && change.uri) {
        const r = rel(change.uri)
        if (r)
          await client
            .request('fs.create', { projectId: project.id, path: r, kind: 'file' })
            .catch(() => {})
      } else if (change.kind === 'rename' && change.oldUri && change.newUri) {
        const from = rel(change.oldUri)
        const to = rel(change.newUri)
        if (from && to) await client.request('fs.rename', { projectId: project.id, path: from, to })
      } else if (change.kind === 'delete' && change.uri) {
        const r = rel(change.uri)
        if (r) await client.request('fs.delete', { projectId: project.id, path: r })
      }
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      await applyEditsToFile(project, uri, edits)
    }
  }
}

// ── the manager ──────────────────────────────────────────────────────

const conns = new Map<string, Promise<LspConnection | null>>()

// Every autosave flush becomes a didSave to whichever connection owns the
// document (jdtls builds incrementally off it).
onModelSaved((model) => {
  for (const connP of conns.values()) {
    void connP.then((conn) => conn?.didSave(model))
  }
})

/** Models pre-opened so peek/goto into unopened files has something to
 *  show; bounded LRU so casual navigation doesn't pin the world. */
const previews = new Map<string, OpenedFile>()
const PREVIEW_CAP = 30

async function ensurePreviewModel(project: ProjectMeta, uri: monaco.Uri): Promise<void> {
  if (monaco.editor.getModel(uri)) return
  const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
  if (uri.scheme !== 'file' || !uri.path.startsWith(root)) return
  const relPath = uri.path.slice(root.length)
  const key = `${project.id}:${relPath}`
  if (previews.has(key)) return
  try {
    const handle = await openFile(project, relPath)
    if (!handle.model) return
    previews.set(key, handle)
    if (previews.size > PREVIEW_CAP) {
      const [oldKey, old] = previews.entries().next().value as [string, OpenedFile]
      previews.delete(oldKey)
      old.release()
    }
  } catch {
    // unreadable target — peek shows what it can
  }
}

// ── decompiled sources (docs/PLAN-4.md M18) ──────────────────────────
// Library navigation lands on jar: URIs; the engine's `decompile`
// command supplies the text and peek renders it like any model.

const decompiledModels = new Map<string, monaco.editor.ITextModel>()

async function ensureDecompiledModel(projectId: string, rawUri: string): Promise<void> {
  const uri = monaco.Uri.parse(rawUri)
  if (monaco.editor.getModel(uri)) return
  const ij = settledIdea.get(projectId)
  if (!ij?.alive) return
  const res = await ij
    .request<{ code?: string } | null>('workspace/executeCommand', {
      command: 'decompile',
      arguments: [rawUri]
    })
    .catch(() => null)
  if (!res?.code) return
  decompiledModels.set(rawUri, monaco.editor.createModel(res.code, 'java', uri))
  if (decompiledModels.size > 20) {
    const oldest = decompiledModels.entries().next().value as [string, monaco.editor.ITextModel]
    decompiledModels.delete(oldest[0])
    oldest[1].dispose()
  }
}

function settingsFor(
  kind: LangKind,
  extras: {
    tsdkPath?: string
    javaRuntimes?: { name: string; path: string }[]
    eulaHash?: string
    defaultSdk?: string
    buildTool?: string
  },
  engine: 'standard' | 'idea' = 'standard',
  rootUri?: string
): Record<string, unknown> {
  if (engine === 'idea') {
    // EULA handshake + a JDK + a forced importer for the root: repos with
    // a checked-in .idea otherwise skip import silently (docs/PLAN-4.md
    // amendments — A/B-tested against the engine).
    return {
      ...(extras.eulaHash ? { eulaHash: extras.eulaHash } : {}),
      ...(extras.defaultSdk ? { defaultSdk: extras.defaultSdk } : {}),
      ...(extras.buildTool && rootUri ? { buildTools: { [rootUri]: extras.buildTool } } : {})
    }
  }
  if (kind === 'web') {
    return {
      settings: {
        typescript: {
          ...(extras.tsdkPath ? { tsdk: extras.tsdkPath } : {}),
          suggest: { completeFunctionCalls: true },
          inlayHints: { parameterNames: { enabled: 'literals' } }
        },
        javascript: { inlayHints: { parameterNames: { enabled: 'literals' } } },
        vtsls: { autoUseWorkspaceTsdk: true }
      },
      ...(extras.tsdkPath ? { typescript: { tsdk: extras.tsdkPath } } : {})
    }
  }
  return {
    settings: {
      java: {
        configuration: {
          updateBuildConfiguration: 'automatic',
          runtimes: (extras.javaRuntimes ?? []).map((r, i) => ({
            name: r.name,
            path: r.path,
            default: i === 0
          }))
        },
        autobuild: { enabled: true },
        maxConcurrentBuilds: 1,
        errors: { incompleteClasspath: { severity: 'warning' } },
        inlayHints: { parameterNames: { enabled: 'literals' } },
        format: { enabled: true },
        signatureHelp: { enabled: true },
        completion: {
          enabled: true,
          // jdt.ls caps at 50 items in rough alphabetical order — the
          // direct cause of irrelevant lists. 0 lifts the cap so the
          // relevance ranking (sortText) decides.
          maxResults: 0,
          // IDEA-defining candidates: postfix templates (".var", ".if"),
          // chained suggestions, favorite statics offered unqualified.
          postfix: { enabled: true },
          chain: { enabled: true },
          guessMethodArguments: 'off',
          matchCase: 'off',
          favoriteStaticMembers: [
            'org.junit.Assert.*',
            'org.junit.Assume.*',
            'org.junit.jupiter.api.Assertions.*',
            'org.junit.jupiter.api.Assumptions.*',
            'org.mockito.Mockito.*',
            'org.mockito.ArgumentMatchers.*',
            'java.util.Objects.requireNonNull',
            'java.util.Objects.requireNonNullElse'
          ]
        },
        maven: { downloadSources: false },
        references: { includeDecompiledSources: true }
      }
    },
    extendedClientCapabilities: { classFileContentsSupport: false }
  }
}

/** Idempotent per (project, kind[, engine]); null when the pool says error
 *  (or, for the IntelliJ engine, when its EULA is still unaccepted). */
export function ensureConnection(
  project: ProjectMeta,
  kind: LangKind,
  engine: 'standard' | 'idea' = 'standard'
): Promise<LspConnection | null> {
  const key = engine === 'idea' ? `${project.id}:idea` : `${project.id}:${kind}`
  let p = conns.get(key)
  if (!p) {
    p = (async () => {
      try {
        const res = await client.request<{
          serverId: string
          wsPath: string
          status: string
          error?: string
          tsdkPath?: string
          javaRuntimes?: { name: string; path: string }[]
          eulaHash?: string
          defaultSdk?: string
          buildTool?: string
        }>('lsp.ensure', { projectId: project.id, lang: engine === 'idea' ? 'idea' : kind })
        if (res.status === 'error' || res.status === 'needs-eula') return null
        const conn = new LspConnection(
          project,
          kind,
          res.serverId,
          res.wsPath,
          settingsFor(kind, res, engine, monaco.Uri.file(project.cwd).toString()),
          engine
        )
        await conn.connect()
        if (engine === 'idea') settledIdea.set(project.id, conn)
        else if (kind === 'java') settledStd.set(project.id, conn)
        return conn
      } catch {
        return null
      }
    })()
    conns.set(key, p)
    // An errored ensure must not poison the key forever.
    void p.then((conn) => {
      if (!conn) conns.delete(key)
    })
  }
  return p
}

// ── the IntelliJ engine race (docs/PLAN-4.md M15) ────────────────────
// jdtls is always in flight; IDEA is only ever a better answer that
// arrives in time. Health: 2 consecutive timeouts/errors park the race
// (zero per-keystroke overhead); a 10 s probe with 2 consecutive hits
// restores it. Legit empty lists fall back but are not health strikes.

const IDEA_BUDGET_MS = 300
const settledIdea = new Map<string, LspConnection>()
/** Resolved standard java connections (marker restore + routing). */
const settledStd = new Map<string, LspConnection>()
const ideaHealth = new Map<string, { misses: number; hits: number; lastProbe: number }>()

function ideaEligible(projectId: string): boolean {
  const h = ideaHealth.get(projectId)
  if (!h || h.misses < 2) return true
  return Date.now() - h.lastProbe > 10_000
}

function recordIdea(projectId: string, ok: boolean): void {
  const h = ideaHealth.get(projectId) ?? { misses: 0, hits: 0, lastProbe: 0 }
  h.lastProbe = Date.now()
  if (ok) {
    h.hits++
    if (h.misses >= 2 && h.hits >= 2)
      h.misses = 0 // recovered
    else if (h.misses < 2) h.misses = 0
  } else {
    h.misses++
    h.hits = 0
  }
  ideaHealth.set(projectId, h)
}

/** Called by EditorSurface when a file surface mounts. */
export function ensureForModel(project: ProjectMeta, model: monaco.editor.ITextModel): void {
  const kind = kindForLanguage(model.getLanguageId())
  if (kind) void ensureConnection(project, kind).then((conn) => conn?.maybeOpen(model))
  // Warm-ahead: the IntelliJ engine starts importing the moment a Java or
  // Kotlin surface mounts (kotlin's only server — docs/PLAN-4.md M19).
  if (IDEA_LANGS.has(model.getLanguageId())) {
    void ensureConnection(project, 'java', 'idea').then((conn) => conn?.maybeOpen(model))
  }
}

/** Connection that owns a model, if one is up. */
async function connFor(model: monaco.editor.ITextModel): Promise<LspConnection | null> {
  const entry = entryForUri(model.uri)
  const kind = kindForLanguage(model.getLanguageId())
  if (!entry || !kind) return null
  const project = useApp.getState().projects.find((p) => p.id === entry.projectId)
  if (!project) return null
  const conn = await ensureConnection(project, kind)
  conn?.maybeOpen(model)
  return conn
}

const docId = (model: monaco.editor.ITextModel): { uri: string } => ({
  uri: model.uri.toString()
})

/** Read-side routing (docs/PLAN-4.md M17): the IntelliJ engine answers
 *  when alive, eligible, and capable; jdtls fills on miss or timeout.
 *  Web models never detour — their standard connection is the only one. */
/** The alive-and-eligible IntelliJ connection for a model, if any. */
function ideaFor(model: monaco.editor.ITextModel): LspConnection | null {
  if (!IDEA_LANGS.has(model.getLanguageId())) return null
  const entry = entryForUri(model.uri)
  if (!entry) return null
  const ij = settledIdea.get(entry.projectId)
  return ij?.alive && ideaEligible(entry.projectId) ? ij : null
}

async function readSide<T>(
  model: monaco.editor.ITextModel,
  cap: string,
  method: string,
  params: unknown,
  budgetMs = 800
): Promise<T | null> {
  const std = await connFor(model)
  const ij = ideaFor(model)
  if (ij?.capabilities[cap]) {
    ij.maybeOpen(model)
    // With a standard fallback the engine gets a budget; without one
    // (kotlin) it IS the answer — wait it out.
    if (std?.capabilities[cap]) {
      const r = await Promise.race([
        ij.request<T>(method, params).catch(() => null),
        new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), budgetMs))
      ])
      if (r !== 'timeout' && r !== null) return r
    } else {
      return ij.request<T>(method, params).catch(() => null)
    }
  }
  if (!std?.capabilities[cap]) return null
  return std.request<T>(method, params).catch(() => null)
}

// ── semantic tokens (the IntelliJ look: fields purple, statics italic) ──
// The legend is provider-level, so registration waits for the first
// initialized connection of a kind and reuses its server's legend. A
// reconnect with the same legend keeps the providers; a changed legend
// (server upgrade) swaps them.

interface SemanticLegend {
  tokenTypes: string[]
  tokenModifiers: string[]
}

const LANGS_FOR_KIND: Record<LangKind, string[]> = {
  java: ['java'],
  web: ['typescript', 'tsx', 'javascript', 'jsx']
}

const semanticRegs = new Map<LangKind, { legendJson: string; disposables: monaco.IDisposable[] }>()
/** Fired on workspace/semanticTokens/refresh — monaco re-pulls tokens. */
const semanticRefresh = new Map<LangKind, monaco.Emitter<void>>()
/** Fired on workspace/inlayHint/refresh. */
const inlayRefresh = new monaco.Emitter<void>()

function maybeRegisterSemanticTokens(conn: LspConnection): void {
  const cap = conn.capabilities.semanticTokensProvider as
    { legend?: SemanticLegend; range?: boolean | object } | undefined
  if (!cap?.legend) return
  const legendJson = JSON.stringify(cap.legend)
  const prev = semanticRegs.get(conn.kind)
  if (prev?.legendJson === legendJson) return
  if (prev && LSP_DEBUG)
    console.debug(`[lsp] ${conn.kind} semantic legend changed — re-registering`)
  prev?.disposables.forEach((d) => d.dispose())
  const legend = cap.legend
  const langs = LANGS_FOR_KIND[conn.kind]
  let refresh = semanticRefresh.get(conn.kind)
  if (!refresh) {
    refresh = new monaco.Emitter<void>()
    semanticRefresh.set(conn.kind, refresh)
  }
  const disposables: monaco.IDisposable[] = [
    monaco.languages.registerDocumentSemanticTokensProvider(langs, {
      onDidChange: refresh.event,
      getLegend: () => legend,
      async provideDocumentSemanticTokens(model) {
        const c = await connFor(model)
        if (!c) return null
        const r = await c
          .request<{
            resultId?: string
            data: number[]
          } | null>('textDocument/semanticTokens/full', { textDocument: docId(model) })
          .catch(() => null)
        return r ? { data: new Uint32Array(r.data), resultId: r.resultId } : null
      },
      releaseDocumentSemanticTokens: (): void => undefined
    })
  ]
  if (cap.range) {
    disposables.push(
      monaco.languages.registerDocumentRangeSemanticTokensProvider(langs, {
        getLegend: () => legend,
        async provideDocumentRangeSemanticTokens(model, range) {
          const c = await connFor(model)
          if (!c) return null
          const r = await c
            .request<{ data: number[] } | null>('textDocument/semanticTokens/range', {
              textDocument: docId(model),
              range: toLspRange(range)
            })
            .catch(() => null)
          return r ? { data: new Uint32Array(r.data) } : null
        }
      })
    )
  }
  semanticRegs.set(conn.kind, { legendJson, disposables })
}

// ── code actions (Alt+Enter) ─────────────────────────────────────────

const isCommand = (a: LspCodeAction | LspCommand): a is LspCommand =>
  typeof (a as LspCommand).command === 'string'

/** Apply one code action through our own edit path (registry-consistent),
 *  never monaco's bulk-edit service. */
async function runCodeAction(
  model: monaco.editor.ITextModel,
  raw: LspCodeAction | LspCommand,
  source?: LspConnection
): Promise<void> {
  const conn = source?.alive ? source : ((await connFor(model)) ?? ideaFor(model))
  const entry = entryForUri(model.uri)
  const project = useApp.getState().projects.find((p) => p.id === entry?.projectId)
  if (!conn || !project) return
  let action: LspCodeAction = isCommand(raw) ? { title: raw.title, command: raw } : raw
  const resolves = (conn.capabilities.codeActionProvider as { resolveProvider?: boolean })
    ?.resolveProvider
  if (!action.edit && !action.command && resolves) {
    action =
      (await conn.request<LspCodeAction>('codeAction/resolve', action).catch(() => null)) ?? action
  }
  if (action.edit) await applyWorkspaceEdit(project, action.edit)
  const cmd = action.command
  if (!cmd) return
  if (cmd.command === 'java.apply.workspaceEdit') {
    // jdtls ships many quickfixes as this client-side command.
    for (const e of (cmd.arguments ?? []) as LspWorkspaceEdit[]) {
      await applyWorkspaceEdit(project, e)
    }
  } else {
    // The server executes and drives us via workspace/applyEdit.
    await conn
      .request('workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments ?? [] })
      .catch(() => null)
  }
}

// ── providers (registered once, route by model) ──────────────────────

const ALL_LSP_LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'java', 'kotlin']

let registered = false
export function registerProviders(): void {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider(ALL_LSP_LANGS, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<', ':', '('],
    async provideCompletionItems(model, position, context) {
      const conn = await connFor(model)
      const entry = entryForUri(model.uri)
      const pid = entry?.projectId ?? conn?.project.id ?? ''
      if (!conn && !(IDEA_LANGS.has(model.getLanguageId()) && conns.has(`${pid}:idea`))) return null
      type CompletionResult =
        { items: LspCompletionItem[]; isIncomplete?: boolean } | LspCompletionItem[] | null
      const params = {
        textDocument: docId(model),
        position: toLspPos(position),
        context: {
          triggerKind: context.triggerCharacter ? 2 : 1,
          triggerCharacter: context.triggerCharacter
        }
      }
      // jdtls is always in flight; the IntelliJ engine wins if it answers
      // inside the budget with items. Kotlin has no jdtls leg — the engine
      // answer is awaited outright (docs/PLAN-4.md M15/M19).
      const jdtlsP = conn
        ? conn.request<CompletionResult>('textDocument/completion', params).catch(() => null)
        : Promise.resolve(null)
      let result: CompletionResult = null
      let source = conn as LspConnection
      if (IDEA_LANGS.has(model.getLanguageId()) && conns.has(`${pid}:idea`) && ideaEligible(pid)) {
        const ideaP = (async (): Promise<{ r: CompletionResult } | null> => {
          const idea = await conns.get(`${pid}:idea`)
          if (!idea) return null // engine absent — no race, no strike
          idea.maybeOpen(model)
          return { r: await idea.request<CompletionResult>('textDocument/completion', params) }
        })().catch(() => ({ r: null }))
        const winner = conn
          ? await Promise.race([
              ideaP,
              new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), IDEA_BUDGET_MS))
            ])
          : await ideaP
        if (winner === 'timeout') recordIdea(pid, false)
        else if (winner !== null) {
          recordIdea(pid, winner.r !== null)
          const arr = winner.r === null ? [] : Array.isArray(winner.r) ? winner.r : winner.r.items
          // A cold engine serves postfix templates before real members —
          // a list with no substantive item must not beat jdtls's full one.
          const substantive = arr.some((i) => i.kind !== undefined && i.kind !== 15 && i.kind !== 1)
          if (arr.length > 0 && (substantive || !conn)) {
            result = winner.r
            source = settledIdea.get(pid) ?? source
          }
        }
      }
      if (!result) result = await jdtlsP
      if (!result) return null
      const items = (Array.isArray(result) ? result : result.items).filter(
        // VS-Code-era postfix leftovers: a jetbrains.*.completion.apply
        // command with nothing to insert is unusable outside VS Code.
        (i) =>
          !(
            i.command &&
            /\.completion\.apply$/.test(i.command.command) &&
            !i.textEdit &&
            !i.insertText
          )
      )
      const word = model.getWordUntilPosition(position)
      const defaultRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }
      return {
        incomplete: !Array.isArray(result) && !!result.isIncomplete,
        suggestions: items.map((item) => {
          const label = typeof item.label === 'string' ? item.label : item.label.label
          const edit = item.textEdit
          const range = edit
            ? toMonacoRange('insert' in edit && edit.insert ? edit.insert : edit.range)
            : defaultRange
          const insertText = edit?.newText ?? item.insertText ?? label
          // IDEA pops parameter info the moment a call completes. Neither
          // server can trigger it (vtsls refuses editor.* ids; jdtls wants
          // a jdt.ls-extension round-trip), so attach it client-side.
          const callLike =
            (item.kind === 2 || item.kind === 3 || item.kind === 4) && insertText.includes('(')
          const suggestion: monaco.languages.CompletionItem & { __lsp?: LspCompletionItem } = {
            label: item.labelDetails
              ? {
                  label,
                  detail: item.labelDetails.detail,
                  description: item.labelDetails.description
                }
              : label,
            kind: COMPLETION_KINDS[(item.kind ?? 1) - 1] ?? CIK.Text,
            // IDEA strikes deprecated members through — LSP tag 1.
            tags: item.tags?.includes(1)
              ? [monaco.languages.CompletionItemTag.Deprecated]
              : undefined,
            insertText,
            command: callLike
              ? { id: 'editor.action.triggerParameterHints', title: '' }
              : undefined,
            insertTextRules:
              item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            range,
            detail: item.detail,
            documentation: item.documentation
              ? { value: docString(item.documentation) }
              : undefined,
            filterText: item.filterText,
            sortText: item.sortText,
            preselect: item.preselect,
            commitCharacters: item.commitCharacters,
            additionalTextEdits: item.additionalTextEdits?.map((e) => ({
              range: toMonacoRange(e.range),
              text: e.newText
            }))
          }
          suggestion.__lsp = item
          ;(suggestion as { __conn?: LspConnection }).__conn = source
          return suggestion
        })
      }
    },
    async resolveCompletionItem(item) {
      const lsp = (item as { __lsp?: LspCompletionItem }).__lsp
      if (!lsp) return item
      // Resolve rides the connection that produced the item (race-aware);
      // the active-model lookup is the legacy fallback.
      let conn = (item as { __conn?: LspConnection }).__conn ?? null
      if (!conn) {
        const model = monaco.editor.getModels().find((m) => m.id === lastCompletionModelId)
        conn = model ? await connFor(model) : null
      }
      if (!conn) return item
      const resolved = await conn
        .request<LspCompletionItem>('completionItem/resolve', lsp)
        .catch(() => null)
      if (!resolved) return item
      return {
        ...item,
        detail: resolved.detail ?? item.detail,
        documentation: resolved.documentation
          ? { value: docString(resolved.documentation) }
          : item.documentation,
        additionalTextEdits:
          resolved.additionalTextEdits?.map((e) => ({
            range: toMonacoRange(e.range),
            text: e.newText
          })) ?? item.additionalTextEdits
      }
    }
  })

  monaco.languages.registerHoverProvider(ALL_LSP_LANGS, {
    async provideHover(model, position) {
      const hover = await readSide<{ contents: unknown; range?: LspRange }>(
        model,
        'hoverProvider',
        'textDocument/hover',
        { textDocument: docId(model), position: toLspPos(position) }
      )
      if (!hover?.contents) return null
      const parts = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
      const value = parts
        .map((part) =>
          typeof part === 'string'
            ? part
            : 'value' in (part as object)
              ? (part as { language?: string; value: string }).language
                ? `\`\`\`${(part as { language: string }).language}\n${(part as { value: string }).value}\n\`\`\``
                : (part as { value: string }).value
              : ''
        )
        .filter(Boolean)
        .join('\n\n')
      if (!value) return null
      return {
        contents: [{ value }],
        range: hover.range ? toMonacoRange(hover.range) : undefined
      }
    }
  })

  monaco.languages.registerSignatureHelpProvider(ALL_LSP_LANGS, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const help = await readSide<{
        signatures: {
          label: string
          documentation?: string | { value: string }
          parameters?: {
            label: string | [number, number]
            documentation?: string | { value: string }
          }[]
        }[]
        activeSignature?: number
        activeParameter?: number
      }>(model, 'signatureHelpProvider', 'textDocument/signatureHelp', {
        textDocument: docId(model),
        position: toLspPos(position)
      })
      if (!help?.signatures.length) return null
      return {
        value: {
          signatures: help.signatures.map((s) => ({
            label: s.label,
            documentation: s.documentation ? { value: docString(s.documentation) } : undefined,
            parameters: (s.parameters ?? []).map((p) => ({
              label: p.label,
              documentation: p.documentation ? { value: docString(p.documentation) } : undefined
            }))
          })),
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0
        },
        dispose: () => {}
      }
    }
  })

  const toLocations = async (
    model: monaco.editor.ITextModel,
    result: LspLocation | LspLocation[] | LspLocationLink[] | null
  ): Promise<monaco.languages.Location[]> => {
    if (!result) return []
    const list = Array.isArray(result) ? result : [result]
    const entry = entryForUri(model.uri)
    const project = useApp.getState().projects.find((p) => p.id === entry?.projectId)
    const locations: monaco.languages.Location[] = []
    for (const loc of list.slice(0, 50)) {
      const raw = 'targetUri' in loc ? loc.targetUri : loc.uri
      const uri = monaco.Uri.parse(raw)
      const range = toMonacoRange('targetUri' in loc ? loc.targetSelectionRange : loc.range)
      if (project) {
        if (uri.scheme === 'file') await ensurePreviewModel(project, uri)
        else await ensureDecompiledModel(project.id, raw)
      }
      locations.push({ uri, range })
    }
    return locations
  }

  monaco.languages.registerDefinitionProvider(ALL_LSP_LANGS, {
    async provideDefinition(model, position) {
      const result = await readSide<LspLocation | LspLocation[] | LspLocationLink[]>(
        model,
        'definitionProvider',
        'textDocument/definition',
        { textDocument: docId(model), position: toLspPos(position) }
      )
      return toLocations(model, result)
    }
  })

  monaco.languages.registerTypeDefinitionProvider(ALL_LSP_LANGS, {
    async provideTypeDefinition(model, position) {
      const result = await readSide<LspLocation | LspLocation[] | LspLocationLink[]>(
        model,
        'typeDefinitionProvider',
        'textDocument/typeDefinition',
        { textDocument: docId(model), position: toLspPos(position) }
      )
      return toLocations(model, result)
    }
  })

  monaco.languages.registerImplementationProvider(ALL_LSP_LANGS, {
    async provideImplementation(model, position) {
      const result = await readSide<LspLocation | LspLocation[] | LspLocationLink[]>(
        model,
        'implementationProvider',
        'textDocument/implementation',
        { textDocument: docId(model), position: toLspPos(position) }
      )
      return toLocations(model, result)
    }
  })

  monaco.languages.registerReferenceProvider(ALL_LSP_LANGS, {
    async provideReferences(model, position) {
      const result = await readSide<LspLocation[]>(
        model,
        'referencesProvider',
        'textDocument/references',
        {
          textDocument: docId(model),
          position: toLspPos(position),
          context: { includeDeclaration: true }
        }
      )
      return toLocations(model, result)
    }
  })

  monaco.languages.registerRenameProvider(ALL_LSP_LANGS, {
    async provideRenameEdits(model, position, newName) {
      const edit = await readSide<LspWorkspaceEdit>(
        model,
        'renameProvider',
        'textDocument/rename',
        { textDocument: docId(model), position: toLspPos(position), newName },
        3000 // renames search the workspace — a fair budget, still bounded
      )
      if (!edit) return null
      // Pre-open touched files so monaco's bulk edit can apply everything
      // (open models autosave; nothing needs a second write path here).
      const uris = new Set<string>()
      if (edit.changes) for (const uri of Object.keys(edit.changes)) uris.add(uri)
      if (edit.documentChanges)
        for (const c of edit.documentChanges) if ('textDocument' in c) uris.add(c.textDocument.uri)
      const entry = entryForUri(model.uri)
      const project = useApp.getState().projects.find((p) => p.id === entry?.projectId)
      if (project) {
        for (const uri of uris) await ensurePreviewModel(project, monaco.Uri.parse(uri))
      }
      const edits: monaco.languages.IWorkspaceTextEdit[] = []
      const push = (uri: string, list: LspTextEdit[]): void => {
        for (const e of list) {
          edits.push({
            resource: monaco.Uri.parse(uri),
            textEdit: { range: toMonacoRange(e.range), text: e.newText },
            versionId: undefined
          })
        }
      }
      if (edit.changes) for (const [uri, list] of Object.entries(edit.changes)) push(uri, list)
      if (edit.documentChanges)
        for (const c of edit.documentChanges)
          if ('textDocument' in c) push(c.textDocument.uri, c.edits)
      return { edits }
    }
  })

  monaco.languages.registerDocumentSymbolProvider(ALL_LSP_LANGS, {
    async provideDocumentSymbols(model) {
      const symbols = await readSide<LspSymbol[]>(
        model,
        'documentSymbolProvider',
        'textDocument/documentSymbol',
        { textDocument: docId(model) }
      )
      if (!symbols) return null
      const convert = (s: LspSymbol): monaco.languages.DocumentSymbol => {
        const range = s.range ?? s.location?.range
        const selection = s.selectionRange ?? range
        return {
          name: s.name,
          detail: '',
          kind: SYMBOL_KINDS[s.kind - 1] ?? SK.Variable,
          tags: [],
          range: range ? (toMonacoRange(range) as monaco.Range) : new monaco.Range(1, 1, 1, 1),
          selectionRange: selection
            ? (toMonacoRange(selection) as monaco.Range)
            : new monaco.Range(1, 1, 1, 1),
          children: s.children?.map(convert)
        }
      }
      return symbols.map(convert)
    }
  })

  monaco.languages.registerDocumentFormattingEditProvider(ALL_LSP_LANGS, {
    async provideDocumentFormattingEdits(model) {
      const edits = await formattingEdits(model)
      return edits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })) ?? null
    }
  })

  const APPLY_ACTION = 'tc.lsp.applyCodeAction'
  monaco.editor.registerCommand(
    APPLY_ACTION,
    (
      _accessor,
      payload: { uri: string; action: LspCodeAction | LspCommand; source?: LspConnection }
    ) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(payload.uri))
      if (model) void runCodeAction(model, payload.action, payload.source)
    }
  )

  monaco.languages.registerCodeActionProvider(ALL_LSP_LANGS, {
    async provideCodeActions(model, range, context) {
      const conn = (await connFor(model)) ?? ideaFor(model)
      if (!conn?.capabilities.codeActionProvider) return null
      const ask = async (c: LspConnection): Promise<(LspCodeAction | LspCommand)[] | null> => {
        // Context diagnostics come from the asking connection's own cache,
        // LSP-shaped, so each server matches them to its own fixes.
        const cached = c.diagnostics.get(model.uri.toString()) ?? []
        const inRange = cached.filter((d) =>
          monaco.Range.areIntersectingOrTouching(toMonacoRange(d.range) as monaco.Range, range)
        )
        return c.request<(LspCodeAction | LspCommand)[] | null>('textDocument/codeAction', {
          textDocument: docId(model),
          range: toLspRange(range),
          context: {
            diagnostics: inRange,
            ...(context.only ? { only: [context.only] } : {}),
            triggerKind: context.trigger === 1 ? 1 : 2
          }
        })
      }
      // IDEA intentions when the engine is up (docs/PLAN-4.md M16);
      // jdtls quickfixes otherwise — never both (duplicate titles).
      let source = conn
      let result: (LspCodeAction | LspCommand)[] | null = null
      const ij = ideaFor(model)
      if (ij && ij !== conn) {
        const r = await Promise.race([
          ask(ij).catch(() => null),
          new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 800))
        ])
        if (r !== 'timeout' && r && r.length > 0) {
          result = r
          source = ij
        }
      }
      if (!result) result = await ask(conn).catch(() => null)
      return {
        actions: (result ?? []).map((a) => ({
          title: a.title,
          kind: isCommand(a) ? 'quickfix' : (a.kind ?? 'quickfix'),
          isPreferred: isCommand(a) ? undefined : a.isPreferred,
          diagnostics: [],
          command: {
            id: APPLY_ACTION,
            title: a.title,
            arguments: [{ uri: model.uri.toString(), action: a, source }]
          }
        })),
        dispose: () => {}
      }
    }
  })

  monaco.languages.registerInlayHintsProvider(ALL_LSP_LANGS, {
    onDidChangeInlayHints: inlayRefresh.event,
    async provideInlayHints(model, range) {
      const hints = await readSide<LspInlayHint[]>(
        model,
        'inlayHintProvider',
        'textDocument/inlayHint',
        { textDocument: docId(model), range: toLspRange(range) }
      )
      if (!hints) return null
      return {
        hints: hints.map((h) => ({
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          label: typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''),
          kind:
            h.kind === 1
              ? monaco.languages.InlayHintKind.Type
              : monaco.languages.InlayHintKind.Parameter,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight
        })),
        dispose: () => {}
      }
    }
  })

  monaco.languages.registerFoldingRangeProvider(ALL_LSP_LANGS, {
    async provideFoldingRanges(model) {
      const ranges = await readSide<{ startLine: number; endLine: number; kind?: string }[]>(
        model,
        'foldingRangeProvider',
        'textDocument/foldingRange',
        { textDocument: docId(model) }
      )
      // null → monaco falls back to indentation folding.
      return (
        ranges?.map((r) => ({
          start: r.startLine + 1,
          end: r.endLine + 1,
          kind:
            r.kind === 'imports'
              ? monaco.languages.FoldingRangeKind.Imports
              : r.kind === 'comment'
                ? monaco.languages.FoldingRangeKind.Comment
                : undefined
        })) ?? null
      )
    }
  })

  monaco.languages.registerDocumentHighlightProvider(ALL_LSP_LANGS, {
    async provideDocumentHighlights(model, position) {
      const list = await readSide<{ range: LspRange; kind?: number }[]>(
        model,
        'documentHighlightProvider',
        'textDocument/documentHighlight',
        { textDocument: docId(model), position: toLspPos(position) }
      )
      if (!list) return null
      const DHK = monaco.languages.DocumentHighlightKind
      const KINDS = [DHK.Text, DHK.Text, DHK.Read, DHK.Write]
      return list.map((h) => ({
        range: toMonacoRange(h.range) as monaco.Range,
        kind: KINDS[h.kind ?? 1]
      }))
    }
  })

  // Cross-file navigation opens a file surface (registered opener wins
  // over monaco's default no-op for unknown resources).
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      // Decompiled targets have no file surface — show them in the peek
      // widget over the source editor instead (docs/PLAN-4.md M18).
      if (resource.scheme !== 'file') {
        if (monaco.editor.getModel(resource)) {
          source.trigger('tc', 'editor.action.peekDefinition', null)
          return true
        }
        return false
      }
      const state = useApp.getState()
      const project = state.projects.find((p) => {
        const root = p.cwd.endsWith('/') ? p.cwd : `${p.cwd}/`
        return resource.scheme === 'file' && resource.path.startsWith(root)
      })
      if (!project) return false
      const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
      const rel = resource.path.slice(root.length)
      const reveal = monaco.Range.isIRange(selectionOrPosition)
        ? {
            lineNumber: selectionOrPosition.startLineNumber,
            column: selectionOrPosition.startColumn
          }
        : (selectionOrPosition ?? undefined)
      state.openFileSurface(project.id, rel, reveal ?? null)
      return true
    }
  })

  registerGhostText()
}

/** The last model a completion list was produced for (resolve routing). */
let lastCompletionModelId = ''
monaco.editor.onDidCreateEditor((editor) => {
  editor.onDidChangeModel(() => {
    lastCompletionModelId = editor.getModel()?.id ?? lastCompletionModelId
  })
  editor.onDidFocusEditorText(() => {
    lastCompletionModelId = editor.getModel()?.id ?? lastCompletionModelId
  })
})

async function formattingEdits(model: monaco.editor.ITextModel): Promise<LspTextEdit[] | null> {
  // Routed: the IntelliJ engine formats with the project's IDEA code style.
  return readSide<LspTextEdit[]>(model, 'documentFormattingProvider', 'textDocument/formatting', {
    textDocument: docId(model),
    options: { tabSize: 2, insertSpaces: true }
  })
}

// File renames route through the IntelliJ engine first (M17): the
// workspace/willRenameFiles edit updates imports before the fs.rename.
registerWillRename(async (projectId, fromRel, toRel) => {
  const project = useApp.getState().projects.find((p) => p.id === projectId)
  const ij = settledIdea.get(projectId)
  if (!project || !ij?.alive) return
  const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
  const files = [
    {
      oldUri: monaco.Uri.file(root + fromRel).toString(),
      newUri: monaco.Uri.file(root + toRel).toString()
    }
  ]
  const edit = await Promise.race([
    ij.request<LspWorkspaceEdit | null>('workspace/willRenameFiles', { files }).catch(() => null),
    new Promise<null>((res) => setTimeout(() => res(null), 1500))
  ])
  if (edit) await applyWorkspaceEdit(project, edit)
})

// Format-on-save (M14): the registry calls this pre-flush when enabled.
registerSaveHook(async (model) => {
  const edits = await formattingEdits(model)
  if (!edits?.length) return
  model.pushEditOperations(
    [],
    edits.map((e) => ({ range: toMonacoRange(e.range) as monaco.Range, text: e.newText })),
    () => null
  )
})

// ── workspace symbols (⌘T) ───────────────────────────────────────────

export interface WorkspaceSymbolRow {
  name: string
  kind: monaco.languages.SymbolKind
  containerName: string
  uri: string
  range: monaco.IRange
}

export async function workspaceSymbols(
  project: ProjectMeta,
  query: string
): Promise<WorkspaceSymbolRow[]> {
  // The IntelliJ engine's index answers alone when it's up (JDK included,
  // IDEA ranking); otherwise every live standard connection contributes.
  const ij = settledIdea.get(project.id)
  if (ij?.alive && ideaEligible(project.id)) {
    const symbols = await ij
      .request<LspSymbol[] | null>('workspace/symbol', { query })
      .catch(() => null)
    if (symbols?.length) {
      return symbols.slice(0, 100).map((sym) => ({
        name: sym.name,
        kind: SYMBOL_KINDS[sym.kind - 1] ?? SK.Variable,
        containerName: sym.containerName ?? '',
        uri: sym.location?.uri ?? '',
        range: sym.location
          ? toMonacoRange(sym.location.range)
          : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
      }))
    }
  }
  const kinds: LangKind[] = ['web', 'java']
  const live = kinds
    .map((kind) => conns.get(`${project.id}:${kind}`))
    .filter((c) => c !== undefined) // symbols query never *starts* servers
  const results = await Promise.all(
    live.map(async (connP) => {
      const conn = await connP
      if (!conn) return []
      const symbols = await conn
        .request<LspSymbol[] | null>('workspace/symbol', { query })
        .catch(() => null)
      return (symbols ?? []).slice(0, 60).map((s) => ({
        name: s.name,
        kind: SYMBOL_KINDS[s.kind - 1] ?? SK.Variable,
        containerName: s.containerName ?? '',
        uri: s.location?.uri ?? '',
        range: s.location
          ? toMonacoRange(s.location.range)
          : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
      }))
    })
  )
  return results.flat().slice(0, 100)
}

// ── hierarchies (docs/PLAN-4.md M18): callers and super/subtypes ─────

interface HierarchyItem {
  name: string
  detail?: string
  uri: string
  selectionRange: LspRange
  range: LspRange
}

export interface HierarchyResult {
  title: string
  rows: { name: string; containerName: string; uri: string; range: monaco.IRange }[]
}

async function hierarchyConn(
  model: monaco.editor.ITextModel,
  cap: string
): Promise<LspConnection | null> {
  const ij = ideaFor(model)
  if (ij?.capabilities[cap]) return ij
  const std = await connFor(model)
  return std?.capabilities[cap] ? std : null
}

const itemRow = (item: HierarchyItem, tag: string): HierarchyResult['rows'][number] => ({
  name: item.name,
  containerName: [tag, item.detail ?? item.uri.split('/').pop() ?? ''].filter(Boolean).join(' · '),
  uri: item.uri,
  range: toMonacoRange(item.selectionRange ?? item.range)
})

/** Call hierarchy (⌃⌥H): who calls the symbol at the cursor. */
export async function callHierarchy(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): Promise<HierarchyResult | null> {
  const conn = await hierarchyConn(model, 'callHierarchyProvider')
  if (!conn) return null
  const prep = await conn
    .request<HierarchyItem[] | null>('textDocument/prepareCallHierarchy', {
      textDocument: docId(model),
      position: toLspPos(position)
    })
    .catch(() => null)
  const item = prep?.[0]
  if (!item) return null
  const incoming = await conn
    .request<{ from: HierarchyItem }[] | null>('callHierarchy/incomingCalls', { item })
    .catch(() => null)
  return {
    title: `Callers of ${item.name}`,
    rows: (incoming ?? []).map((c) => itemRow(c.from, ''))
  }
}

/** Type hierarchy (⌃H): supertypes and subtypes of the type at the cursor. */
export async function typeHierarchy(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): Promise<HierarchyResult | null> {
  const conn = await hierarchyConn(model, 'typeHierarchyProvider')
  if (!conn) return null
  const prep = await conn
    .request<HierarchyItem[] | null>('textDocument/prepareTypeHierarchy', {
      textDocument: docId(model),
      position: toLspPos(position)
    })
    .catch(() => null)
  const item = prep?.[0]
  if (!item) return null
  const [supers, subs] = await Promise.all([
    conn.request<HierarchyItem[] | null>('typeHierarchy/supertypes', { item }).catch(() => null),
    conn.request<HierarchyItem[] | null>('typeHierarchy/subtypes', { item }).catch(() => null)
  ])
  const rows = [
    ...(supers ?? []).map((t) => itemRow(t, '↑ supertype')),
    ...(subs ?? []).map((t) => itemRow(t, '↓ subtype'))
  ]
  return { title: `Type hierarchy of ${item.name}`, rows }
}

// ── AI ghost text (M14): pluggable, off by default ───────────────────

function registerGhostText(): void {
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      async provideInlineCompletions(model, position, _context, token) {
        if (!useApp.getState().ghostText) return { items: [] }
        const entry = entryForUri(model.uri)
        if (!entry) return { items: [] }
        // ≥400 ms idle: wait it out; a keystroke cancels via the token.
        await new Promise((r) => setTimeout(r, 400))
        if (token.isCancellationRequested) return { items: [] }
        const offset = model.getOffsetAt(position)
        const text = model.getValue()
        const completion = await client
          .request<string | null>('fim.complete', {
            projectId: entry.projectId,
            path: entry.relPath,
            prefix: text.slice(0, offset),
            suffix: text.slice(offset)
          })
          .catch(() => null)
        if (!completion || token.isCancellationRequested) return { items: [] }
        return {
          items: [
            {
              insertText: completion,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column
              )
            }
          ]
        }
      },
      disposeInlineCompletions: (): void => undefined
    }
  )
}
