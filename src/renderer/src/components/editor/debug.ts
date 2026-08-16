import type { ProjectMeta } from '@shared/domain'
import { client } from '../../lib/client'
import { useApp, type DebugFrame, type DebugVariable } from '../../state/store'
import { monaco } from './monaco'
import { ensureConnection } from './lsp'

/**
 * The debugger (docs/PLAN-4.md M20): IDEA's XDebugger behind the engine's
 * DAP endpoint. `start_debug_server` yields a TCP port; main bridges it
 * to a WS tunnel; this module is the DAP client plus the glue between
 * breakpoints, the store (Debug rail panel), and editor decorations.
 *
 * One session at a time — a second launch stops the first, like IDEA's
 * default single-run-config behavior.
 */

interface DapMessage {
  type: 'response' | 'event' | 'request'
  seq: number
  request_seq?: number
  success?: boolean
  message?: string
  command?: string
  event?: string
  body?: unknown
}

class DapSession {
  private ws: WebSocket | null = null
  private seq = 1
  private pending = new Map<number, (m: DapMessage) => void>()
  onEvent: (event: string, body: unknown) => void = () => {}

  async connect(wsPath: string): Promise<void> {
    const port = await window.api.getServerPort()
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.onopen = (): void => resolve()
      ws.onerror = (): void => reject(new Error('debug tunnel failed to open'))
    })
    ws.onmessage = (e): void => {
      let msg: DapMessage
      try {
        msg = JSON.parse(String(e.data)) as DapMessage
      } catch {
        return
      }
      if (msg.type === 'response' && msg.request_seq !== undefined) {
        this.pending.get(msg.request_seq)?.(msg)
        this.pending.delete(msg.request_seq)
      } else if (msg.type === 'event' && msg.event) {
        this.onEvent(msg.event, msg.body)
      }
    }
    ws.onclose = (): void => this.onEvent('__closed', null)
  }

  request<T = unknown>(command: string, args?: unknown, timeoutMs = 15_000): Promise<T | null> {
    const seq = this.seq++
    return new Promise<T | null>((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(seq)
        resolve(null)
      }, timeoutMs)
      this.pending.set(seq, (m) => {
        clearTimeout(t)
        resolve(m.success ? ((m.body ?? {}) as T) : null)
      })
      this.ws?.send(JSON.stringify({ seq, type: 'request', command, arguments: args }))
    })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}

// ── breakpoints (persisted per project) ──────────────────────────────

const BP_KEY = 'debug-breakpoints'
const breakpoints = new Map<string, Set<number>>(
  Object.entries(JSON.parse(localStorage.getItem(BP_KEY) ?? '{}') as Record<string, number[]>).map(
    ([k, lines]) => [k, new Set(lines)]
  )
)

const bpKey = (projectId: string, path: string): string => `${projectId}:${path}`

function persistBreakpoints(): void {
  localStorage.setItem(
    BP_KEY,
    JSON.stringify(Object.fromEntries([...breakpoints].map(([k, v]) => [k, [...v]])))
  )
  useApp.setState({
    debugBreakpoints: Object.fromEntries(
      [...breakpoints].map(([k, v]) => [k, [...v].sort((a, b) => a - b)])
    )
  })
}

export function breakpointLines(projectId: string, path: string): number[] {
  return [...(breakpoints.get(bpKey(projectId, path)) ?? [])]
}

export function toggleBreakpoint(project: ProjectMeta, path: string, line: number): void {
  const key = bpKey(project.id, path)
  const set = breakpoints.get(key) ?? new Set<number>()
  if (set.has(line)) set.delete(line)
  else set.add(line)
  if (set.size) breakpoints.set(key, set)
  else breakpoints.delete(key)
  persistBreakpoints()
  // A live session re-syncs the file's breakpoints immediately.
  if (active?.project.id === project.id) void active.syncBreakpoints(path)
}

// ── the controller ───────────────────────────────────────────────────

const set = useApp.setState.bind(useApp)

class DebugController {
  session: DapSession | null = null
  private threadId: number | null = null

  constructor(
    readonly project: ProjectMeta,
    readonly mainClass: string,
    readonly filePath: string
  ) {}

  private out(line: string): void {
    const { debugOutput } = useApp.getState()
    set({ debugOutput: [...debugOutput.slice(-500), line] })
  }

  async start(): Promise<void> {
    set({
      debugPhase: 'launching',
      debugOutput: [],
      debugFrames: [],
      debugVariables: [],
      debugCurrent: null,
      debugError: null
    })
    const conn = await ensureConnection(this.project, 'java', 'idea')
    if (!conn?.alive) {
      this.fail('the IntelliJ engine is not running (it powers the debugger)')
      return
    }
    const exec = <T>(command: string, args: unknown[]): Promise<T | null> =>
      conn.request<T>('workspace/executeCommand', { command, arguments: args }).catch(() => null)
    const fileUri = monaco.Uri.file(
      `${this.project.cwd.endsWith('/') ? this.project.cwd : `${this.project.cwd}/`}${this.filePath}`
    ).toString()
    const [cp, jx, wd, port] = await Promise.all([
      exec<{ classpath?: string[] }>('intellij.java.resolveClasspath', [{ uri: fileUri }]),
      exec<{ javaExec?: string }>('intellij.java.resolveJavaExecutable', [{ uri: fileUri }]),
      exec<{ workingDirectory?: string }>('intellij.java.resolveWorkingDirectory', [
        { uri: fileUri }
      ]),
      exec<number>('start_debug_server', [])
    ])
    if (typeof port !== 'number' || !jx?.javaExec) {
      this.fail('the engine could not resolve a launch (build the project once?)')
      return
    }
    const { wsPath } = await client.request<{ wsPath: string }>('dap.connect', { port })
    const session = new DapSession()
    this.session = session
    session.onEvent = (event, body) => this.onEvent(event, body)
    await session.connect(wsPath)
    await session.request('initialize', {
      adapterID: 'intellij_debugger',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true
    })
    const launched = await session.request<unknown>(
      'launch',
      {
        type: 'intellij_debugger',
        request: 'launch',
        mainClass: this.mainClass,
        javaExec: jx.javaExec,
        classPaths: cp?.classpath ?? [],
        cwd: wd?.workingDirectory ?? this.project.cwd
      },
      30_000
    )
    if (launched === null) {
      this.fail('launch failed — is the project compiled?')
      return
    }
    await this.syncAllBreakpoints()
    await session.request('configurationDone', {})
    set({ debugPhase: 'running' })
  }

  private fail(message: string): void {
    set({ debugPhase: 'idle', debugError: message })
    this.dispose()
  }

  async syncAllBreakpoints(): Promise<void> {
    const prefix = `${this.project.id}:`
    for (const key of breakpoints.keys()) {
      if (key.startsWith(prefix)) await this.syncBreakpoints(key.slice(prefix.length))
    }
  }

  async syncBreakpoints(path: string): Promise<void> {
    if (!this.session) return
    const root = this.project.cwd.endsWith('/') ? this.project.cwd : `${this.project.cwd}/`
    await this.session.request('setBreakpoints', {
      source: { path: `${root}${path}` },
      breakpoints: breakpointLines(this.project.id, path).map((line) => ({ line }))
    })
  }

  private onEvent(event: string, body: unknown): void {
    if (event === 'output') {
      const text = (body as { output?: string }).output ?? ''
      for (const line of text.split('\n')) if (line.trim()) this.out(line)
    } else if (event === 'stopped') {
      const threadId = (body as { threadId?: number }).threadId ?? null
      this.threadId = threadId
      set({ debugPhase: 'stopped' })
      void this.refreshStopped()
    } else if (event === 'continued') {
      set({ debugPhase: 'running', debugFrames: [], debugVariables: [], debugCurrent: null })
      clearCurrentLine()
    } else if (event === 'terminated' || event === 'exited' || event === '__closed') {
      if (useApp.getState().debugPhase !== 'idle') {
        set({ debugPhase: 'idle', debugCurrent: null })
        this.out('— debuggee terminated —')
      }
      clearCurrentLine()
      this.dispose()
    }
  }

  private async refreshStopped(): Promise<void> {
    const s = this.session
    if (!s) return
    if (this.threadId === null) {
      const th = await s.request<{ threads?: { id: number; name: string }[] }>('threads', {})
      this.threadId = th?.threads?.[0]?.id ?? null
      if (this.threadId === null) return
    }
    const st = await s.request<{
      stackFrames?: { id: number; name: string; line: number; source?: { path?: string } }[]
    }>('stackTrace', { threadId: this.threadId, levels: 20 })
    const root = this.project.cwd.endsWith('/') ? this.project.cwd : `${this.project.cwd}/`
    const frames: DebugFrame[] = (st?.stackFrames ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      line: f.line,
      path: f.source?.path?.startsWith(root) ? f.source.path.slice(root.length) : null
    }))
    set({ debugFrames: frames })
    const top = frames[0]
    if (top?.path) {
      set({ debugCurrent: { path: top.path, line: top.line } })
      useApp.getState().openFileSurface(this.project.id, top.path, {
        lineNumber: top.line,
        column: 1
      })
      markCurrentLine(this.project, top.path, top.line)
    }
    if (top) await this.loadVariables(top.id)
  }

  async loadVariables(frameId: number, ref?: number, depth = 0): Promise<void> {
    const s = this.session
    if (!s) return
    let variablesReference = ref
    if (variablesReference === undefined) {
      const sc = await s.request<{ scopes?: { variablesReference: number }[] }>('scopes', {
        frameId
      })
      variablesReference = sc?.scopes?.[0]?.variablesReference
      if (variablesReference === undefined) return
      set({ debugVariables: [] })
    }
    const vars = await s.request<{
      variables?: { name: string; value: string; variablesReference: number }[]
    }>('variables', { variablesReference })
    const rows: DebugVariable[] = (vars?.variables ?? [])
      .filter((v) => v.name.trim().length > 0)
      .map((v) => ({
        name: v.name,
        value: v.value,
        ref: v.variablesReference || null,
        depth,
        frameId
      }))
    const existing = useApp.getState().debugVariables
    if (ref === undefined) set({ debugVariables: rows })
    else {
      // expand in place under the parent ref
      const at = existing.findIndex((v) => v.ref === ref)
      if (at >= 0)
        set({
          debugVariables: [...existing.slice(0, at + 1), ...rows, ...existing.slice(at + 1)]
        })
    }
  }

  step(kind: 'continue' | 'next' | 'stepIn' | 'stepOut'): void {
    if (this.threadId === null) return
    void this.session?.request(kind, { threadId: this.threadId })
  }

  async evaluate(expression: string): Promise<void> {
    const frameId = useApp.getState().debugFrames[0]?.id
    this.out(`> ${expression}`)
    const r = await this.session?.request<{ result?: string }>('evaluate', {
      expression,
      frameId,
      context: 'repl'
    })
    this.out(r?.result ?? '(no result)')
  }

  stop(): void {
    void this.session?.request('disconnect', { terminateDebuggee: true })
    this.dispose()
    set({ debugPhase: 'idle', debugCurrent: null })
    clearCurrentLine()
  }

  private dispose(): void {
    this.session?.close()
    this.session = null
    if (active === this) active = null
  }
}

let active: DebugController | null = null

/** Launch the given file's main class under the debugger. */
export async function debugFile(project: ProjectMeta, path: string, text: string): Promise<void> {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1]
  const cls =
    path
      .split('/')
      .pop()
      ?.replace(/\.(java|kt)$/, '') ?? ''
  const mainClass = pkg ? `${pkg}.${cls}` : cls
  active?.stop()
  active = new DebugController(project, mainClass, path)
  await active.start()
}

export const debugController = (): DebugController | null => active

// ── editor decorations (breakpoints + current line) ──────────────────

const bpDecorations = new Map<
  monaco.editor.ICodeEditor,
  monaco.editor.IEditorDecorationsCollection
>()
let currentLineDecoration: monaco.editor.IEditorDecorationsCollection | null = null

export function paintBreakpoints(
  editor: monaco.editor.ICodeEditor,
  projectId: string,
  path: string
): void {
  let coll = bpDecorations.get(editor)
  if (!coll) {
    coll = editor.createDecorationsCollection()
    bpDecorations.set(editor, coll)
    editor.onDidDispose(() => bpDecorations.delete(editor))
  }
  coll.set(
    breakpointLines(projectId, path).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: false, glyphMarginClassName: 'tc-breakpoint' }
    }))
  )
}

function markCurrentLine(project: ProjectMeta, path: string, line: number): void {
  clearCurrentLine()
  const root = project.cwd.endsWith('/') ? project.cwd : `${project.cwd}/`
  const model = monaco.editor.getModel(monaco.Uri.file(`${root}${path}`))
  const editor = monaco.editor.getEditors().find((e) => e.getModel() === model)
  if (!editor) return
  currentLineDecoration = editor.createDecorationsCollection([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'tc-debug-line' }
    }
  ])
}

function clearCurrentLine(): void {
  currentLineDecoration?.clear()
  currentLineDecoration = null
}

// initialize the store mirror once at module load
persistBreakpoints()
