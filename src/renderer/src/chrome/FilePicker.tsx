import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  loadProjectFiles,
  peekProjectFiles,
  rankProjectFiles,
  recentOpenedFiles,
  type RankedFile,
} from "../lib/fileIndex";
import { looksLikeProject } from "../lib/recents";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { FileTypeIcon } from "./FileTypeIcon";
import { MatchText } from "./MatchText";
import { PickerDialog, PickerNote, pickerRowClass } from "./PickerDialog";

type Props = {
  open: boolean;
  cwd: string;
  openPaths?: string[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

export function FilePicker({
  open,
  cwd,
  openPaths = [],
  onOpenFile,
  onClose,
}: Props) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState(() => peekProjectFiles(cwd) ?? []);
  const [loading, setLoading] = useState(() => peekProjectFiles(cwd) == null);
  const [error, setError] = useState<string | null>(null);

  const recents = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const path of [...recentOpenedFiles(cwd), ...openPaths]) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [cwd, openPaths, open]);

  const results = useMemo(
    () => rankProjectFiles(files, query, recents),
    [files, query, recents],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setError(null);
    const cached = peekProjectFiles(cwd);
    if (cached) {
      setFiles(cached);
      setLoading(false);
    } else {
      setFiles([]);
      setLoading(looksLikeProject(cwd));
    }
    if (!looksLikeProject(cwd)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void loadProjectFiles(cwd, true)
      .then((next) => {
        if (cancelled) return;
        setFiles(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  useEffect(() => {
    setActive((index) =>
      results.length === 0 ? 0 : Math.min(index, results.length - 1),
    );
  }, [results.length]);

  const pick = (file: RankedFile) => {
    onOpenFile(file.path);
    onClose();
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length === 0) return;
      setActive((index) => (index + 1) % results.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setActive((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const file = results[active];
      if (file) pick(file);
      return;
    }
    if (e.key === "Tab") e.preventDefault();
  };

  const empty = emptyLabel({
    cwd,
    query,
    loading,
    error,
    fileCount: files.length,
    matchCount: results.length,
  });

  return (
    <PickerDialog
      open={open}
      label="Go to file"
      data-file-picker
      search={search}
      query={query}
      onQuery={(next) => {
        setQuery(next);
        setActive(0);
      }}
      onSearchKey={onSearchKey}
      onClose={onClose}
    >
      {empty ? (
        <PickerNote>{empty}</PickerNote>
      ) : (
        <FileList files={results} active={active} query={query} onActive={setActive} onPick={pick} />
      )}
    </PickerDialog>
  );
}

function emptyLabel({
  cwd,
  query,
  loading,
  error,
  fileCount,
  matchCount,
}: {
  cwd: string;
  query: string;
  loading: boolean;
  error: string | null;
  fileCount: number;
  matchCount: number;
}): string | null {
  if (error && fileCount === 0) return error;
  if (!looksLikeProject(cwd)) return "Open a project to search files";
  if (loading && fileCount === 0) return "Indexing files…";
  if (fileCount === 0) return "No files found";
  if (matchCount === 0) {
    return query.trim() ? "No matching files" : "Type a file name to search";
  }
  return null;
}

function FileList({
  files,
  active,
  query,
  onActive,
  onPick,
}: {
  files: RankedFile[];
  active: number;
  query: string;
  onActive: (index: number) => void;
  onPick: (file: RankedFile) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    pointer.current.allow = false;
  }, [files]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onListMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.clientX === pointer.current.x && e.clientY === pointer.current.y) {
      return;
    }
    pointer.current = { x: e.clientX, y: e.clientY, allow: true };
  };

  const onRowEnter = (index: number) => {
    if (!pointer.current.allow) return;
    fromPointer.current = true;
    onActive(index);
  };

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Files"
      onMouseMove={onListMouseMove}
      className="max-h-[min(380px,50vh)] overflow-y-auto overscroll-none"
    >
      {files.map((file, index) => {
        const highlighted = index === active;
        const slash = file.relative.lastIndexOf("/");
        const dir = slash === -1 ? "" : file.relative.slice(0, slash);
        const nameOffset = slash === -1 ? 0 : slash + 1;
        return (
          <div
            key={file.path}
            ref={highlighted ? activeRef : undefined}
            role="option"
            aria-selected={highlighted}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onRowEnter(index)}
            onClick={() => onPick(file)}
            className={pickerRowClass(highlighted)}
          >
            <span className="shrink-0">
              <FileTypeIcon name={file.name} isDir={false} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              <MatchText
                text={file.name}
                positions={file.positions
                  .filter((pos) => pos >= nameOffset)
                  .map((pos) => pos - nameOffset)}
                active={Boolean(query.trim())}
              />
            </span>
            {dir ? (
              <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
                <MatchText
                  text={dir}
                  positions={file.positions.filter((pos) => pos < slash)}
                  active={Boolean(query.trim())}
                />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
