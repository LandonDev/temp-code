import { useCallback, useEffect, useRef, useState } from "react";
import { emptyNotes, notesAsBrief, notesEmpty } from "@shared/notes";
import { Check, Copy, Pencil } from "../../chrome/icons";
import type { Session } from "../../lib/session";
import { saveNotes, useThreadNotes } from "../../lib/threadNotes";
import { AgentMarkdown, MarkdownSourceHighlight } from "../AgentMarkdown";
import { timeAgo } from "./bits";

const SAVE_DEBOUNCE_MS = 700;

/**
 * The thread's working notes: the right panel's Notes section
 * (surfaces/RightPanel.tsx). What the thread keeps for its next window and
 * its successors (src/main/server/threadNotes.ts), rendered live from the
 * `notes` push. The person edits the whole text; each save lands in the
 * file the harness reads on its next tool call. "Copy as brief" turns the
 * notes into the first message of a new thread.
 */
export function NotesBody({ session }: { session: Session }) {
  const doc = useThreadNotes(session.environmentId, session.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed">("idle");
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

  const text = doc?.text ?? "";
  const has = text.trim().length > 0 && !notesEmpty(text);
  const detail =
    saving === "saving"
      ? "saving…"
      : saving === "failed"
        ? "not saved"
        : doc?.updatedAt
          ? `updated ${timeAgo(doc.updatedAt)}`
          : null;

  return (
    <>
      <div className="flex h-8 shrink-0 items-center justify-between pr-1.5 pl-3">
        <span className="truncate text-[11px] tabular-nums text-muted-foreground">{detail}</span>
        <div className="flex items-center gap-0.5">
          {has || editing ? <CopyBrief text={editing ? draft : text} title={session.title} /> : null}
          <button
            type="button"
            onClick={editing ? finishEdit : beginEdit}
            title={editing ? "Done editing" : "Edit notes"}
            aria-label={editing ? "Done editing" : "Edit notes"}
            aria-pressed={editing}
            className={`pressable grid size-6 place-items-center rounded-md hover:bg-content/5 hover:text-content ${editing ? "text-content" : "text-content/50"}`}
          >
            {editing ? <Check className="size-3.5" strokeWidth={2} /> : <Pencil className="size-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <NotesSource value={draft} onChange={onChange} />
          </div>
          {remoteChanged ? (
            <div className="flex shrink-0 items-center gap-2 border-t border-content/10 px-4 py-2 text-[12px] text-content/50">
              <span className="min-w-0 flex-1 truncate">The thread updated the notes while you edited.</span>
              <button type="button" onClick={reload} className="pressable shrink-0 rounded-md px-1.5 py-0.5 hover:bg-content/5 hover:text-content">
                Load theirs
              </button>
            </div>
          ) : null}
        </div>
      ) : has ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 select-text">
          <AgentMarkdown text={text} cwd={session.cwd} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
          <p className="text-[13px] leading-snug text-content/50">
            {doc === undefined
              ? "Loading notes…"
              : "The thread keeps its working notes here as it goes: goal, decisions, state, pointers, open questions. They outlive a context compaction and seed any thread started from this one."}
          </p>
          {doc !== undefined ? (
            <button
              type="button"
              onClick={beginEdit}
              className="pressable mt-3 self-start rounded-md border border-content/10 px-2 py-1 text-[12px] font-medium text-content/70 hover:bg-content/5 hover:text-content"
            >
              Start the notes
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

/** Copies the notes as the first message of a new thread; the icon swaps to a check for a beat. */
function CopyBrief({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      title="Copy as brief"
      aria-label="Copy as brief"
      onClick={() => {
        void navigator.clipboard.writeText(notesAsBrief(text, title)).then(
          () => setDone(true),
          () => setDone(false),
        );
      }}
      className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
    >
      {done ? <Check className="size-3.5 text-success" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    </button>
  );
}

/** The source editor: a textarea over a highlighted mirror of the same
 *  lines, so headings read as headings while typing (the notebook's recipe,
 *  without its gutter). */
function NotesSource({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const lines = value.split("\n");
  return (
    <div className="relative min-h-full">
      <div aria-hidden className="pointer-events-none font-mono text-[13px] leading-5 text-content">
        {lines.map((line, index) => (
          <div key={index} className="min-h-5 whitespace-pre-wrap wrap-break-word">
            {line ? <MarkdownSourceHighlight text={line} /> : " "}
          </div>
        ))}
      </div>
      <textarea
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label="Notes source"
        className="markdown-source-field absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-mono text-[13px] leading-5 whitespace-pre-wrap wrap-break-word outline-none"
      />
    </div>
  );
}
