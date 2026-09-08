import { Search } from "./icons";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import type { EditorNavigation } from "../lib/search";
import type { WorkspaceSymbolRow } from "../surfaces/monaco/lsp/providers";

/**
 * ⌘O: workspace symbols from the project's running language servers
 * (`workspaceSymbols` in surfaces/monaco/lsp/providers.ts, loaded lazily so
 * the shell stays free of the editor chunk). Queries settle for 250 ms.
 */

type Props = {
  projectId: string | null;
  onOpen: (path: string, navigation: EditorNavigation) => void;
  onClose: () => void;
};

const SETTLE_MS = 250;

// monaco.languages.SymbolKind, by ordinal; no monaco import in the shell.
const KIND_LABELS = [
  "file", "module", "namespace", "package", "class", "method", "property",
  "field", "constructor", "enum", "interface", "function", "variable",
  "constant", "string", "number", "boolean", "array", "object", "key",
  "null", "enum member", "struct", "event", "operator", "type parameter",
];

function pathOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : uri;
  } catch {
    return uri;
  }
}

export function SymbolPicker({ projectId, onOpen, onClose }: Props) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rows, setRows] = useState<WorkspaceSymbolRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    search.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!projectId || !trimmed) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void import("../surfaces/monaco/lsp/providers")
        .then(({ workspaceSymbols }) => workspaceSymbols(projectId, trimmed))
        .then((next) => {
          if (cancelled) return;
          setRows(next);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectId, query]);

  const pick = (row: WorkspaceSymbolRow) => {
    onOpen(pathOf(row.uri), {
      line: row.range.startLineNumber,
      column: row.range.startColumn,
    });
    onClose();
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : rows.length - 1;
      setActive((index) => (index + delta) % rows.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
      return;
    }
    if (e.key === "Tab") e.preventDefault();
  };

  const empty = !projectId
    ? "Open a project to search symbols"
    : !query.trim()
      ? "Type a symbol name"
      : loading && rows.length === 0
        ? "Searching…"
        : rows.length === 0
          ? "No matching symbols"
          : null;

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
      <div className="absolute inset-0" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-label="Go to Symbol"
        data-symbol-picker
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-[12%] flex w-[min(560px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-content/10 bg-content/5 glass-surface glass-surface--xl"
      >
        <div className="pb-1.5">
          <label className="flex items-center gap-2 border-b border-content/10 px-2 py-2.5 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              ref={search}
              type="text"
              value={query}
              placeholder="Go to Symbol"
              aria-label="Go to Symbol"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
            />
          </label>
        </div>
        {empty ? (
          <p className="px-3 pb-3 pt-1 text-[12px] text-content/50">{empty}</p>
        ) : (
          <SymbolList rows={rows} active={active} onActive={setActive} onPick={pick} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function SymbolList({
  rows,
  active,
  onActive,
  onPick,
}: {
  rows: WorkspaceSymbolRow[];
  active: number;
  onActive: (index: number) => void;
  onPick: (row: WorkspaceSymbolRow) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Symbols"
      className="max-h-[min(380px,50vh)] overflow-y-auto overscroll-none px-1.5 pb-1.5"
    >
      {rows.map((row, index) => {
        const highlighted = index === active;
        const path = pathOf(row.uri);
        const file = path.slice(path.lastIndexOf("/") + 1);
        return (
          <button
            key={`${row.uri}:${row.range.startLineNumber}:${row.name}:${index}`}
            ref={highlighted ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={highlighted}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onActive(index)}
            onClick={() => onPick(row)}
            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm leading-none ${
              highlighted ? "bg-content/10 text-content" : "text-content"
            }`}
          >
            <span className="w-16 shrink-0 truncate font-mono text-[10px] uppercase tracking-wide text-content/40">
              {KIND_LABELS[row.kind] ?? "symbol"}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {row.name}
              {row.containerName ? (
                <span className="text-content/40"> · {row.containerName}</span>
              ) : null}
            </span>
            <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-content/40">
              {file}:{row.range.startLineNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}
