import { monaco } from "../monaco";

/**
 * The slice of the LSP wire format we speak, plus the conversions between
 * LSP and Monaco positions, kinds, and markers.
 */

export type LangKind = "java" | "web";
export type Engine = "standard" | "idea";

/** Languages the IntelliJ engine serves. */
export const IDEA_LANGS = new Set(["java", "kotlin"]);

/** Monaco language id → pool kind (null = no server serves it). */
export function kindForLanguage(languageId: string): LangKind | null {
  if (languageId === "java") return "java";
  if (["typescript", "tsx", "javascript", "jsx"].includes(languageId)) return "web";
  return null;
}

/** Monaco language id → LSP textDocument languageId. */
export const LSP_LANGUAGE: Record<string, string> = {
  typescript: "typescript",
  tsx: "typescriptreact",
  javascript: "javascript",
  jsx: "javascriptreact",
  java: "java",
  kotlin: "kotlin",
};

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspLocationLink {
  targetUri: string;
  targetSelectionRange: LspRange;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
  tags?: number[];
  data?: unknown;
}
export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}
export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: LspDiagnostic[];
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  data?: unknown;
}
export interface LspInlayHint {
  position: LspPosition;
  label: string | { value: string }[];
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}
export interface LspCompletionItem {
  label: string | { label: string };
  labelDetails?: { detail?: string; description?: string };
  command?: LspCommand;
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  preselect?: boolean;
  textEdit?: (LspTextEdit & { insert?: LspRange; replace?: LspRange }) | undefined;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: (
    | { textDocument: { uri: string }; edits: LspTextEdit[] }
    | { kind: "create" | "rename" | "delete"; uri?: string; oldUri?: string; newUri?: string }
  )[];
}
export interface LspSymbol {
  name: string;
  kind: number;
  location?: LspLocation;
  range?: LspRange;
  selectionRange?: LspRange;
  children?: LspSymbol[];
  containerName?: string;
}

export const toLspPos = (p: monaco.IPosition): LspPosition => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
});
export const toMonacoRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});
export const toLspRange = (r: monaco.IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

export const CIK = monaco.languages.CompletionItemKind;
// index = LSP CompletionItemKind - 1 (kind 1 = Text … 25 = TypeParameter)
export const COMPLETION_KINDS: monaco.languages.CompletionItemKind[] = [
  CIK.Text, CIK.Method, CIK.Function, CIK.Constructor, CIK.Field, CIK.Variable,
  CIK.Class, CIK.Interface, CIK.Module, CIK.Property, CIK.Unit, CIK.Value,
  CIK.Enum, CIK.Keyword, CIK.Snippet, CIK.Color, CIK.File, CIK.Reference,
  CIK.Folder, CIK.EnumMember, CIK.Constant, CIK.Struct, CIK.Event, CIK.Operator,
  CIK.TypeParameter,
];
export const SK = monaco.languages.SymbolKind;
// Indexed by the LSP SymbolKind itself (1 = File … 26 = TypeParameter); slot 0 covers an unset kind.
export const SYMBOL_KINDS: monaco.languages.SymbolKind[] = [
  SK.File, SK.File, SK.Module, SK.Namespace, SK.Package, SK.Class, SK.Method,
  SK.Property, SK.Field, SK.Constructor, SK.Enum, SK.Interface, SK.Function,
  SK.Variable, SK.Constant, SK.String, SK.Number, SK.Boolean, SK.Array,
  SK.Object, SK.Key, SK.Null, SK.EnumMember, SK.Struct, SK.Event, SK.Operator,
  SK.TypeParameter,
];
const SEVERITIES = [
  monaco.MarkerSeverity.Error, // unset: treat as error
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Warning,
  monaco.MarkerSeverity.Info,
  monaco.MarkerSeverity.Hint,
];

export const docString = (d?: string | { value: string }): string =>
  typeof d === "string" ? d : (d?.value ?? "");

export const toMarkers = (diagnostics: LspDiagnostic[]): monaco.editor.IMarkerData[] =>
  diagnostics.map((d) => ({
    ...toMonacoRange(d.range),
    message: d.message,
    severity: SEVERITIES[d.severity ?? 1],
    source: d.source,
    code: d.code === undefined ? undefined : String(d.code),
    tags: (d.tags ?? []).map((t) =>
      t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated,
    ),
  }));

export const docId = (model: monaco.editor.ITextModel): { uri: string } => ({
  uri: model.uri.toString(),
});

export const isCommand = (a: LspCodeAction | LspCommand): a is LspCommand =>
  typeof (a as LspCommand).command === "string";
