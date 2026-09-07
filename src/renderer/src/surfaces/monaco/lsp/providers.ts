import { registerWillRename } from "../../../lib/editorRename";
import { openFileAt } from "../../../lib/monaco/opener";
import { onFileEvent } from "../../../lib/projectWatch";
import { client } from "../../../lib/tcserver/client";
import { dirPrefix, projectForCwd } from "../../../lib/tcserver/projects";
import { languageForPath, monaco } from "../monaco";
import { entryForUri, registerSaveHook } from "../models";
import { registerGhostText } from "../ghost";
import {
  connectionInitialized,
  conns,
  inlayRefresh,
  semanticRefresh,
  settledIdea,
  settledStd,
  type LspConnection,
} from "./connection";
import { applyEditsToModel, applyWorkspaceEdit } from "./edits";
import {
  connFor,
  ensureDecompiledModel,
  ensurePreviewModel,
  IDEA_BUDGET_MS,
  ideaEligible,
  ideaFor,
  ideaPending,
  projectForModel,
  readSide,
  recordIdea,
} from "./idea";
import {
  CIK,
  COMPLETION_KINDS,
  docId,
  docString,
  IDEA_LANGS,
  isCommand,
  kindForLanguage,
  SK,
  SYMBOL_KINDS,
  toLspPos,
  toLspRange,
  toMonacoRange,
  type LangKind,
  type LspCodeAction,
  type LspCommand,
  type LspCompletionItem,
  type LspInlayHint,
  type LspLocation,
  type LspLocationLink,
  type LspPosition,
  type LspRange,
  type LspSymbol,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "./types";

/**
 * Every Monaco provider, registered once per language id and routed by
 * model through the connection that owns the model's project.
 */

const ALL_LSP_LANGS = ["typescript", "tsx", "javascript", "jsx", "java", "kotlin"];

// ── semantic tokens (fields purple, statics italic) ──────────────────
// The legend is provider-level, so registration waits for the first
// initialized connection of a kind and reuses its server's legend.

interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

const LANGS_FOR_KIND: Record<LangKind, string[]> = {
  java: ["java"],
  web: ["typescript", "tsx", "javascript", "jsx"],
};

const semanticRegs = new Map<LangKind, { legendJson: string; disposables: monaco.IDisposable[] }>();

function maybeRegisterSemanticTokens(conn: LspConnection): void {
  if (conn.engine === "idea") return;
  const cap = conn.capabilities.semanticTokensProvider as
    | { legend?: SemanticLegend; range?: boolean | object }
    | undefined;
  if (!cap?.legend) return;
  const legendJson = JSON.stringify(cap.legend);
  const prev = semanticRegs.get(conn.kind);
  if (prev?.legendJson === legendJson) return;
  prev?.disposables.forEach((d) => d.dispose());
  const legend = cap.legend;
  const langs = LANGS_FOR_KIND[conn.kind];
  let refresh = semanticRefresh.get(conn.kind);
  if (!refresh) {
    refresh = new monaco.Emitter<void>();
    semanticRefresh.set(conn.kind, refresh);
  }
  const disposables: monaco.IDisposable[] = [
    monaco.languages.registerDocumentSemanticTokensProvider(langs, {
      onDidChange: refresh.event,
      getLegend: () => legend,
      async provideDocumentSemanticTokens(model) {
        const c = await connFor(model);
        if (!c) return null;
        const r = await c
          .request<{ resultId?: string; data: number[] } | null>(
            "textDocument/semanticTokens/full",
            { textDocument: docId(model) },
          )
          .catch(() => null);
        return r ? { data: new Uint32Array(r.data), resultId: r.resultId } : null;
      },
      releaseDocumentSemanticTokens: (): void => undefined,
    }),
  ];
  if (cap.range) {
    disposables.push(
      monaco.languages.registerDocumentRangeSemanticTokensProvider(langs, {
        getLegend: () => legend,
        async provideDocumentRangeSemanticTokens(model, range) {
          const c = await connFor(model);
          if (!c) return null;
          const r = await c
            .request<{ data: number[] } | null>("textDocument/semanticTokens/range", {
              textDocument: docId(model),
              range: toLspRange(range),
            })
            .catch(() => null);
          return r ? { data: new Uint32Array(r.data) } : null;
        },
      }),
    );
  }
  semanticRegs.set(conn.kind, { legendJson, disposables });
}

// ── code actions (Alt+Enter) ─────────────────────────────────────────

/** Apply one code action through our own edit path, never Monaco's bulk
 *  edit service. */
async function runCodeAction(
  model: monaco.editor.ITextModel,
  raw: LspCodeAction | LspCommand,
  source?: LspConnection,
): Promise<void> {
  const conn = source?.alive ? source : ((await connFor(model)) ?? ideaFor(model));
  const project = projectForModel(model);
  if (!conn || !project) return;
  let action: LspCodeAction = isCommand(raw) ? { title: raw.title, command: raw } : raw;
  const resolves = (conn.capabilities.codeActionProvider as { resolveProvider?: boolean })
    ?.resolveProvider;
  if (!action.edit && !action.command && resolves) {
    action =
      (await conn.request<LspCodeAction>("codeAction/resolve", action).catch(() => null)) ?? action;
  }
  if (action.edit) await applyWorkspaceEdit(project.cwd, action.edit);
  const cmd = action.command;
  if (!cmd) return;
  if (cmd.command === "java.apply.workspaceEdit") {
    // jdtls ships many quickfixes as this client-side command.
    for (const e of (cmd.arguments ?? []) as LspWorkspaceEdit[]) {
      await applyWorkspaceEdit(project.cwd, e);
    }
  } else {
    // The server executes and drives us via workspace/applyEdit.
    await conn
      .request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments ?? [] })
      .catch(() => null);
  }
}

// ── Code Vision (usages + last editor) ───────────────────────────────

interface LensSymbol {
  name: string;
  line: number;
  selection: LspPosition;
  endLine: number;
}

const lensCache = new Map<string, { version: number; symbols: LensSymbol[] }>();
const lensResolved = new Map<string, { title: string }>();

function flattenLensSymbols(symbols: LspSymbol[], out: LensSymbol[]): void {
  for (const sym of symbols) {
    // methods (6), constructors (9), classes (5), interfaces (11), enums (10), functions (12)
    if ([5, 6, 9, 10, 11, 12].includes(sym.kind) && sym.range && sym.selectionRange) {
      out.push({
        name: sym.name,
        line: sym.selectionRange.start.line + 1,
        selection: sym.selectionRange.start,
        endLine: sym.range.end.line + 1,
      });
    }
    if (sym.children) flattenLensSymbols(sym.children, out);
  }
}

/** The last model a completion list was produced for (resolve routing). */
let lastCompletionModelId = "";
monaco.editor.onDidCreateEditor((editor) => {
  editor.onDidChangeModel(() => {
    lastCompletionModelId = editor.getModel()?.id ?? lastCompletionModelId;
  });
  editor.onDidFocusEditorText(() => {
    lastCompletionModelId = editor.getModel()?.id ?? lastCompletionModelId;
  });
});

let registered = false;
export function registerProviders(): void {
  if (registered) return;
  registered = true;

  connectionInitialized.event(maybeRegisterSemanticTokens);
  // Connections that settled before the providers registered (a warm boot).
  for (const conn of settledStd.values()) maybeRegisterSemanticTokens(conn);

  monaco.languages.registerCompletionItemProvider(ALL_LSP_LANGS, {
    triggerCharacters: [".", '"', "'", "/", "@", "<", ":", "("],
    async provideCompletionItems(model, position, context) {
      const conn = await connFor(model);
      const project = projectForModel(model);
      const pid = project?.id ?? conn?.project.id ?? "";
      const ideaP0 = IDEA_LANGS.has(model.getLanguageId()) ? ideaPending(pid) : undefined;
      if (!conn && !ideaP0) return null;
      type CompletionResult =
        | { items: LspCompletionItem[]; isIncomplete?: boolean }
        | LspCompletionItem[]
        | null;
      const params = {
        textDocument: docId(model),
        position: toLspPos(position),
        context: {
          triggerKind: context.triggerCharacter ? 2 : 1,
          triggerCharacter: context.triggerCharacter,
        },
      };
      // jdtls is always in flight; the IntelliJ engine wins if it answers
      // inside the budget with items. Kotlin has no jdtls leg: the engine
      // answer is awaited outright.
      const jdtlsP = conn
        ? conn.request<CompletionResult>("textDocument/completion", params).catch(() => null)
        : Promise.resolve(null);
      let result: CompletionResult = null;
      let source = conn as LspConnection;
      if (ideaP0 && ideaEligible(pid)) {
        const ideaP = (async (): Promise<{ r: CompletionResult } | null> => {
          const idea = await ideaP0;
          if (!idea) return null; // engine absent: no race, no strike
          idea.maybeOpen(model);
          return { r: await idea.request<CompletionResult>("textDocument/completion", params) };
        })().catch(() => ({ r: null }));
        const winner = conn
          ? await Promise.race([
              ideaP,
              new Promise<"timeout">((res) => setTimeout(() => res("timeout"), IDEA_BUDGET_MS)),
            ])
          : await ideaP;
        if (winner === "timeout") recordIdea(pid, false);
        else if (winner !== null) {
          recordIdea(pid, winner.r !== null);
          const arr = winner.r === null ? [] : Array.isArray(winner.r) ? winner.r : winner.r.items;
          // A cold engine serves postfix templates before real members; a
          // list with no substantive item must not beat jdtls's full one.
          const substantive = arr.some((i) => i.kind !== undefined && i.kind !== 15 && i.kind !== 1);
          if (arr.length > 0 && (substantive || !conn)) {
            result = winner.r;
            source = settledIdea.get(pid) ?? source;
          }
        }
      }
      if (!result) result = await jdtlsP;
      if (!result) return null;
      const items = (Array.isArray(result) ? result : result.items).filter(
        // VS-Code-era postfix leftovers with nothing to insert are unusable here.
        (i) =>
          !(i.command && /\.completion\.apply$/.test(i.command.command) && !i.textEdit && !i.insertText),
      );
      const word = model.getWordUntilPosition(position);
      const defaultRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      return {
        incomplete: !Array.isArray(result) && !!result.isIncomplete,
        suggestions: items.map((item) => {
          const label = typeof item.label === "string" ? item.label : item.label.label;
          const edit = item.textEdit;
          const range = edit
            ? toMonacoRange("insert" in edit && edit.insert ? edit.insert : edit.range)
            : defaultRange;
          const insertText = edit?.newText ?? item.insertText ?? label;
          // IDEA pops parameter info the moment a call completes; neither
          // server can trigger it, so attach it client-side.
          const callLike =
            (item.kind === 2 || item.kind === 3 || item.kind === 4) && insertText.includes("(");
          const suggestion: monaco.languages.CompletionItem & {
            __lsp?: LspCompletionItem;
            __conn?: LspConnection;
          } = {
            label: item.labelDetails
              ? { label, detail: item.labelDetails.detail, description: item.labelDetails.description }
              : label,
            kind: COMPLETION_KINDS[(item.kind ?? 1) - 1] ?? CIK.Text,
            tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
            insertText,
            command: callLike ? { id: "editor.action.triggerParameterHints", title: "" } : undefined,
            insertTextRules:
              item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            range,
            detail: item.detail,
            documentation: item.documentation ? { value: docString(item.documentation) } : undefined,
            filterText: item.filterText,
            sortText: item.sortText,
            preselect: item.preselect,
            commitCharacters: item.commitCharacters,
            additionalTextEdits: item.additionalTextEdits?.map((e) => ({
              range: toMonacoRange(e.range),
              text: e.newText,
            })),
          };
          suggestion.__lsp = item;
          suggestion.__conn = source;
          return suggestion;
        }),
      };
    },
    async resolveCompletionItem(item) {
      const lsp = (item as { __lsp?: LspCompletionItem }).__lsp;
      if (!lsp) return item;
      let conn = (item as { __conn?: LspConnection }).__conn ?? null;
      if (!conn) {
        const model = monaco.editor.getModels().find((m) => m.id === lastCompletionModelId);
        conn = model ? await connFor(model) : null;
      }
      if (!conn) return item;
      const resolved = await conn
        .request<LspCompletionItem>("completionItem/resolve", lsp)
        .catch(() => null);
      if (!resolved) return item;
      return {
        ...item,
        detail: resolved.detail ?? item.detail,
        documentation: resolved.documentation
          ? { value: docString(resolved.documentation) }
          : item.documentation,
        additionalTextEdits:
          resolved.additionalTextEdits?.map((e) => ({
            range: toMonacoRange(e.range),
            text: e.newText,
          })) ?? item.additionalTextEdits,
      };
    },
  });

  monaco.languages.registerHoverProvider(ALL_LSP_LANGS, {
    async provideHover(model, position) {
      const hover = await readSide<{ contents: unknown; range?: LspRange }>(
        model,
        "hoverProvider",
        "textDocument/hover",
        { textDocument: docId(model), position: toLspPos(position) },
      );
      if (!hover?.contents) return null;
      const parts = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
      const value = parts
        .map((part) =>
          typeof part === "string"
            ? part
            : "value" in (part as object)
              ? (part as { language?: string; value: string }).language
                ? `\`\`\`${(part as { language: string }).language}\n${(part as { value: string }).value}\n\`\`\``
                : (part as { value: string }).value
              : "",
        )
        .filter(Boolean)
        .join("\n\n");
      if (!value) return null;
      return { contents: [{ value }], range: hover.range ? toMonacoRange(hover.range) : undefined };
    },
  });

  monaco.languages.registerSignatureHelpProvider(ALL_LSP_LANGS, {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, position) {
      const help = await readSide<{
        signatures: {
          label: string;
          documentation?: string | { value: string };
          parameters?: { label: string | [number, number]; documentation?: string | { value: string } }[];
        }[];
        activeSignature?: number;
        activeParameter?: number;
      }>(model, "signatureHelpProvider", "textDocument/signatureHelp", {
        textDocument: docId(model),
        position: toLspPos(position),
      });
      if (!help?.signatures.length) return null;
      return {
        value: {
          signatures: help.signatures.map((s) => ({
            label: s.label,
            documentation: s.documentation ? { value: docString(s.documentation) } : undefined,
            parameters: (s.parameters ?? []).map((p) => ({
              label: p.label,
              documentation: p.documentation ? { value: docString(p.documentation) } : undefined,
            })),
          })),
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });

  const toLocations = async (
    model: monaco.editor.ITextModel,
    result: LspLocation | LspLocation[] | LspLocationLink[] | null,
  ): Promise<monaco.languages.Location[]> => {
    if (!result) return [];
    const list = Array.isArray(result) ? result : [result];
    const project = projectForModel(model);
    const locations: monaco.languages.Location[] = [];
    for (const loc of list.slice(0, 50)) {
      const raw = "targetUri" in loc ? loc.targetUri : loc.uri;
      const uri = monaco.Uri.parse(raw);
      const range = toMonacoRange("targetUri" in loc ? loc.targetSelectionRange : loc.range);
      if (project) {
        if (uri.scheme === "file") await ensurePreviewModel(project, uri);
        else await ensureDecompiledModel(project.id, raw);
      }
      locations.push({ uri, range });
    }
    return locations;
  };

  const locationProvider = (cap: string, method: string) => async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ) => {
    const result = await readSide<LspLocation | LspLocation[] | LspLocationLink[]>(
      model,
      cap,
      method,
      { textDocument: docId(model), position: toLspPos(position) },
    );
    return toLocations(model, result);
  };

  monaco.languages.registerDefinitionProvider(ALL_LSP_LANGS, {
    provideDefinition: locationProvider("definitionProvider", "textDocument/definition"),
  });
  monaco.languages.registerTypeDefinitionProvider(ALL_LSP_LANGS, {
    provideTypeDefinition: locationProvider("typeDefinitionProvider", "textDocument/typeDefinition"),
  });
  monaco.languages.registerImplementationProvider(ALL_LSP_LANGS, {
    provideImplementation: locationProvider("implementationProvider", "textDocument/implementation"),
  });

  monaco.languages.registerReferenceProvider(ALL_LSP_LANGS, {
    async provideReferences(model, position) {
      const result = await readSide<LspLocation[]>(
        model,
        "referencesProvider",
        "textDocument/references",
        {
          textDocument: docId(model),
          position: toLspPos(position),
          context: { includeDeclaration: true },
        },
      );
      return toLocations(model, result);
    },
  });

  monaco.languages.registerRenameProvider(ALL_LSP_LANGS, {
    async provideRenameEdits(model, position, newName) {
      const edit = await readSide<LspWorkspaceEdit>(
        model,
        "renameProvider",
        "textDocument/rename",
        { textDocument: docId(model), position: toLspPos(position), newName },
        3000,
      );
      if (!edit) return null;
      // Pre-open touched files so Monaco's bulk edit can apply everything
      // (open models autosave through the registry).
      const uris = new Set<string>();
      if (edit.changes) for (const uri of Object.keys(edit.changes)) uris.add(uri);
      if (edit.documentChanges)
        for (const c of edit.documentChanges) if ("textDocument" in c) uris.add(c.textDocument.uri);
      const project = projectForModel(model);
      if (project) {
        for (const uri of uris) await ensurePreviewModel(project, monaco.Uri.parse(uri));
      }
      const edits: monaco.languages.IWorkspaceTextEdit[] = [];
      const push = (uri: string, list: LspTextEdit[]): void => {
        for (const e of list) {
          edits.push({
            resource: monaco.Uri.parse(uri),
            textEdit: { range: toMonacoRange(e.range), text: e.newText },
            versionId: undefined,
          });
        }
      };
      if (edit.changes) for (const [uri, list] of Object.entries(edit.changes)) push(uri, list);
      if (edit.documentChanges)
        for (const c of edit.documentChanges) if ("textDocument" in c) push(c.textDocument.uri, c.edits);
      return { edits };
    },
  });

  monaco.languages.registerDocumentSymbolProvider(ALL_LSP_LANGS, {
    async provideDocumentSymbols(model) {
      const symbols = await readSide<LspSymbol[]>(
        model,
        "documentSymbolProvider",
        "textDocument/documentSymbol",
        { textDocument: docId(model) },
      );
      if (!symbols) return null;
      const convert = (s: LspSymbol): monaco.languages.DocumentSymbol => {
        const range = s.range ?? s.location?.range;
        const selection = s.selectionRange ?? range;
        return {
          name: s.name,
          detail: "",
          kind: SYMBOL_KINDS[s.kind] ?? SK.Variable,
          tags: [],
          range: range ? (toMonacoRange(range) as monaco.Range) : new monaco.Range(1, 1, 1, 1),
          selectionRange: selection
            ? (toMonacoRange(selection) as monaco.Range)
            : new monaco.Range(1, 1, 1, 1),
          children: s.children?.map(convert),
        };
      };
      return symbols.map(convert);
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(ALL_LSP_LANGS, {
    async provideDocumentFormattingEdits(model) {
      const edits = await formattingEdits(model);
      return edits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })) ?? null;
    },
  });

  const APPLY_ACTION = "tc.lsp.applyCodeAction";
  monaco.editor.registerCommand(
    APPLY_ACTION,
    (_accessor, payload: { uri: string; action: LspCodeAction | LspCommand; source?: LspConnection }) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(payload.uri));
      if (model) void runCodeAction(model, payload.action, payload.source);
    },
  );

  monaco.languages.registerCodeActionProvider(ALL_LSP_LANGS, {
    async provideCodeActions(model, range, context) {
      const conn = (await connFor(model)) ?? ideaFor(model);
      if (!conn?.capabilities.codeActionProvider) return null;
      const ask = async (c: LspConnection): Promise<(LspCodeAction | LspCommand)[] | null> => {
        // Context diagnostics come from the asking connection's own cache,
        // LSP-shaped, so each server matches them to its own fixes.
        const cached = c.diagnostics.get(model.uri.toString()) ?? [];
        const inRange = cached.filter((d) =>
          monaco.Range.areIntersectingOrTouching(toMonacoRange(d.range) as monaco.Range, range),
        );
        return c.request<(LspCodeAction | LspCommand)[] | null>("textDocument/codeAction", {
          textDocument: docId(model),
          range: toLspRange(range),
          context: {
            diagnostics: inRange,
            ...(context.only ? { only: [context.only] } : {}),
            triggerKind: context.trigger === 1 ? 1 : 2,
          },
        });
      };
      // IDEA intentions when the engine is up; jdtls quickfixes otherwise.
      let source = conn;
      let result: (LspCodeAction | LspCommand)[] | null = null;
      const ij = ideaFor(model);
      if (ij && ij !== conn) {
        const r = await Promise.race([
          ask(ij).catch(() => null),
          new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 800)),
        ]);
        if (r !== "timeout" && r && r.length > 0) {
          result = r;
          source = ij;
        }
      }
      if (!result) result = await ask(conn).catch(() => null);
      return {
        actions: (result ?? []).map((a) => ({
          title: a.title,
          kind: isCommand(a) ? "quickfix" : (a.kind ?? "quickfix"),
          isPreferred: isCommand(a) ? undefined : a.isPreferred,
          diagnostics: [],
          command: {
            id: APPLY_ACTION,
            title: a.title,
            arguments: [{ uri: model.uri.toString(), action: a, source }],
          },
        })),
        dispose: () => {},
      };
    },
  });

  monaco.languages.registerInlayHintsProvider(ALL_LSP_LANGS, {
    onDidChangeInlayHints: inlayRefresh.event,
    async provideInlayHints(model, range) {
      const hints = await readSide<LspInlayHint[]>(
        model,
        "inlayHintProvider",
        "textDocument/inlayHint",
        { textDocument: docId(model), range: toLspRange(range) },
      );
      if (!hints) return null;
      return {
        hints: hints.map((h) => ({
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          label: typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join(""),
          kind:
            h.kind === 1
              ? monaco.languages.InlayHintKind.Type
              : monaco.languages.InlayHintKind.Parameter,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        })),
        dispose: () => {},
      };
    },
  });

  monaco.languages.registerFoldingRangeProvider(ALL_LSP_LANGS, {
    async provideFoldingRanges(model) {
      const ranges = await readSide<{ startLine: number; endLine: number; kind?: string }[]>(
        model,
        "foldingRangeProvider",
        "textDocument/foldingRange",
        { textDocument: docId(model) },
      );
      // null → Monaco falls back to indentation folding.
      return (
        ranges?.map((r) => ({
          start: r.startLine + 1,
          end: r.endLine + 1,
          kind:
            r.kind === "imports"
              ? monaco.languages.FoldingRangeKind.Imports
              : r.kind === "comment"
                ? monaco.languages.FoldingRangeKind.Comment
                : undefined,
        })) ?? null
      );
    },
  });

  monaco.languages.registerDocumentHighlightProvider(ALL_LSP_LANGS, {
    async provideDocumentHighlights(model, position) {
      const list = await readSide<{ range: LspRange; kind?: number }[]>(
        model,
        "documentHighlightProvider",
        "textDocument/documentHighlight",
        { textDocument: docId(model), position: toLspPos(position) },
      );
      if (!list) return null;
      const DHK = monaco.languages.DocumentHighlightKind;
      const KINDS = [DHK.Text, DHK.Text, DHK.Read, DHK.Write];
      return list.map((h) => ({ range: toMonacoRange(h.range) as monaco.Range, kind: KINDS[h.kind ?? 1] }));
    },
  });

  const LENS_USAGES = "tc.lens.showUsages";
  monaco.editor.registerCommand(
    LENS_USAGES,
    (_accessor, payload: { uri: string; position: monaco.IPosition; name: string }) => {
      const target = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === payload.uri);
      if (!target) return;
      target.focus();
      target.setPosition(payload.position);
      void import("./usages").then(({ showUsages }) => showUsages(target, payload.name, payload.position));
    },
  );

  monaco.languages.registerCodeLensProvider(["java", "kotlin"], {
    async provideCodeLenses(model) {
      const uri = model.uri.toString();
      const cached = lensCache.get(uri);
      let symbols = cached?.version === model.getVersionId() ? cached.symbols : null;
      if (!symbols) {
        const raw = await readSide<LspSymbol[]>(
          model,
          "documentSymbolProvider",
          "textDocument/documentSymbol",
          { textDocument: docId(model) },
        );
        if (!raw) return null;
        symbols = [];
        flattenLensSymbols(raw, symbols);
        lensCache.set(uri, { version: model.getVersionId(), symbols });
      }
      return {
        lenses: symbols.map((sym, i) => ({
          range: new monaco.Range(sym.line, 1, sym.line, 1),
          id: `${uri}:${i}`,
          command: undefined,
        })),
        dispose: () => {},
      };
    },
    async resolveCodeLens(model, lens) {
      const uri = model.uri.toString();
      const cached = lensCache.get(uri);
      const sym = cached?.symbols.find((x) => x.line === lens.range.startLineNumber);
      if (!sym) return lens;
      const key = `${uri}:${model.getVersionId()}:${sym.line}:${sym.name}`;
      let resolved = lensResolved.get(key);
      if (!resolved) {
        const entry = entryForUri(model.uri);
        const project = projectForModel(model);
        const refsP = readSide<LspLocation[]>(
          model,
          "referencesProvider",
          "textDocument/references",
          { textDocument: docId(model), position: sym.selection, context: { includeDeclaration: false } },
          4000,
        );
        const blameP =
          entry && project
            ? client
                .request<{ author: string | null; others: number }>("project.blame", {
                  projectId: project.id,
                  path: entry.path.slice(dirPrefix(project.cwd).length),
                  startLine: sym.line,
                  endLine: Math.max(sym.line, sym.endLine),
                })
                .catch(() => null)
            : Promise.resolve(null);
        const [refs, blame] = await Promise.all([refsP, blameP]);
        const n = refs?.length ?? 0;
        const usages = n === 0 ? "no usages" : n === 1 ? "1 usage" : `${n} usages`;
        const who = blame?.author ? `  ·  ${blame.author}${blame.others > 0 ? ` +${blame.others}` : ""}` : "";
        resolved = { title: `${usages}${who}` };
        lensResolved.set(key, resolved);
        if (lensResolved.size > 500) lensResolved.delete(lensResolved.keys().next().value as string);
      }
      lens.command = {
        id: LENS_USAGES,
        title: resolved.title,
        arguments: [
          {
            uri,
            position: { lineNumber: sym.selection.line + 1, column: sym.selection.character + 1 },
            name: sym.name,
          },
        ],
      };
      return lens;
    },
  });

  // Cross-file navigation opens a pane through the app (the registered
  // opener wins over Monaco's default no-op for unknown resources).
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      // Decompiled targets have no pane: peek them over the source editor.
      if (resource.scheme !== "file") {
        if (monaco.editor.getModel(resource)) {
          source.trigger("tc", "editor.action.peekDefinition", null);
          return true;
        }
        return false;
      }
      const reveal = monaco.Range.isIRange(selectionOrPosition)
        ? { lineNumber: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
        : (selectionOrPosition ?? undefined);
      return openFileAt(resource.path, reveal?.lineNumber, reveal?.column);
    },
  });

  registerGhostText();
}

async function formattingEdits(model: monaco.editor.ITextModel): Promise<LspTextEdit[] | null> {
  // Routed: the IntelliJ engine formats with the project's IDEA code style.
  return readSide<LspTextEdit[]>(model, "documentFormattingProvider", "textDocument/formatting", {
    textDocument: docId(model),
    options: { tabSize: model.getOptions().tabSize, insertSpaces: model.getOptions().insertSpaces },
  });
}

// File renames route through the IntelliJ engine first: the
// workspace/willRenameFiles edit updates imports before the rename.
// Without the engine (or for TypeScript) the file's standard server —
// jdtls, vtsls — answers the same request.
// Servers learn about files they did not edit themselves — a tree rename,
// a checkout, an agent's write — from the client's watcher; jdtls and
// vtsls ask for it and otherwise keep resolving the old file.
onFileEvent((e) => {
  const type = e.kind === "created" ? 1 : e.kind === "deleted" ? 3 : 2;
  const changes = [{ uri: monaco.Uri.file(e.path).toString(), type }];
  for (const p of conns.values()) {
    void p.then((c) => {
      if (c?.alive && c.engine !== "idea" && c.project.id === e.projectId) {
        c.notify("workspace/didChangeWatchedFiles", { changes });
      }
    });
  }
});

registerWillRename(async (cwd, fromPath, toPath) => {
  const ij = [...settledIdea.values()].find((c) => c.project.cwd === cwd || fromPath.startsWith(c.root));
  const conn = ij?.alive ? ij : await standardConnFor(cwd, fromPath);
  if (!conn?.alive) return;
  const files = [{ oldUri: monaco.Uri.file(fromPath).toString(), newUri: monaco.Uri.file(toPath).toString() }];
  const edit = await Promise.race([
    conn.request<LspWorkspaceEdit | null>("workspace/willRenameFiles", { files }).catch(() => null),
    new Promise<null>((res) => setTimeout(() => res(null), 1500)),
  ]);
  if (edit) await applyWorkspaceEdit(conn.project.cwd, edit);
});

async function standardConnFor(cwd: string, path: string): Promise<LspConnection | null> {
  const kind = kindForLanguage(languageForPath(path));
  const project = projectForCwd(cwd);
  if (!kind || !project) return null;
  return (await conns.get(`${project.id}:${kind}`)) ?? null;
}

// Format-on-save: the registry calls this before a flush when enabled.
registerSaveHook(async (model) => {
  const edits = await formattingEdits(model);
  if (edits?.length) applyEditsToModel(model, edits);
});

// ── workspace symbols ────────────────────────────────────────────────

export interface WorkspaceSymbolRow {
  name: string;
  kind: monaco.languages.SymbolKind;
  containerName: string;
  uri: string;
  range: monaco.IRange;
}

const symbolRow = (sym: LspSymbol): WorkspaceSymbolRow => ({
  name: sym.name,
  kind: SYMBOL_KINDS[sym.kind] ?? SK.Variable,
  containerName: sym.containerName ?? "",
  uri: sym.location?.uri ?? "",
  range: sym.location
    ? toMonacoRange(sym.location.range)
    : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
});

export async function workspaceSymbols(projectId: string, query: string): Promise<WorkspaceSymbolRow[]> {
  const ij = settledIdea.get(projectId);
  if (ij?.alive && ideaEligible(projectId)) {
    const symbols = await ij.request<LspSymbol[] | null>("workspace/symbol", { query }).catch(() => null);
    if (symbols?.length) return symbols.slice(0, 100).map(symbolRow);
  }
  const kinds: LangKind[] = ["web", "java"];
  const live = kinds.map((kind) => conns.get(`${projectId}:${kind}`)).filter((c) => c !== undefined);
  const results = await Promise.all(
    live.map(async (connP) => {
      const conn = await connP;
      if (!conn) return [];
      const symbols = await conn.request<LspSymbol[] | null>("workspace/symbol", { query }).catch(() => null);
      return (symbols ?? []).slice(0, 60).map(symbolRow);
    }),
  );
  return results.flat().slice(0, 100);
}

// ── parameter info and usages (read helpers for the popups) ──────────

export interface ParamInfoSignature {
  label: string;
  parameters: { label: string | [number, number] }[];
}

export async function signatureHelpAt(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<{ signatures: ParamInfoSignature[]; activeParameter: number } | null> {
  const help = await readSide<{
    signatures: ParamInfoSignature[];
    activeSignature?: number;
    activeParameter?: number;
  }>(model, "signatureHelpProvider", "textDocument/signatureHelp", {
    textDocument: docId(model),
    position: toLspPos(position),
  });
  if (!help?.signatures?.length) return null;
  return { signatures: help.signatures, activeParameter: help.activeParameter ?? 0 };
}

/** References for the usages popup (excerpt rows want raw locations). */
export async function referencesAt(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): Promise<LspLocation[] | null> {
  const refs = await readSide<LspLocation[]>(
    model,
    "referencesProvider",
    "textDocument/references",
    {
      textDocument: docId(model),
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      context: { includeDeclaration: false },
    },
    5000,
  );
  if (!refs) return null;
  const project = projectForModel(model);
  if (project) {
    for (const ref of refs.slice(0, 40)) await ensurePreviewModel(project, monaco.Uri.parse(ref.uri));
  }
  return refs;
}

// ── hierarchies (⌃⌥H callers, ⌃H types) ──────────────────────────────

interface HierarchyItem {
  name: string;
  detail?: string;
  uri: string;
  selectionRange: LspRange;
  range: LspRange;
}

export interface HierarchyResult {
  title: string;
  rows: { name: string; containerName: string; uri: string; range: monaco.IRange }[];
}

async function hierarchyConn(model: monaco.editor.ITextModel, cap: string): Promise<LspConnection | null> {
  const ij = ideaFor(model);
  if (ij?.capabilities[cap]) return ij;
  const std = await connFor(model);
  return std?.capabilities[cap] ? std : null;
}

const itemRow = (item: HierarchyItem, tag: string): HierarchyResult["rows"][number] => ({
  name: item.name,
  containerName: [tag, item.detail ?? item.uri.split("/").pop() ?? ""].filter(Boolean).join(" · "),
  uri: item.uri,
  range: toMonacoRange(item.selectionRange ?? item.range),
});

export async function callHierarchy(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<HierarchyResult | null> {
  const conn = await hierarchyConn(model, "callHierarchyProvider");
  if (!conn) return null;
  const prep = await conn
    .request<HierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
      textDocument: docId(model),
      position: toLspPos(position),
    })
    .catch(() => null);
  const item = prep?.[0];
  if (!item) return null;
  const incoming = await conn
    .request<{ from: HierarchyItem }[] | null>("callHierarchy/incomingCalls", { item })
    .catch(() => null);
  return { title: `Callers of ${item.name}`, rows: (incoming ?? []).map((c) => itemRow(c.from, "")) };
}

export async function typeHierarchy(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<HierarchyResult | null> {
  const conn = await hierarchyConn(model, "typeHierarchyProvider");
  if (!conn) return null;
  const prep = await conn
    .request<HierarchyItem[] | null>("textDocument/prepareTypeHierarchy", {
      textDocument: docId(model),
      position: toLspPos(position),
    })
    .catch(() => null);
  const item = prep?.[0];
  if (!item) return null;
  const [supers, subs] = await Promise.all([
    conn.request<HierarchyItem[] | null>("typeHierarchy/supertypes", { item }).catch(() => null),
    conn.request<HierarchyItem[] | null>("typeHierarchy/subtypes", { item }).catch(() => null),
  ]);
  return {
    title: `Type hierarchy of ${item.name}`,
    rows: [
      ...(supers ?? []).map((t) => itemRow(t, "↑ supertype")),
      ...(subs ?? []).map((t) => itemRow(t, "↓ subtype")),
    ],
  };
}

/** Show a hierarchy for the symbol at the cursor in the usages-style popup. */
export async function showHierarchy(
  editor: monaco.editor.ICodeEditor,
  variant: "callers" | "types",
): Promise<void> {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return;
  const res = await (variant === "callers" ? callHierarchy(model, position) : typeHierarchy(model, position));
  if (!res) return;
  const { showRowsPopup, escapeHtml } = await import("./usages");
  showRowsPopup(
    editor,
    `<b>${escapeHtml(res.title)}</b>`,
    res.rows.length === 1 ? "1 row" : `${res.rows.length} rows`,
    res.rows.map((row) => ({
      uri: monaco.Uri.parse(row.uri),
      label: row.name,
      line: row.range.startLineNumber,
      column: row.range.startColumn,
      excerpt: row.containerName,
    })),
    position,
  );
}
