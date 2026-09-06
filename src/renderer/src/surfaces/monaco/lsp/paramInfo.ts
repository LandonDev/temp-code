import { monaco } from "../monaco";
import { signatureHelpAt } from "./providers";

/**
 * IDEA's Parameter Info (⌘P): every overload at once, stacked, with the
 * candidate parameter bolded per row, not Monaco's one-at-a-time pager.
 * The popup follows the caret while it stays on the line and re-bolds as
 * you move between arguments; Esc, blur, or leaving the line closes it.
 */

let open: { widget: monaco.editor.IContentWidget; dispose: () => void } | null = null;

function close(): void {
  open?.dispose();
  open = null;
}

function paramText(sig: { label: string }, p: { label: string | [number, number] }): string {
  return typeof p.label === "string" ? p.label : sig.label.slice(p.label[0], p.label[1]);
}

// ── overload applicability (IDEA grays what can't match anymore) ─────

type LitKind = "string" | "char" | "int" | "float" | "boolean" | "null" | "unknown";

function literalKind(arg: string): LitKind {
  const a = arg.trim();
  if (!a) return "unknown";
  if (/^".*"$/.test(a)) return "string";
  if (/^'(\\.|[^'])'$/.test(a)) return "char";
  if (/^-?\d+[lL]?$/.test(a)) return "int";
  if (/^-?(\d*\.\d+|\d+\.)([fFdD])?$/.test(a) || /^-?\d+[fFdD]$/.test(a)) return "float";
  if (a === "true" || a === "false") return "boolean";
  if (a === "null") return "null";
  return "unknown";
}

const PRIMITIVES = new Set(["byte", "short", "int", "long", "float", "double", "boolean", "char"]);
const NUMERIC = new Set([
  "byte", "short", "int", "long", "float", "double",
  "Byte", "Short", "Integer", "Long", "Float", "Double", "Number", "Object",
]);

function typeAccepts(declared: string, lit: LitKind): boolean {
  const t = declared.replace("...", "").replace(/<.*>/, "").trim();
  if (lit === "unknown") return true;
  if (t === "Object" || /^[A-Z]$/.test(t)) return true;
  switch (lit) {
    case "string":
      return /String|CharSequence|Comparable|Serializable/.test(t);
    case "char":
      return t === "char" || t === "Character" || NUMERIC.has(t);
    case "int":
      return NUMERIC.has(t);
    case "float":
      return ["float", "double", "Float", "Double", "Number", "Object"].includes(t);
    case "boolean":
      return t === "boolean" || t === "Boolean";
    case "null":
      return !PRIMITIVES.has(t);
  }
}

function declaredType(label: string): string {
  const trimmed = label.trim();
  const at = trimmed.lastIndexOf(" ");
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/** The argument texts typed so far in the enclosing call. */
function typedArgs(model: monaco.editor.ITextModel, position: monaco.Position): string[] | null {
  const offset = model.getOffsetAt(position);
  const start = Math.max(0, offset - 800);
  const text = model.getValue().slice(start, offset);
  let depth = 0;
  let openAt = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        openAt = i;
        break;
      }
      depth--;
    }
  }
  if (openAt < 0) return null;
  const inner = text.slice(openAt + 1);
  const args: string[] = [];
  let cur = "";
  let d = 0;
  let inString: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inString) {
      cur += c;
      if (c === "\\") {
        cur += inner[i + 1] ?? "";
        i++;
      } else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      cur += c;
    } else if (c === "(" || c === "[" || c === "{") {
      d++;
      cur += c;
    } else if (c === ")" || c === "]" || c === "}") {
      d--;
      cur += c;
    } else if (c === "," && d === 0) {
      args.push(cur);
      cur = "";
    } else cur += c;
  }
  args.push(cur);
  return args;
}

function isDimmed(
  sig: { label: string; parameters: { label: string | [number, number] }[] },
  args: string[] | null,
): boolean {
  if (!args) return false;
  const params = sig.parameters;
  const varargs = params.length > 0 && paramText(sig, params[params.length - 1]).includes("...");
  if (!varargs && params.length < args.length) return true;
  for (let i = 0; i < args.length; i++) {
    const lit = literalKind(args[i]);
    if (lit === "unknown") continue;
    const p = params[Math.min(i, varargs ? params.length - 1 : i)];
    if (!p) return true;
    if (!typeAccepts(declaredType(paramText(sig, p)), lit)) return true;
  }
  return false;
}

export async function showParamInfo(editor: monaco.editor.ICodeEditor): Promise<void> {
  close();
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return;
  const help = await signatureHelpAt(model, position);
  if (!help) return;

  const node = document.createElement("div");
  node.className = "tc-param-info";
  const render = (activeParameter: number): void => {
    const m = editor.getModel();
    const pos = editor.getPosition();
    const args = m && pos ? typedArgs(m, pos) : null;
    node.replaceChildren(
      ...help.signatures.map((sig) => {
        const row = document.createElement("div");
        row.className = "tc-param-info-row";
        const dim = isDimmed(sig, args);
        if (dim) row.classList.add("tc-param-info-dimmed");
        if (sig.parameters.length === 0) {
          row.textContent = "<no parameters>";
          row.classList.add("tc-param-info-empty");
          return row;
        }
        sig.parameters.forEach((p, i) => {
          const span = document.createElement("span");
          span.textContent = paramText(sig, p);
          if (!dim && i === Math.min(activeParameter, sig.parameters.length - 1)) {
            span.className = "tc-param-info-active";
          }
          row.append(span);
          if (i < sig.parameters.length - 1) row.append(", ");
        });
        return row;
      }),
    );
  };
  render(help.activeParameter);

  const line = position.lineNumber;
  const widget: monaco.editor.IContentWidget = {
    getId: () => "tc.param.info",
    getDomNode: () => node,
    getPosition: () => ({
      position: editor.getPosition() ?? position,
      preference: [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ],
    }),
  };

  const subs: monaco.IDisposable[] = [];
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  subs.push(
    editor.onDidChangeCursorPosition((e) => {
      if (e.position.lineNumber !== line) {
        close();
        return;
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const m = editor.getModel();
        const pos = editor.getPosition();
        if (!m || !pos) return;
        void signatureHelpAt(m, pos).then((h) => {
          if (h && open?.widget === widget) render(h.activeParameter);
        });
      }, 150);
      editor.layoutContentWidget(widget);
    }),
    editor.onDidBlurEditorWidget(close),
    editor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Escape) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }),
    editor.onDidDispose(close),
  );

  editor.addContentWidget(widget);
  open = {
    widget,
    dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const s of subs) s.dispose();
      editor.removeContentWidget(widget);
    },
  };
}

/** IDEA's smart backspace: on a whitespace-only line, one Backspace removes
 *  the line and lands at the end of the previous one. */
export function installSmartBackspace(editor: monaco.editor.ICodeEditor): void {
  editor.onKeyDown((e) => {
    if (e.keyCode !== monaco.KeyCode.Backspace || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
      return;
    const model = editor.getModel();
    const position = editor.getPosition();
    const selection = editor.getSelection();
    if (!model || !position || !selection?.isEmpty() || position.lineNumber <= 1) return;
    if (model.getLineContent(position.lineNumber).trim() !== "") return;
    const prev = position.lineNumber - 1;
    const prevEnd = model.getLineMaxColumn(prev);
    e.preventDefault();
    e.stopPropagation();
    editor.executeEdits("tc.smartBackspace", [
      { range: new monaco.Range(prev, prevEnd, position.lineNumber, position.column), text: "" },
    ]);
    editor.setPosition({ lineNumber: prev, column: prevEnd });
  });
}
