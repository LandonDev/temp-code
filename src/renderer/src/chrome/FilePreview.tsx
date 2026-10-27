import type { ReactElement } from "react";
import { Button } from "../components/ui/button";
import { MAX_PREVIEW_LINES } from "../lib/harness/preview";
import { displayPath, resolveWorkspacePath } from "../lib/paths";
import { RenderCache, cacheKey } from "../lib/renderCache";
import type { ToolPreview, ToolPreviewLine } from "../lib/session";
import { FileTypeIcon } from "./FileTypeIcon";

type Status = "pending" | "accepted" | "rejected";

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "type",
  "interface",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "class",
  "struct",
  "enum",
  "extends",
  "implements",
  "new",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "in",
  "of",
  "as",
  "is",
  "void",
  "public",
  "private",
  "protected",
  "static",
  "default",
  "package",
  "def",
  "func",
]);

type Props = {
  preview: ToolPreview;
  status: Status;
  cwd?: string;
  onOpenFile?: (path: string) => void;
};

/** The file an edit asks to change, before the person approves it: one
 *  header row (the file, its counts, "Rejected" once refused) over the
 *  diff's lines. A pending edit says nothing; the approval under it does. */
export function FilePreview({ preview, status, cwd, onOpenFile }: Props) {
  const path = preview.path;
  const filePath = path ? (resolveWorkspacePath(path, cwd) ?? path) : undefined;
  const fileName = preview.fileName || fileNameOf(path);
  const lines = (preview.lines ?? [])
    .filter(
      (line) =>
        line.kind === "add" || line.kind === "del" || line.kind === "context",
    )
    .slice(0, MAX_PREVIEW_LINES);
  const showDiff = lines.some(
    (line) => line.kind === "add" || line.kind === "del",
  );
  const added = preview.additions ?? 0;
  const deleted = preview.deletions ?? 0;
  const label = path
    ? displayPath(path, cwd)
    : fileName || preview.title || "File";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex h-9 items-center gap-2 px-3">
        <FileTypeIcon name={fileName || "file"} isDir={false} size={14} />
        {filePath && onOpenFile ? (
          <Button
            variant="link"
            className="h-auto min-w-0 shrink justify-start p-0 font-mono text-[12px] font-normal"
            onClick={() => onOpenFile(filePath)}
          >
            <span className="truncate">{label}</span>
          </Button>
        ) : (
          <span className="min-w-0 truncate font-mono text-[12px] text-foreground">
            {label}
          </span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
          {added > 0 ? <span className="text-success">+{added}</span> : null}
          {deleted > 0 ? (
            <span className="text-destructive">−{deleted}</span>
          ) : null}
          {status === "rejected" ? (
            <span className="font-sans text-muted-foreground">Rejected</span>
          ) : null}
        </span>
      </div>
      {showDiff ? (
        <div className="border-t border-border">
          <PreviewDiffLines lines={lines} />
        </div>
      ) : null}
    </div>
  );
}

/** Add, delete, and context rows of a preview, capped at the preview limit. */
export function PreviewDiffLines({ lines }: { lines: ToolPreviewLine[] }) {
  const shown = lines
    .filter(
      (line) =>
        line.kind === "add" || line.kind === "del" || line.kind === "context",
    )
    .slice(0, MAX_PREVIEW_LINES);
  return (
    <div>
      {shown.map((line, index) => (
        <DiffLine
          key={`${line.number ?? index}-${line.kind}-${index}`}
          number={line.number}
          kind={line.kind === "context" ? "ctx" : line.kind === "add" ? "add" : "del"}
          text={line.text}
        />
      ))}
    </div>
  );
}

export type DiffLineKind = "add" | "del" | "ctx";

const LINE_TINT: Record<DiffLineKind, string> = {
  add: "bg-success/10",
  del: "bg-destructive/10",
  ctx: "",
};

const LINE_MARK: Record<DiffLineKind, { mark: string; tone: string }> = {
  add: { mark: "+", tone: "text-success" },
  del: { mark: "−", tone: "text-destructive" },
  ctx: { mark: " ", tone: "" },
};

/** One line of a diff, the transcript's and the approval preview's: the
 *  number, the mark, the code; added and removed lines tinted, no bar. With
 *  `onClick` the line opens the editor there. */
export function DiffLine({
  number,
  kind,
  text,
  onClick,
}: {
  number?: number;
  kind: DiffLineKind;
  text: string;
  onClick?: () => void;
}) {
  const { mark, tone } = LINE_MARK[kind];
  return (
    <div
      data-diff-line={kind}
      className={`group/line flex items-baseline ${LINE_TINT[kind]}${onClick ? " cursor-pointer" : ""}`}
      onClick={onClick}
    >
      <span
        className={`w-7 shrink-0 select-none pr-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground${onClick ? " group-hover/line:text-foreground" : ""}`}
      >
        {number ?? ""}
      </span>
      <span className={`w-3 shrink-0 select-none text-center font-mono text-[11px] font-medium ${tone}`}>
        {mark}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap pr-2 font-mono text-[11px] leading-[18px] [overflow-wrap:anywhere]">
        {highlightCode(text, kind === "ctx")}
      </span>
    </div>
  );
}

/** One highlighted line per distinct text: elements are immutable, so a
 *  remounted diff or preview reuses them instead of re-tokenizing. */
const lineCache = new RenderCache<ReactElement>(20_000, 4_000_000);

export function highlightCode(text: string, dimmed: boolean): ReactElement {
  const key = cacheKey(dimmed ? "d" : "n", text);
  const hit = lineCache.get(key);
  if (hit) return hit;
  const el = tokenizeLine(text, dimmed);
  lineCache.set(key, el, text.length);
  return el;
}

/** Code tints are neutral by weight, so green and red mean only added and
 *  removed lines: keywords in foreground, the rest muted, comments faint. */
function tokenizeLine(text: string, dimmed: boolean): ReactElement {
  const dim = dimmed ? "opacity-70" : "";
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("///") ||
    trimmed.startsWith("#")
  ) {
    return <span className={`text-muted-foreground/60 ${dim}`}>{text}</span>;
  }

  const parts: { text: string; keyword: boolean }[] = [];
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index), keyword: false });
    }
    const token = match[1];
    parts.push({ text: token, keyword: KEYWORDS.has(token) });
    last = match.index + token.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), keyword: false });

  return (
    <span className={`text-muted-foreground ${dim}`}>
      {parts.map((part, index) =>
        part.keyword ? (
          <span key={index} className="text-foreground">
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function fileNameOf(path?: string): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1];
}
