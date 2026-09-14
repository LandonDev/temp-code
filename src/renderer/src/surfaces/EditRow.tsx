import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { ChevronRight, FilePlusCorner, PenLine, Trash2 } from "../chrome/icons";
import { TerminalSpinner } from "../chrome/TerminalSpinner";
import { usePaneVisible } from "../hooks/paneVisibility";
import { readTextFile } from "../lib/fs";
import { resolveWorkspacePath } from "../lib/paths";
import type { OpenFileFn } from "../lib/search";
import type { Block } from "../lib/session";
import { useLiveEdits } from "../lib/tcserver/store";
import { TweenHeight, useCountUp } from "../motion";
import { DiffBody } from "./DiffBody";
import {
  addRanges,
  editDiff,
  locateHunks,
  parseUnifiedDiff,
  previewToRows,
  revealDuration,
  rowsFromHunks,
  type DiffRow,
  type EditDiff,
} from "./diffRows";
import { RenderCache, cacheKey } from "../lib/renderCache";
import { editModel, splitPath } from "./editModel";
import { editOpenKey, usePersistedOpen } from "./editOpenState";
import { toolCallState } from "./transcriptActivity";
import { useTranscriptSession } from "./transcriptSession";
import { MatrixSpinner } from "./threads/bits";

const InlineEditor = lazy(() => import("./monaco/InlineEditor"));

/**
 * A file change stands alone and loud — never folded into the quiet run of
 * tool calls. Bordered card, the file name leading (basename bold, directory
 * muted), a live verb while the call runs, then an unmissable +N / −N
 * diffstat with created and deleted states. Expands in place to the diff:
 * rides open while the edit lands, pours the rows in, holds a beat, folds.
 * A click on a numbered row swaps the diff for the editor at that line.
 */

/** The rows to show: the tool input's hunks located in the landed file
 *  once the call settles (and again after an inline save), the source's
 *  own numbering when it has one, else the server preview. */
/** Parsed diffs by their settled input object: the store keeps a block's
 *  input across remounts, so a second mount never re-splits the patch. */
const diffByInput = new WeakMap<object, EditDiff>();
/** Located rows by block and file, so a remount skips the file read. The
 *  stored input guards against a block whose input was replaced. */
const locatedCache = new RenderCache<{ input: unknown; rows: DiffRow[] }>(2000, 8_000_000);

function cachedEditDiff(block: Block): EditDiff {
  const input = block.tool?.input;
  if (!input || typeof input !== "object" || block.streaming) return editDiff(block);
  const hit = diffByInput.get(input);
  if (hit) return hit;
  const diff = editDiff(block);
  diffByInput.set(input, diff);
  return diff;
}

/** Rows straight from the call: numbered when the source numbers them,
 *  else in hunk order, else the server's preview. */
function useParsedDiff(block: Block): { diff: EditDiff; rows: DiffRow[] } {
  const input = block.tool?.input;
  const name = block.tool?.name;
  const preview = block.tool?.preview?.lines;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const diff = useMemo(() => cachedEditDiff(block), [input, name]);
  const rows = useMemo(() => {
    if (diff.rows) return diff.rows;
    if (diff.hunks.length > 0) return rowsFromHunks(diff.hunks);
    return previewToRows(preview ?? []);
  }, [diff, preview]);
  return { diff, rows };
}

/** The hunks located in the landed file (their line numbers), read once
 *  the call settles and the body is wanted — a collapsed row never reads
 *  its file — and again after an inline save. Null until located. */
function useLocatedRows(
  block: Block,
  diff: EditDiff,
  filePath: string | undefined,
  settled: boolean,
  refresh: number,
  wanted: boolean,
): DiffRow[] | null {
  const input = block.tool?.input;
  const locatedKey = filePath ? cacheKey(block.id, filePath) : undefined;
  const [located, setLocated] = useState<{ gen: number; rows: DiffRow[] } | null>(() => {
    const hit = locatedKey ? locatedCache.get(locatedKey) : undefined;
    return hit && hit.input === input ? { gen: 0, rows: hit.rows } : null;
  });
  const wantsLocate =
    wanted &&
    diff.hunks.length > 0 &&
    settled &&
    !!filePath &&
    (!diff.rows || refresh > 0) &&
    !(located && refresh === 0);
  useEffect(() => {
    if (!wantsLocate || !filePath) return;
    let alive = true;
    readTextFile(filePath)
      .then((content) => {
        if (!alive) return;
        const rows = locateHunks(diff.hunks, content);
        setLocated({ gen: refresh, rows });
        if (locatedKey) locatedCache.set(locatedKey, { input, rows }, rows.length * 40);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsLocate, filePath, refresh, diff]);
  return useMemo(() => {
    if (located && (refresh > 0 ? located.gen === refresh : true)) {
      if (refresh > 0 || !diff.rows) return located.rows;
    }
    return null;
  }, [located, refresh, diff]);
}

export function EditRow({
  block,
  cwd,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const m = editModel(block);
  const state = toolCallState(block);
  const running = state === "pending";
  const failed = state === "rejected";
  const { name, dir } = splitPath(m.path, cwd);
  const filePath = m.path ? resolveWorkspacePath(m.path, cwd) : undefined;
  const sessionId = useTranscriptSession();
  const reduce = useReducedMotion();

  // Editing in place: which line the editor opens at, and a bump after a
  // save so the diff re-locates in the file as it is now.
  const [editMode, setEditMode] = useState(false);
  const [editLine, setEditLine] = useState<number | undefined>();
  const [refresh, setRefresh] = useState(0);
  const { diff, rows: parsedRows } = useParsedDiff(block);

  // While the edit streams, the server's live diff for this file leads.
  const liveEdits = useLiveEdits(sessionId ?? "");
  const liveRec = useMemo(() => {
    if (!running || !m.path) return undefined;
    const rel = m.path;
    return (
      liveEdits[rel] ??
      Object.values(liveEdits).find(
        (r) => rel.endsWith("/" + r.path) || r.path.endsWith("/" + rel),
      )
    );
  }, [running, m.path, liveEdits]);
  const liveRows = useMemo(
    () =>
      liveRec?.diff ? parseUnifiedDiff(liveRec.diff, liveRec.kind === "created").rows ?? null : null,
    [liveRec],
  );
  const hasDiff = (running && liveRows ? liveRows : parsedRows).some(
    (r) => r.type === "add" || r.type === "del",
  );

  // Watched live: the counters tick up and the name fades in once known.
  const [liveAtMount] = useState(running);
  const adds = useCountUp(running ? (liveRec?.adds ?? m.adds) : m.adds, liveAtMount);
  const dels = useCountUp(running ? (liveRec?.dels ?? m.dels) : m.dels, liveAtMount);

  // Auto mode: the diff rides open while the edit lands, pours its rows in
  // once settled, holds a beat, then folds — unless the user toggled, which
  // wins and is remembered per session and call.
  const [userOpen, setUserOpen] = usePersistedOpen(editOpenKey(sessionId, block));
  const [holdOpen, setHoldOpen] = useState(running);
  const [revealed, setRevealed] = useState<number | null>(null);
  const open = hasDiff && (editMode || (userOpen ?? (liveAtMount && (running || holdOpen))));
  // The file read that numbers the hunks waits until the body is wanted.
  const located = useLocatedRows(block, diff, filePath, !running, refresh, open);
  const rows = located ?? parsedRows;
  const shownRows = running && liveRows ? liveRows : rows;
  const rowCount = rows.length;
  const paneShown = usePaneVisible();
  useEffect(() => {
    if (running || !liveAtMount) return;
    if (reduce || !paneShown || rowCount === 0) {
      const t = window.setTimeout(() => setHoldOpen(false), 800);
      return () => clearTimeout(t);
    }
    const dur = revealDuration(rowCount);
    const t0 = performance.now();
    let raf = 0;
    let hold = 0;
    const tick = (now: number): void => {
      const p = Math.min(1, Math.max(0, (now - t0) / dur));
      setRevealed(Math.max(1, Math.round(p * rowCount)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        setRevealed(null);
        hold = window.setTimeout(() => setHoldOpen(false), 800);
      }
    };
    setRevealed(1);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hold);
      setRevealed(null);
    };
  }, [running, liveAtMount, rowCount, reduce, paneShown]);

  const Icon = m.remove ? Trash2 : m.create ? FilePlusCorner : PenLine;
  const startLine = block.tool?.preview?.startLine;
  const openFile =
    filePath && onOpenFile
      ? () => onOpenFile(filePath, startLine ? { line: startLine } : undefined)
      : undefined;
  const canEdit = !!filePath && !!cwd && !running && !m.remove;
  const editHere = (line?: number): void => {
    setEditLine(line ?? startLine);
    setEditMode(true);
    setUserOpen(true);
  };
  const smallButton =
    "absolute right-2 top-1 z-10 rounded-[5px] bg-content/8 px-1.5 py-0.5 text-[10px] text-content/60 hover:text-content";

  return (
    <div
      className={`edit-row overflow-hidden rounded-[10px] border bg-content/6 ${
        failed ? "border-danger/30" : "border-content/10"
      } ${liveAtMount ? "z-fade-in" : ""}`}
    >
      <div className="flex h-9 min-w-0 items-center gap-2.5 px-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-content/10 text-content/80">
          {running ? (
            <TerminalSpinner className="inline-block w-3.5 select-none text-center text-[11px] leading-none text-content/70" />
          ) : (
            <Icon className="size-3.5" strokeWidth={1.75} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px]">
          {running ? (
            <span className="shrink-0 text-content/55">{m.verb}</span>
          ) : null}
          {name ? (
            <button
              type="button"
              title={m.path}
              onClick={openFile}
              className={`min-w-0 truncate text-left ${
                openFile ? "cursor-pointer hover:underline" : "cursor-default"
              } ${running ? "z-fade-quick" : ""}`}
            >
              <span
                className={`font-medium ${
                  failed ? "text-danger" : m.remove ? "text-content/70 line-through" : "text-content"
                }`}
              >
                {name}
              </span>
              {dir ? (
                <span className="ml-1.5 text-xs text-content/45">{dir}</span>
              ) : null}
              {m.extraPaths.length > 0 ? (
                <span className="ml-1.5 text-xs text-content/45">
                  +{m.extraPaths.length} more
                </span>
              ) : null}
            </button>
          ) : null}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {failed ? (
            <span className="text-xs font-medium text-danger">failed</span>
          ) : m.remove ? (
            <span className="text-xs font-medium text-danger/80">deleted</span>
          ) : adds > 0 || dels > 0 ? (
            <span className="text-xs font-semibold tracking-tight tabular-nums">
              {adds > 0 ? <span className="text-success">+{adds}</span> : null}
              {adds > 0 && dels > 0 ? " " : null}
              {dels > 0 ? <span className="text-danger">−{dels}</span> : null}
            </span>
          ) : null}
          {hasDiff ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide diff" : "Show diff"}
              onClick={() => {
                if (open) setEditMode(false);
                setUserOpen(!open);
              }}
              className="flex size-[18px] items-center justify-center rounded-[5px] bg-content/8 text-content/60 hover:text-content"
            >
              <ChevronRight
                className={`size-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
                strokeWidth={1.75}
              />
            </button>
          ) : null}
        </span>
      </div>
      <TweenHeight open={open} animate={!reduce}>
        <div className="relative border-t border-content/10">
          {editMode && filePath && cwd ? (
            <>
              <button type="button" onClick={() => setEditMode(false)} className={smallButton}>
                diff
              </button>
              <Suspense
                fallback={
                  <div className="flex h-80 items-center justify-center">
                    <MatrixSpinner />
                  </div>
                }
              >
                <InlineEditor
                  path={filePath}
                  cwd={cwd}
                  line={editLine}
                  highlight={addRanges(rows)}
                  onSave={() => {
                    setEditMode(false);
                    setRefresh((n) => n + 1);
                  }}
                />
              </Suspense>
            </>
          ) : (
            <>
              {canEdit ? (
                <button type="button" onClick={() => editHere()} className={smallButton}>
                  edit
                </button>
              ) : null}
              <DiffBody
                rows={shownRows}
                visible={revealed ?? undefined}
                onEditAt={canEdit ? editHere : undefined}
              />
            </>
          )}
        </div>
      </TweenHeight>
    </div>
  );
}
