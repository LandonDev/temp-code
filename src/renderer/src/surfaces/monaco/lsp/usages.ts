import { openFileAt } from "../../../lib/monaco/opener";
import { dirPrefix } from "../../../lib/tcserver/projects";
import { monaco } from "../monaco";
import { projectForModel } from "./idea";
import { referencesAt } from "./providers";

/**
 * IDEA's Show Usages popup (the Code Vision lens click), and the same
 * anchored list reused for hierarchies: a header, rows of
 * `File.java <line>  <excerpt>`, arrow and enter navigation, and the
 * current row's path in the footer.
 */

export interface PopupRow {
  uri: monaco.Uri;
  label: string;
  line: number;
  column: number;
  excerpt: string;
  /** what the excerpt should bold */
  emphasis?: string;
}

let open: { dispose: () => void } | null = null;

function close(): void {
  open?.dispose();
  open = null;
}

export function showRowsPopup(
  editor: monaco.editor.ICodeEditor,
  titleHtml: string,
  count: string,
  rows: PopupRow[],
  position: monaco.IPosition,
): void {
  close();
  if (rows.length === 0) return;
  const model = editor.getModel();
  const project = model ? projectForModel(model) : undefined;
  const root = project ? dirPrefix(project.cwd) : null;

  const node = document.createElement("div");
  node.className = "tc-usages";
  const header = document.createElement("div");
  header.className = "tc-usages-header";
  const title = document.createElement("span");
  title.innerHTML = titleHtml;
  const countEl = document.createElement("span");
  countEl.className = "tc-usages-count";
  countEl.textContent = count;
  header.append(title, countEl);
  const list = document.createElement("div");
  list.className = "tc-usages-list";
  const footer = document.createElement("div");
  footer.className = "tc-usages-footer";
  node.append(header, list, footer);

  let at = 0;
  const rowEls: HTMLElement[] = rows.map((row, i) => {
    const el = document.createElement("div");
    el.className = "tc-usages-row";
    const file = document.createElement("span");
    file.className = "tc-usages-file";
    file.textContent = row.label;
    const line = document.createElement("span");
    line.className = "tc-usages-line";
    line.textContent = String(row.line);
    const code = document.createElement("span");
    code.className = "tc-usages-code";
    code.innerHTML = row.emphasis
      ? escapeHtml(row.excerpt).replace(
          new RegExp(`\\b${escapeRegExp(row.emphasis)}\\b`),
          (m) => `<b>${m}</b>`,
        )
      : escapeHtml(row.excerpt);
    el.append(file, line, code);
    el.addEventListener("mousemove", () => select(i));
    el.addEventListener("click", () => jump(i));
    list.append(el);
    return el;
  });

  const select = (i: number): void => {
    at = Math.max(0, Math.min(i, rows.length - 1));
    rowEls.forEach((el, j) => el.classList.toggle("tc-usages-selected", j === at));
    const path = rows[at].uri.path;
    footer.textContent = root && path.startsWith(root) ? path.slice(root.length) : path;
    rowEls[at].scrollIntoView({ block: "nearest" });
  };
  const jump = (i: number): void => {
    const row = rows[i];
    close();
    if (row.uri.scheme === "file" && row.uri.path !== model?.uri.path) {
      if (openFileAt(row.uri.path, row.line, row.column)) return;
    }
    editor.setPosition({ lineNumber: row.line, column: row.column });
    editor.revealLineInCenter(row.line);
    editor.focus();
  };
  select(0);

  const widget: monaco.editor.IContentWidget = {
    getId: () => "tc.usages",
    getDomNode: () => node,
    getPosition: () => ({
      position,
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    }),
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      select(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(at - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      jump(at);
    }
  };
  window.addEventListener("keydown", onKey, true);
  const modelSub = editor.onDidChangeModel(close);
  const disposeSub = editor.onDidDispose(close);
  editor.addContentWidget(widget);
  open = {
    dispose: () => {
      window.removeEventListener("keydown", onKey, true);
      modelSub.dispose();
      disposeSub.dispose();
      editor.removeContentWidget(widget);
    },
  };
}

export async function showUsages(
  editor: monaco.editor.ICodeEditor,
  symbolName: string,
  position: monaco.IPosition,
): Promise<void> {
  close();
  const model = editor.getModel();
  if (!model) return;
  const refs = await referencesAt(model, position);
  const simpleName = symbolName.split("(")[0];
  const rows: PopupRow[] = [];
  for (const ref of (refs ?? []).slice(0, 100)) {
    const uri = monaco.Uri.parse(ref.uri);
    const target = monaco.editor.getModel(uri);
    const line = ref.range.start.line + 1;
    rows.push({
      uri,
      label: uri.path.split("/").pop() ?? "",
      line,
      column: ref.range.start.character + 1,
      excerpt: target ? target.getLineContent(line).trim() : "",
      emphasis: simpleName,
    });
  }
  if (rows.length === 0) return;
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(model.getValue())?.[1];
  const cls = model.uri.path.split("/").pop()?.replace(/\.(java|kt)$/, "") ?? "";
  showRowsPopup(
    editor,
    `<b>Method ${escapeHtml(symbolName)}</b> of ${escapeHtml(pkg ? `${pkg}.${cls}` : cls)}`,
    rows.length === 1 ? "1 usage" : `${rows.length} usages`,
    rows,
    position,
  );
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
