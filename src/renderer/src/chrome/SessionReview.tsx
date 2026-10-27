import { sessionStore } from "../lib/tcserver/store";
import { COMPOSER_SURFACE } from "./ComposerBar";
import { ChevronRight } from "./icons";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
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
import { confirmAction } from "./ConfirmDialog";
import { FileTypeIcon } from "./FileTypeIcon";
import { loadToast } from "./toastSync";

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
  const rootRef = useRef<HTMLDivElement>(null);

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

  const run = async (action: "keep" | "undo") => {
    if (busy || acting != null || !environmentId) return;
    const root = rootRef.current;
    // Read before the pressed button disables (which drops its focus).
    const hadFocus = !!root && root.contains(document.activeElement);
    const input = root
      ?.closest("[data-composer]")
      ?.querySelector<HTMLElement>("[data-composer-input]");
    const previous = filesRef.current.map((file) => file.path);
    if (action === "undo") {
      const one = previous.length === 1;
      const ok = await confirmAction({
        title: one
          ? `Undo ${basename(filesRef.current[0]?.relative ?? "")}?`
          : `Undo ${previous.length} files?`,
        body: one
          ? "It goes back to before this thread changed it."
          : "They go back to before this thread changed them.",
        action: "Undo",
        danger: true,
      });
      if (!ok) return;
    }
    setActing(action);
    try {
      const status =
        action === "keep"
          ? await keepSessionChanges(environmentId, sessionId)
          : await undoSessionChanges(environmentId, sessionId);
      setFiles(status.files);
      notifyGitChanged();
      invalidateWatchedFiles(previous);
      invalidateProjectFiles(cwd);
      // The strip leaves with nothing to keep; a keyboard user lands back
      // in the composer's field rather than on the page.
      if (status.files.length === 0 && hadFocus) input?.focus();
    } catch (e) {
      const description = e instanceof Error ? e.message : String(e);
      void loadToast().then((toast) =>
        toast.error(action === "undo" ? "Undo failed" : "Keep failed", {
          description,
        }),
      );
      load();
    } finally {
      setActing(null);
    }
  };

  return (
    <SessionReviewView
      files={files}
      busy={busy}
      acting={acting}
      onReview={onOpenDiff}
      rootRef={rootRef}
      onUndo={() => void run("undo")}
      onKeep={() => void run("keep")}
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
  rootRef?: Ref<HTMLDivElement>;
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
  rootRef,
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
    <div ref={rootRef} className="px-2">
      <div
        className={`flex h-8 items-center gap-1 rounded-t-xl border-b-0 px-1 ${COMPOSER_SURFACE}`}
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
