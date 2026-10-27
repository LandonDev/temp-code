import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import type { EditorNavigation } from "../lib/search";
import type { WorkspaceSymbolRow } from "../surfaces/monaco/lsp/providers";
import { PickerDialog, PickerNote, pickerRowClass } from "./PickerDialog";

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

  return (
    <PickerDialog
      label="Go to Symbol"
      data-symbol-picker
      search={search}
      query={query}
      onQuery={(next) => {
        setQuery(next);
        setActive(0);
      }}
      onSearchKey={onSearchKey}
      onClose={onClose}
    >
      {empty ? <PickerNote>{empty}</PickerNote> : <SymbolList rows={rows} active={active} onActive={setActive} onPick={pick} />}
    </PickerDialog>
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
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Symbols"
      className="max-h-[min(380px,50vh)] overflow-y-auto overscroll-none"
    >
      {rows.map((row, index) => {
        const highlighted = index === active;
        const path = pathOf(row.uri);
        const file = path.slice(path.lastIndexOf("/") + 1);
        return (
          <div
            key={`${row.uri}:${row.range.startLineNumber}:${row.name}:${index}`}
            ref={highlighted ? activeRef : undefined}
            role="option"
            aria-selected={highlighted}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onActive(index)}
            onClick={() => onPick(row)}
            className={pickerRowClass(highlighted)}
          >
            <span className="w-16 shrink-0 truncate text-[11px] text-muted-foreground">
              {KIND_LABELS[row.kind] ?? "symbol"}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {row.name}
              {row.containerName ? (
                <span className="ms-2 text-muted-foreground">{row.containerName}</span>
              ) : null}
            </span>
            <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
              {file}:{row.range.startLineNumber}
            </span>
          </div>
        );
      })}
    </div>
  );
}
