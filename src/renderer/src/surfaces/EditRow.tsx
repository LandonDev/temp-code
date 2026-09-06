import { useEffect, useRef, useState } from "react";
import { ChevronRight, FilePlusCorner, PenLine, Trash2 } from "../chrome/icons";
import { PreviewDiffLines } from "../chrome/FilePreview";
import { TerminalSpinner } from "../chrome/TerminalSpinner";
import { resolveWorkspacePath } from "../lib/paths";
import type { OpenFileFn } from "../lib/search";
import type { Block } from "../lib/session";
import { editModel, splitPath } from "./editModel";
import { toolCallState } from "./transcriptActivity";

/**
 * A file change stands alone and loud — never folded into the quiet run of
 * tool calls. Bordered card, the file name leading (basename bold, directory
 * muted), a live verb while the call runs, then an unmissable +N / −N
 * diffstat with created and deleted states. Expands in place to the diff.
 */

/** Diffstat counts up only when we watched the change land live. */
function useCountUp(target: number, animate: boolean): number {
  const [v, setV] = useState(0);
  const cur = useRef(0);
  const raf = useRef(0);
  useEffect(() => {
    if (!animate || cur.current === target) return;
    const start = cur.current;
    const t0 = performance.now();
    const tick = (now: number): void => {
      // rAF timestamps are frame-start times and can predate t0 — clamp low.
      const p = Math.min(1, Math.max(0, (now - t0) / 550));
      const eased = 1 - Math.pow(1 - p, 3);
      cur.current = Math.round(start + (target - start) * eased);
      setV(cur.current);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, animate]);
  return animate ? v : target;
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
  const lines = block.tool?.preview?.lines ?? [];
  const hasDiff = lines.some((l) => l.kind === "add" || l.kind === "del");

  // Watched live: the counters tick up and the name fades in once known.
  const [liveAtMount] = useState(running);
  const adds = useCountUp(m.adds, liveAtMount);
  const dels = useCountUp(m.dels, liveAtMount);

  // Auto mode: the diff rides open while the edit lands and holds a beat
  // after, then folds to the row — unless the user toggled, which wins.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [holdOpen, setHoldOpen] = useState(running);
  useEffect(() => {
    if (running || !liveAtMount) return;
    const t = window.setTimeout(() => setHoldOpen(false), 800);
    return () => clearTimeout(t);
  }, [running, liveAtMount]);
  const open = hasDiff && (userOpen ?? (liveAtMount && (running || holdOpen)));

  const Icon = m.remove ? Trash2 : m.create ? FilePlusCorner : PenLine;
  const startLine = block.tool?.preview?.startLine;
  const openFile =
    filePath && onOpenFile
      ? () => onOpenFile(filePath, startLine ? { line: startLine } : undefined)
      : undefined;

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
              onClick={() => setUserOpen(!open)}
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
      <div
        className="edit-row-body grid"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="h-px bg-content/10" />
          <PreviewDiffLines lines={lines} />
        </div>
      </div>
    </div>
  );
}
