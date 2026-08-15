import type { ProjectMeta } from '@shared/domain'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { monaco } from './monaco'
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
  java: 'java'
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
}
interface LspCompletionItem {
  label: string | { label: string }
  kind?: number
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
// LSP CompletionItemKind (1-based) → monaco CompletionItemKind
const CIK = monaco.languages.CompletionItemKind
const COMPLETION_KINDS: monaco.languages.CompletionItemKind[] = [
  CIK.Text,
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

  constructor(
    readonly project: ProjectMeta,
    readonly kind: LangKind,
    private serverId: string,
    private wsPath: string,
    private settings: Record<string, unknown>
  ) {}

  get rootUri(): string {
    return monaco.Uri.file(this.project.cwd).toString()
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
          publishDiagnostics: { relatedInformation: false },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              additionalTextEdits: true,
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
          formatting: {}
        },
        workspace: {
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ['create', 'rename', 'delete']
          },
          configuration: true,
          symbol: {},
          workspaceFolders: true
        },
        window: { workDoneProgress: true }
      },
      initializationOptions: this.settings
    })
    Object.assign(this.capabilities, init.capabilities)
    this.notify('initialized', {})
    const settings = (this.settings as { settings?: unknown }).settings
    if (settings) this.notify('workspace/didChangeConfiguration', { settings })
    // Sync every already-open matching model.
    for (const model of monaco.editor.getModels()) this.maybeOpen(model)
  }

  private async onClose(): Promise<void> {
    for (const p of this.pending.values()) p.reject(new Error('lsp connection closed'))
    this.pending.clear()
    this.openDocs.clear()
    for (const sub of this.modelSubs.values()) sub.dispose()
    this.modelSubs.clear()
    if (this.disposed) return
    // The pool restarted (crash policy) or evicted us. One re-ensure — the
    // pool's own crash policy bounds retries; an error there ends here too.
    this.initP = null
    try {
      const res = await client.request<{ serverId: string; wsPath: string; status: string }>(
        'lsp.ensure',
        { projectId: this.project.id, lang: this.kind }
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
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
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
      const { uri, diagnostics } = params as { uri: string; diagnostics: LspDiagnostic[] }
      const model = monaco.editor.getModel(monaco.Uri.parse(uri))
      if (!model) return
      monaco.editor.setModelMarkers(
        model,
        this.serverId,
        diagnostics.map((d) => ({
          ...toMonacoRange(d.range),
          message: d.message,
          severity: SEVERITIES[d.severity ?? 1],
          source: d.source,
          code: d.code === undefined ? undefined : String(d.code)
        }))
      )
    }
  }

  /** Does this connection own the model? (language kind + project root) */
  owns(model: monaco.editor.ITextModel): boolean {
    if (kindForLanguage(model.getLanguageId()) !== this.kind) return false
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
    this.modelSubs.set(
      uri,
      model.onDidChangeContent((e) => {
        doc.version++
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

function settingsFor(
  kind: LangKind,
  extras: { tsdkPath?: string; javaRuntimes?: { name: string; path: string }[] }
): Record<string, unknown> {
  if (kind === 'web') {
    return {
      settings: {
        typescript: {
          ...(extras.tsdkPath ? { tsdk: extras.tsdkPath } : {}),
          suggest: { completeFunctionCalls: true }
        },
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
        format: { enabled: true },
        signatureHelp: { enabled: true },
        completion: { enabled: true },
        maven: { downloadSources: false },
        references: { includeDecompiledSources: true }
      }
    },
    extendedClientCapabilities: { classFileContentsSupport: false }
  }
}

/** Idempotent per (project, kind); null when the pool says error. */
export function ensureConnection(
  project: ProjectMeta,
  kind: LangKind
): Promise<LspConnection | null> {
  const key = `${project.id}:${kind}`
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
        }>('lsp.ensure', { projectId: project.id, lang: kind })
        if (res.status === 'error') return null
        const conn = new LspConnection(
          project,
          kind,
          res.serverId,
          res.wsPath,
          settingsFor(kind, res)
        )
        await conn.connect()
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

/** Called by EditorSurface when a file surface mounts. */
export function ensureForModel(project: ProjectMeta, model: monaco.editor.ITextModel): void {
  const kind = kindForLanguage(model.getLanguageId())
  if (!kind) return
  void ensureConnection(project, kind).then((conn) => conn?.maybeOpen(model))
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

// ── providers (registered once, route by model) ──────────────────────

const ALL_LSP_LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'java']

let registered = false
export function registerProviders(): void {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider(ALL_LSP_LANGS, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<', ':', '('],
    async provideCompletionItems(model, position, context) {
      const conn = await connFor(model)
      if (!conn) return null
      const result = await conn
        .request<
          { items: LspCompletionItem[]; isIncomplete?: boolean } | LspCompletionItem[] | null
        >('textDocument/completion', {
          textDocument: docId(model),
          position: toLspPos(position),
          context: {
            triggerKind: context.triggerCharacter ? 2 : 1,
            triggerCharacter: context.triggerCharacter
          }
        })
        .catch(() => null)
      if (!result) return null
      const items = Array.isArray(result) ? result : result.items
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
          const suggestion: monaco.languages.CompletionItem & { __lsp?: LspCompletionItem } = {
            label,
            kind: COMPLETION_KINDS[(item.kind ?? 1) - 1] ?? CIK.Text,
            insertText: edit?.newText ?? item.insertText ?? label,
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
          return suggestion
        })
      }
    },
    async resolveCompletionItem(item) {
      const lsp = (item as { __lsp?: LspCompletionItem }).__lsp
      if (!lsp) return item
      // Resolve rides the connection that produced the list; find it by the
      // active editor's model (resolve always follows a provide).
      const model = monaco.editor.getModels().find((m) => m.id === lastCompletionModelId)
      if (!model) return item
      const conn = await connFor(model)
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
      const conn = await connFor(model)
      if (!conn) return null
      const hover = await conn
        .request<{ contents: unknown; range?: LspRange } | null>('textDocument/hover', {
          textDocument: docId(model),
          position: toLspPos(position)
        })
        .catch(() => null)
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
      const conn = await connFor(model)
      if (!conn) return null
      const help = await conn
        .request<{
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
        } | null>('textDocument/signatureHelp', {
          textDocument: docId(model),
          position: toLspPos(position)
        })
        .catch(() => null)
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
      const uri = monaco.Uri.parse('targetUri' in loc ? loc.targetUri : loc.uri)
      const range = toMonacoRange('targetUri' in loc ? loc.targetSelectionRange : loc.range)
      if (project) await ensurePreviewModel(project, uri)
      locations.push({ uri, range })
    }
    return locations
  }

  monaco.languages.registerDefinitionProvider(ALL_LSP_LANGS, {
    async provideDefinition(model, position) {
      const conn = await connFor(model)
      if (!conn) return null
      const result = await conn
        .request<LspLocation | LspLocation[] | LspLocationLink[] | null>(
          'textDocument/definition',
          { textDocument: docId(model), position: toLspPos(position) }
        )
        .catch(() => null)
      return toLocations(model, result)
    }
  })

  monaco.languages.registerReferenceProvider(ALL_LSP_LANGS, {
    async provideReferences(model, position) {
      const conn = await connFor(model)
      if (!conn) return null
      const result = await conn
        .request<LspLocation[] | null>('textDocument/references', {
          textDocument: docId(model),
          position: toLspPos(position),
          context: { includeDeclaration: true }
        })
        .catch(() => null)
      return toLocations(model, result)
    }
  })

  monaco.languages.registerRenameProvider(ALL_LSP_LANGS, {
    async provideRenameEdits(model, position, newName) {
      const conn = await connFor(model)
      if (!conn) return null
      const edit = await conn
        .request<LspWorkspaceEdit | null>('textDocument/rename', {
          textDocument: docId(model),
          position: toLspPos(position),
          newName
        })
        .catch(() => null)
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
      const conn = await connFor(model)
      if (!conn) return null
      const symbols = await conn
        .request<LspSymbol[] | null>('textDocument/documentSymbol', { textDocument: docId(model) })
        .catch(() => null)
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

  // Cross-file navigation opens a file surface (registered opener wins
  // over monaco's default no-op for unknown resources).
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
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
  const conn = await connFor(model)
  if (!conn) return null
  if (!conn.capabilities.documentFormattingProvider) return null
  return conn
    .request<LspTextEdit[] | null>('textDocument/formatting', {
      textDocument: docId(model),
      options: { tabSize: 2, insertSpaces: true }
    })
    .catch(() => null)
}

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
