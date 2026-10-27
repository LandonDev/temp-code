import { useCallback, useEffect, useRef, useState } from "react";
import { emptyNotes, notesAsBrief, notesEmpty } from "@shared/notes";
import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { Check, Copy, Pencil } from "../../chrome/icons";
import type { Session } from "../../lib/session";
import { saveNotes, useThreadNotes } from "../../lib/threadNotes";
import { AgentMarkdown, MarkdownSourceHighlight } from "../AgentMarkdown";
import { timeAgo } from "../../lib/duration";
import { SwapIcon } from "../../motion/IconSwap";
import { IconAction } from "../transcript/IconAction";

const SAVE_DEBOUNCE_MS = 700;
/** How long the copy button shows its check. */
const COPIED_MS = 1400;

type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * The thread's working notes: the right panel's Notes section
 * (surfaces/RightPanel.tsx). What the thread keeps for its next window and
 * its successors (src/main/server/threadNotes.ts), rendered live from the
 * `notes` push. The person edits the whole text in place (the pencil, then
 * Done); each save lands in the file the harness reads on its next tool
 * call. "Copy as brief" turns the notes into the first message of a new
 * thread.
 */
export function NotesBody({ session }: { session: Session }) {
  const doc = useThreadNotes(session.environmentId, session.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState<SaveState>("idle");
  // The text the edit began from; a push past it means the thread wrote
  // while the person typed.
  const baseRef = useRef<string>("");
  const dirtyRef = useRef(false);
  const draftRef = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteChanged = editing && !!doc && doc.text !== baseRef.current;

  const persist = useCallback(
    async (text: string): Promise<void> => {
      setSaving("saving");
      try {
        const saved = await saveNotes(session.environmentId, session.id, text);
        baseRef.current = saved.text;
        dirtyRef.current = false;
        setSaving("saved");
      } catch {
        setSaving("failed");
      }
    },
    [session.environmentId, session.id],
  );

  const beginEdit = (): void => {
    const text = doc?.text && doc.text.trim() ? doc.text : emptyNotes();
    baseRef.current = doc?.text ?? "";
    dirtyRef.current = false;
    setDraft(text);
    setSaving("idle");
    setEditing(true);
  };

  const onChange = (text: string): void => {
    setDraft(text);
    draftRef.current = text;
    dirtyRef.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(text), SAVE_DEBOUNCE_MS);
  };

  const finishEdit = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (dirtyRef.current) void persist(draft);
    setEditing(false);
  };

  const reload = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    baseRef.current = doc?.text ?? "";
    dirtyRef.current = false;
    setDraft(doc?.text ?? emptyNotes());
  };

  // Leaving the body (another section, the panel closing, a thread switch)
  // lands an unsaved draft at once instead of dropping its pending save.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (dirtyRef.current) void persist(draftRef.current);
    };
  }, [persist]);
  const [sawId, setSawId] = useState(session.id);
  if (sawId !== session.id) {
    setSawId(session.id);
    setEditing(false);
    setSaving("idle");
  }

  return (
    <NotesView
      loading={doc === undefined}
      text={doc?.text ?? ""}
      updatedAt={doc?.updatedAt ?? null}
      saving={saving}
      editing={editing}
      draft={draft}
      remoteChanged={remoteChanged}
      title={session.title}
      cwd={session.cwd}
      onEdit={beginEdit}
      onDone={finishEdit}
      onChange={onChange}
      onLoadTheirs={reload}
    />
  );
}

/** The state line's words: a save in flight or failed wins over the age. */
export function notesStateLine(saving: SaveState, updatedAt: number | null): string | null {
  if (saving === "saving") return "Saving…";
  if (saving === "failed") return "Not saved";
  if (!updatedAt) return null;
  const ago = timeAgo(updatedAt);
  return ago === "now" ? "Updated just now" : `Updated ${ago} ago`;
}

/** The Notes section given its data (NotesBody; tests; ui:preview fixtures). */
export function NotesView({
  loading,
  text,
  updatedAt,
  saving,
  editing,
  draft,
  remoteChanged,
  title,
  cwd,
  onEdit,
  onDone,
  onChange,
  onLoadTheirs,
}: {
  loading: boolean;
  text: string;
  updatedAt: number | null;
  saving: SaveState;
  editing: boolean;
  draft: string;
  remoteChanged: boolean;
  title: string;
  cwd?: string;
  onEdit: () => void;
  onDone: () => void;
  onChange: (text: string) => void;
  onLoadTheirs: () => void;
}) {
  const has = text.trim().length > 0 && !notesEmpty(text);
  const state = loading ? null : notesStateLine(saving, updatedAt);

  if (!loading && !has && !editing) {
    return (
      <Empty className="p-6">
        <EmptyHeader>
          <EmptyTitle>No notes yet</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Start the notes
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col" data-slot="notes-section">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 pr-2 pl-3">
          <span className={cn("truncate text-xs tabular-nums", saving === "failed" ? "text-destructive" : "text-muted-foreground")}>{state}</span>
          {loading ? null : (
            <div className="flex items-center gap-0.5">
              {has || editing ? <CopyBrief text={editing ? draft : text} title={title} /> : null}
              {editing ? (
                <Button variant="ghost" size="sm" onClick={onDone}>
                  Done
                </Button>
              ) : (
                <IconAction label="Edit notes" onClick={onEdit}>
                  <Pencil className="size-3.5" />
                </IconAction>
              )}
            </div>
          )}
        </div>
        {loading ? (
          <div className="flex flex-col gap-2.5 px-3 py-2" aria-busy="true" aria-label="Loading notes">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        ) : editing ? (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-3 py-2">
                <NotesSource value={draft} onChange={onChange} onDone={onDone} />
              </div>
            </ScrollArea>
            {remoteChanged ? (
              <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">The thread updated the notes</span>
                <Button variant="link" size="sm" className="h-auto shrink-0 px-0 text-xs" onClick={onLoadTheirs}>
                  Load theirs
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-3 py-2 select-text">
              <AgentMarkdown text={text} cwd={cwd} size="compact" />
            </div>
          </ScrollArea>
        )}
      </div>
    </TooltipProvider>
  );
}

/** Copies the notes as the first message of a new thread; the icon swaps to a check for a beat. */
function CopyBrief({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <IconAction
      label="Copy as brief"
      onClick={() => {
        void navigator.clipboard.writeText(notesAsBrief(text, title)).then(
          () => setDone(true),
          () => setDone(false),
        );
      }}
    >
      <SwapIcon swapped={done} from={<Copy className="size-3.5" />} to={<Check className="size-3.5 text-success" />} />
    </IconAction>
  );
}

/** The source editor: a textarea over a highlighted mirror of the same
 *  lines, so headings read as headings while typing (the notebook's recipe,
 *  without its gutter). Escape is Done. */
function NotesSource({ value, onChange, onDone }: { value: string; onChange: (value: string) => void; onDone: () => void }) {
  const lines = value.split("\n");
  return (
    <div className="relative min-h-full">
      <div aria-hidden className="pointer-events-none font-mono text-[13px] leading-5 text-foreground">
        {lines.map((line, index) => (
          <div key={index} className="min-h-5 whitespace-pre-wrap wrap-break-word">
            {line ? <MarkdownSourceHighlight text={line} /> : " "}
          </div>
        ))}
      </div>
      <textarea
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onDone();
        }}
        spellCheck={false}
        aria-label="Notes source"
        className="markdown-source-field absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-mono text-[13px] leading-5 whitespace-pre-wrap wrap-break-word outline-none"
      />
    </div>
  );
}
