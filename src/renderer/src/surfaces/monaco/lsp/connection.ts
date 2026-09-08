import type { ProjectMeta } from "../../../lib/tcserver/types";
import { client } from "../../../lib/tcserver/client";
import { workspaceStore } from "../../../lib/tcserver/workspaces";
import { registerBlockedRetry } from "../../../lib/monaco/lspGate";
import { dirPrefix } from "../../../lib/tcserver/projects";
import { setEditorState, getEditorState } from "../../../lib/monaco/editorState";
import { monaco } from "../monaco";
import { onModelSaved } from "../models";
import { applyWorkspaceEdit } from "./edits";
import { settingsFor, type EnsureExtras } from "./settings";
import {
  IDEA_LANGS,
  kindForLanguage,
  LSP_LANGUAGE,
  toMarkers,
  type Engine,
  type LangKind,
  type LspDiagnostic,
  type LspWorkspaceEdit,
} from "./types";

/**
 * The LSP client. The pool lives in the sidecar; this side speaks raw
 * JSON-RPC over `/lsp/<serverId>`, one WS text frame per message, and
 * surfaces the protocol through Monaco's provider APIs (providers.ts).
 * Hand-rolled on purpose: Monaco 0.56's bundled client pins rootUri to
 * null and syncs every model to every server, neither of which survives
 * contact with jdtls or a multi-project pool.
 *
 * One connection per (project, kind[, engine]). LSP stays an enhancement:
 * no connection, a provider returns nothing, the editor keeps working.
 */

const LSP_DEBUG = import.meta.env.DEV;

export interface EnsureResult extends EnsureExtras {
  serverId: string;
  wsPath: string;
  /** the pool's server state, or the IntelliJ EULA gate */
  status: "starting" | "downloading" | "running" | "error" | "needs-eula";
  error?: string;
}

/** Which files the IntelliJ engine currently owns squiggles for, and which
 *  projects have proven the engine warm (first non-empty pull). */
const ideaDiagUris = new Set<string>();
const ideaDiagTrusted = new Set<string>();

/** Resolved connections by role. */
export const settledIdea = new Map<string, LspConnection>();
export const settledStd = new Map<string, LspConnection>();
export const conns = new Map<string, Promise<LspConnection | null>>();

/** Fired once a connection finished `initialize` (providers register
 *  semantic tokens against the server's legend here). */
export const connectionInitialized = new monaco.Emitter<LspConnection>();
/** Fired on workspace/semanticTokens/refresh, per kind. */
export const semanticRefresh = new Map<LangKind, monaco.Emitter<void>>();
/** Fired on workspace/inlayHint/refresh. */
export const inlayRefresh = new monaco.Emitter<void>();

/** The engine dropped: clear its squiggles on every model it owned (Kotlin
 *  has no other server, so its markers must not outlive the engine) and
 *  put jdtls's cached diagnostics back where jdtls owns the model. */
function restoreJdtlsMarkers(projectId: string): void {
  const std = settledStd.get(projectId);
  const project = workspaceStore.projects.find((p) => p.id === projectId);
  const prefix = project ? dirPrefix(project.cwd) : null;
  for (const uri of [...ideaDiagUris]) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) {
      ideaDiagUris.delete(uri);
      continue;
    }
    if (prefix && !model.uri.path.startsWith(prefix)) continue;
    ideaDiagUris.delete(uri);
    monaco.editor.setModelMarkers(model, `lsp-idea-${projectId}`, []);
    if (!std?.owns(model)) continue;
    const cached = std.diagnostics.get(uri);
    if (cached) monaco.editor.setModelMarkers(model, `lsp-java-${projectId}`, toMarkers(cached));
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class LspConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private openDocs = new Map<string, { model: monaco.editor.ITextModel; version: number }>();
  private modelSubs = new Map<string, monaco.IDisposable>();
  private disposed = false;
  private initP: Promise<void> | null = null;
  private everReady = false;
  readonly capabilities: Record<string, unknown> = {};
  /** Last published diagnostics per URI (LSP-shaped, feeds codeAction context). */
  readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private progress = new Map<string | number, string>();
  private changedAt = new Map<string, number>();
  private pullTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly project: ProjectMeta,
    readonly kind: LangKind,
    public serverId: string,
    private wsPath: string,
    private settings: Record<string, unknown>,
    /** 'idea' = the IntelliJ engine: same java models, push diagnostics
     *  ignored (pulled instead), no semantic registration. */
    readonly engine: Engine = "standard",
  ) {}

  get rootUri(): string {
    return monaco.Uri.file(this.project.cwd).toString();
  }

  get root(): string {
    return dirPrefix(this.project.cwd);
  }

  get alive(): boolean {
    return !this.disposed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Stable across server restarts: a new generation clears the old one's markers. */
  private get markerOwner(): string {
    return `lsp-${this.engine === "idea" ? "idea" : this.kind}-${this.project.id}`;
  }

  async connect(): Promise<void> {
    this.initP ??= this.doConnect();
    return this.initP;
  }

  private async doConnect(): Promise<void> {
    const port = client.port;
    if (!port) throw new Error("sidecar not connected");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${this.wsPath}`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("lsp tunnel failed to open"));
    });
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = (e) => void this.onClose(e.code);
    const init = await this.request<{ capabilities: Record<string, unknown> }>("initialize", {
      processId: null,
      clientInfo: { name: "monocode" },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: this.project.name }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              labelDetailsSupport: true,
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
            contextSupport: true,
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: { documentationFormat: ["markdown", "plaintext"] },
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
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll",
                ],
              },
            },
            isPreferredSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ["edit"] },
          },
          semanticTokens: {
            requests: { full: true, range: true },
            formats: ["relative"],
            tokenTypes: [
              "namespace", "type", "class", "enum", "interface", "struct",
              "typeParameter", "parameter", "variable", "property", "enumMember",
              "event", "function", "method", "macro", "keyword", "modifier",
              "comment", "string", "number", "regexp", "operator", "decorator",
            ],
            tokenModifiers: [
              "declaration", "definition", "readonly", "static", "deprecated",
              "abstract", "async", "modification", "documentation", "defaultLibrary",
            ],
            multilineTokenSupport: false,
            overlappingTokenSupport: false,
          },
        },
        workspace: {
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
          configuration: true,
          symbol: {},
          workspaceFolders: true,
          executeCommand: {},
          // jdtls and vtsls register willRenameFiles only for clients that say so.
          fileOperations: { dynamicRegistration: true, willRename: true, didRename: true },
        },
        window: { workDoneProgress: true },
      },
      initializationOptions: this.settings,
    });
    Object.assign(this.capabilities, init.capabilities);
    monaco.editor.removeAllMarkers(this.markerOwner);
    this.notify("initialized", {});
    const settings = (this.settings as { settings?: unknown }).settings;
    if (settings) this.notify("workspace/didChangeConfiguration", { settings });
    this.everReady = true;
    connectionInitialized.fire(this);
    // Sync every already-open matching model.
    for (const model of monaco.editor.getModels()) this.maybeOpen(model);
  }

  private setBusy(text: string | null): void {
    const { lspBusy } = getEditorState();
    if ((lspBusy[this.project.id] ?? null) === text) return;
    setEditorState({ lspBusy: { ...lspBusy, [this.project.id]: text } });
  }

  private async onClose(code?: number): Promise<void> {
    for (const p of this.pending.values()) p.reject(new Error("lsp connection closed"));
    this.pending.clear();
    this.openDocs.clear();
    for (const sub of this.modelSubs.values()) sub.dispose();
    this.modelSubs.clear();
    this.diagnostics.clear();
    this.progress.clear();
    this.changedAt.clear();
    this.setBusy(null);
    if (this.engine === "idea") restoreJdtlsMarkers(this.project.id);
    if (this.disposed) return;
    // 4001 = LRU eviction: another project needed the engine slot.
    // Reconnecting would evict that project and ping-pong 3 GB JVM boots.
    // Stay down; re-focusing this project boots fresh.
    if (this.engine === "idea" && code === 4001) {
      this.disposed = true;
      conns.delete(`${this.project.id}:idea`);
      if (settledIdea.get(this.project.id) === this) settledIdea.delete(this.project.id);
      return;
    }
    // A server that died before answering initialize dies the same way on
    // the pool's respawn; re-ensuring here would boot a JVM per second.
    if (code === 4002 && !this.everReady) {
      this.disposed = true;
      const key = this.engine === "idea" ? `${this.project.id}:idea` : `${this.project.id}:${this.kind}`;
      conns.delete(key);
      if (settledIdea.get(this.project.id) === this) settledIdea.delete(this.project.id);
      if (settledStd.get(this.project.id) === this) settledStd.delete(this.project.id);
      return;
    }
    // The pool restarted (crash policy) or evicted us. One re-ensure; the
    // pool's own crash policy bounds retries.
    this.initP = null;
    try {
      const res = await client.request<EnsureResult>("lsp.ensure", {
        projectId: this.project.id,
        lang: this.engine === "idea" ? "idea" : this.kind,
      });
      if (this.disposed || res.status === "error" || res.status === "needs-eula") return;
      this.serverId = res.serverId;
      this.wsPath = res.wsPath;
      await this.connect();
    } catch {
      // pool says no: squiggles fade, editing continues
    }
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      void this.onServerRequest(msg.id, msg.method, msg.params);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...payload }));
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  private async onServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items: { section?: string }[] }).items;
        this.respond(id, items.map((i) => this.lookupSetting(i.section)));
        break;
      }
      case "workspace/applyEdit": {
        await applyWorkspaceEdit(this.project.cwd, (params as { edit: LspWorkspaceEdit }).edit);
        this.respond(id, { applied: true });
        break;
      }
      case "workspace/semanticTokens/refresh":
        this.respond(id, null);
        semanticRefresh.get(this.kind)?.fire();
        break;
      case "workspace/inlayHint/refresh":
        this.respond(id, null);
        inlayRefresh.fire();
        break;
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "workspace/codeLens/refresh":
      case "window/showMessageRequest":
        this.respond(id, null);
        break;
      default:
        this.send({ id, error: { code: -32601, message: `unhandled: ${method}` } });
    }
  }

  private lookupSetting(section?: string): unknown {
    const settings = (this.settings as { settings?: Record<string, unknown> }).settings ?? {};
    if (!section) return settings;
    let cur: unknown = settings;
    for (const part of section.split(".")) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
      else return null;
    }
    return cur ?? null;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      // The IntelliJ engine's markers come from the pull loop, never from
      // push; jdtls owns the push path.
      if (this.engine === "idea") return;
      const { uri, diagnostics } = params as { uri: string; diagnostics: LspDiagnostic[] };
      this.diagnostics.set(uri, diagnostics);
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (!model) return;
      if (LSP_DEBUG) {
        const t = this.changedAt.get(uri);
        if (t !== undefined) {
          this.changedAt.delete(uri);
          console.debug(`[lsp] ${this.kind} diagnostics after ${Math.round(performance.now() - t)}ms`);
        }
      }
      // While the engine owns a file's squiggles, jdtls only feeds the cache.
      if (this.kind === "java" && ideaDiagUris.has(uri)) return;
      monaco.editor.setModelMarkers(model, this.markerOwner, toMarkers(diagnostics));
    } else if (method === "$/progress") {
      const { token, value } = params as {
        token: string | number;
        value: { kind: string; title?: string; message?: string; percentage?: number };
      };
      if (value.kind === "end") this.progress.delete(token);
      else {
        const text = value.message ?? value.title ?? this.progress.get(token) ?? "";
        const pct = value.percentage != null ? ` ${Math.round(value.percentage)}%` : "";
        if (text) this.progress.set(token, `${text}${pct}`);
      }
      const latest = [...this.progress.values()].pop() ?? null;
      this.setBusy(latest);
    } else if (method === "language/status") {
      // jdtls import/index status ("47% Starting Java Language Server").
      const { type, message } = params as { type: string; message?: string };
      if (type === "Started" || type === "ServiceReady") this.setBusy(null);
      else if (message && (type === "Starting" || type === "Error")) this.setBusy(message);
    }
  }

  /** Does this connection own the model? (language kind + project root) */
  owns(model: monaco.editor.ITextModel): boolean {
    if (this.engine === "idea") {
      if (!IDEA_LANGS.has(model.getLanguageId())) return false;
    } else if (kindForLanguage(model.getLanguageId()) !== this.kind) return false;
    return model.uri.scheme === "file" && model.uri.path.startsWith(this.root);
  }

  maybeOpen(model: monaco.editor.ITextModel): void {
    if (!this.owns(model)) return;
    const uri = model.uri.toString();
    if (this.openDocs.has(uri)) return;
    const doc = { model, version: 1 };
    this.openDocs.set(uri, doc);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: LSP_LANGUAGE[model.getLanguageId()] ?? model.getLanguageId(),
        version: doc.version,
        text: model.getValue(),
      },
    });
    this.schedulePull(uri);
    // A reopened file: the server only re-publishes when something changed,
    // so its last diagnostics come back from the cache.
    const cached = this.diagnostics.get(uri);
    if (cached && this.engine !== "idea" && !(this.kind === "java" && ideaDiagUris.has(uri))) {
      monaco.editor.setModelMarkers(model, this.markerOwner, toMarkers(cached));
    }
    this.modelSubs.set(
      uri,
      model.onDidChangeContent((e) => {
        doc.version++;
        this.schedulePull(uri);
        if (LSP_DEBUG) this.changedAt.set(uri, performance.now());
        this.notify("textDocument/didChange", {
          textDocument: { uri, version: doc.version },
          // Monaco sorts an event's changes in reverse document order, so
          // sequential application per the LSP spec is position-safe.
          contentChanges: e.changes.map((c) => ({
            range: {
              start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
              end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
            },
            text: c.text,
          })),
        });
      }),
    );
    model.onWillDispose(() => this.closeDoc(uri));
  }

  private closeDoc(uri: string): void {
    if (!this.openDocs.delete(uri)) return;
    this.modelSubs.get(uri)?.dispose();
    this.modelSubs.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  didSave(model: monaco.editor.ITextModel): void {
    if (!this.openDocs.has(model.uri.toString())) return;
    this.notify("textDocument/didSave", { textDocument: { uri: model.uri.toString() } });
  }

  // ── pull diagnostics (IntelliJ engine only) ──────────────────────
  // IDEA's inspection results replace jdtls markers per file once the
  // engine proves warm (first non-empty pull); empties from a cold engine
  // never wipe jdtls's truth.

  schedulePull(uri: string): void {
    if (this.engine !== "idea") return;
    clearTimeout(this.pullTimers.get(uri));
    this.pullTimers.set(uri, setTimeout(() => void this.pullDiagnostics(uri), 500));
  }

  private async pullDiagnostics(uri: string): Promise<void> {
    if (!this.alive) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    const r = await this.request<{ kind?: string; items?: LspDiagnostic[] } | null>(
      "textDocument/diagnostic",
      { textDocument: { uri } },
    ).catch(() => null);
    if (!r || r.kind === "unchanged") return;
    const items = r.items ?? [];
    if (items.length === 0 && !ideaDiagTrusted.has(this.project.id)) return;
    ideaDiagTrusted.add(this.project.id);
    this.diagnostics.set(uri, items);
    ideaDiagUris.add(uri);
    monaco.editor.setModelMarkers(model, `lsp-java-${this.project.id}`, []);
    monaco.editor.setModelMarkers(model, this.markerOwner, toMarkers(items));
  }

  dispose(): void {
    this.disposed = true;
    this.ws?.close();
  }
}

// Every flush becomes a didSave to whichever connection owns the document
// (jdtls builds incrementally off it).
onModelSaved((model) => {
  for (const connP of conns.values()) void connP.then((conn) => conn?.didSave(model));
});

/** Ensure results that stopped short of a socket: the EULA gate, an error. */
export const ensureBlocked = new Map<string, EnsureResult>();

/** Idempotent per (project, kind[, engine]); null when the pool says error
 *  or, for the IntelliJ engine, when its EULA is still unaccepted. */
export function ensureConnection(
  project: ProjectMeta,
  kind: LangKind,
  engine: Engine = "standard",
): Promise<LspConnection | null> {
  const key = engine === "idea" ? `${project.id}:idea` : `${project.id}:${kind}`;
  let p = conns.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await client.request<EnsureResult>("lsp.ensure", {
          projectId: project.id,
          lang: engine === "idea" ? "idea" : kind,
        });
        if (res.status === "error" || res.status === "needs-eula") {
          ensureBlocked.set(key, res);
          return null;
        }
        ensureBlocked.delete(key);
        const conn = new LspConnection(
          project,
          kind,
          res.serverId,
          res.wsPath,
          settingsFor(kind, res, engine, monaco.Uri.file(project.cwd).toString()),
          engine,
        );
        await conn.connect();
        if (engine === "idea") settledIdea.set(project.id, conn);
        else if (kind === "java") settledStd.set(project.id, conn);
        return conn;
      } catch {
        return null;
      }
    })();
    conns.set(key, p);
    // An errored ensure must not poison the key forever.
    void p.then((conn) => {
      if (!conn) conns.delete(key);
    });
  }
  return p;
}

/** Whether the IntelliJ engine for a project is waiting on the EULA. */
export function ideaNeedsEula(projectId: string): boolean {
  return ensureBlocked.get(`${projectId}:idea`)?.status === "needs-eula";
}

// After an EULA accept every blocked engine ensure may retry; open Java
// models re-sync through connect().
registerBlockedRetry(() => {
  const blocked = [...ensureBlocked.entries()].filter(([, r]) => r.status === "needs-eula");
  ensureBlocked.clear();
  for (const [key] of blocked) {
    const projectId = key.slice(0, key.lastIndexOf(":"));
    const project = workspaceStore.projects.find((p) => p.id === projectId);
    if (project) void ensureConnection(project, "java", "idea");
  }
});
