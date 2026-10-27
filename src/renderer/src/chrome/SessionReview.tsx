import { sessionStore } from "../lib/tcserver/store";
import { ChevronRight } from "./icons";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  keepSessionChanges,
  sessionCheckpointStatus,
  subscribeCheckpointChanged,
  undoSessionChanges,
  type CheckpointFile,
} from "../lib/checkpoint";
import { invalidateProjectFiles } from "../lib/fileIndex";
import { invalidateWatchedFiles } from "../lib/fileWatch";
import { basename, notifyGitChanged, subscribeGitChanged } from "../lib/fs";
import { Counts } from "../surfaces/transcript/Counts";
import { FileTypeIcon } from "./FileTypeIcon";

export const STATUS_DEBOUNCE_MS = 500;

type Props = {
  sessionId: string;
  cwd: string;
  enabled?: boolean;
  busy?: boolean;
  onOpenDiff: (path?: string) => void;
};

export function SessionReview({
  sessionId,
  cwd,
  enabled = true,
  busy = false,
  onOpenDiff,
}: Props) {
  const environmentId = sessionStore.environmentOf(sessionId);
  const [files, setFiles] = useState<CheckpointFile[]>([]);
  const [acting, setActing] = useState<"keep" | "undo" | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const load = useCallback(() => {
    if (!environmentId || !cwd || cwd === "~") {
      setFiles([]);
      return;
    }
    void sessionCheckpointStatus(environmentId, sessionId)
      .then((status) => setFiles(status.files))
      .catch(() => setFiles([]));
  }, [environmentId, sessionId, cwd]);

  useEffect(() => {
    if (!enabled || busy) return;
    // One trailing status per burst: a settle, the host's checkpoint-changed
    // and the git-changed signals it sets off all land within the window,
    // and each status is a git child on the host's review lane.
    let timer: number | null = null;
    const schedule = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        load();
      }, STATUS_DEBOUNCE_MS);
    };
    schedule();
    const unsubReview = subscribeCheckpointChanged((id) => {
      if (id === sessionId) schedule();
    });
    const unsubGit = subscribeGitChanged(() => {
      if (filesRef.current.length > 0) schedule();
    }, cwd);
    const onResume = () => {
      if (filesRef.current.length > 0) schedule();
    };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      unsubReview();
      unsubGit();
    };
  }, [enabled, load, sessionId, busy]);

  if (files.length === 0) return null;

  const run = (action: "keep" | "undo") => {
    if (busy || acting != null || !environmentId) return;
    setActing(action);
    const op =
      action === "keep"
        ? keepSessionChanges(environmentId, sessionId)
        : undoSessionChanges(environmentId, sessionId);
    const previous = filesRef.current.map((file) => file.path);
    void op
      .then((status) => {
        setFiles(status.files);
        notifyGitChanged();
        invalidateWatchedFiles(previous);
        invalidateProjectFiles(cwd);
      })
      .catch(() => load())
      .finally(() => setActing(null));
  };

  return (
    <SessionReviewView
      files={files}
      busy={busy}
      acting={acting}
      onReview={onOpenDiff}
      onUndo={() => run("undo")}
      onKeep={() => run("keep")}
    />
  );
}

type ViewProps = {
  files: CheckpointFile[];
  busy: boolean;
  acting: "undo" | "keep" | null;
  onReview: (path?: string) => void;
  onUndo: () => void;
  onKeep: () => void;
};

/** The strip on the composer's top edge: what the thread changed since the
 *  last Keep, as a name or a file count with its line counts (opening the
 *  diff pane), then Undo and Keep. Nothing while there is nothing to keep. */
export function SessionReviewView({
  files,
  busy,
  acting,
  onReview,
  onUndo,
  onKeep,
}: ViewProps) {
  const first = files[0];
  if (!first) return null;
  const one = files.length === 1;
  const name = basename(first.relative);
  const adds = files.reduce((sum, file) => sum + file.additions, 0);
  const dels = files.reduce((sum, file) => sum + file.deletions, 0);
  const label = one ? name : `${files.length} files`;
  const disabled = busy || acting != null;
  return (
    <div className="px-2">
      <div
        className="flex h-8 items-center gap-1 rounded-t-lg border border-b-0 border-border bg-card px-1"
        data-session-review
      >
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Review changes: ${label}`}
          onClick={() => (one ? onReview(first.path) : onReview())}
          className="min-w-0 flex-1 justify-start gap-1.5 font-normal"
        >
          {one ? (
            <>
              {/* The icon pack writes its own `title`; no tooltip here. */}
              <span aria-hidden className="pointer-events-none flex">
                <FileTypeIcon name={name} isDir={false} size={14} />
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
                {name}
              </span>
            </>
          ) : (
            <span className="truncate text-[12px] text-muted-foreground">
              {label}
            </span>
          )}
          <Counts added={adds} removed={dels} />
          <ChevronRight className="size-3 text-muted-foreground" />
        </Button>
        <StripAction
          word="Undo"
          running={acting === "undo"}
          disabled={disabled}
          onClick={onUndo}
        />
        <StripAction
          word="Keep"
          running={acting === "keep"}
          disabled={disabled}
          onClick={onKeep}
        />
      </div>
    </div>
  );
}

function StripAction({
  word,
  running,
  disabled,
  onClick,
}: {
  word: string;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={disabled}
      aria-busy={running || undefined}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground"
    >
      {running ? <Spinner aria-hidden className="size-3" /> : null}
      {word}
    </Button>
  );
}
