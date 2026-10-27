import { useLayoutEffect, useRef, useState } from "react";
import type { FileNote } from "../lib/layout";
import { openWithEditor } from "../lib/native";
import { Alert, AlertDescription, type AlertTone } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

/** A read-only note is a preview the app chose (lib/openInEditor.ts); a
 *  note on a writable file is a launcher that failed and fell back to the
 *  app's editor. A failed action is an error either way. */
export function noteTone(_note: FileNote, readOnly: boolean, failed: boolean): AlertTone {
  return failed || !readOnly ? "error" : "info";
}

/**
 * The line above a file the app shows instead of handing it to the
 * editor (lib/openInEditor.ts): why ("Mac copy differs: on branch X
 * here"), whether it is read-only, and the one way out ("Open the Mac copy
 * anyway"). A standing note, so `status`, not `alert`.
 */
export function FileNoteBar({ note, readOnly = false }: { note: FileNote; readOnly?: boolean }) {
  const [failure, setFailure] = useState<string | null>(null);
  const action = note.action;
  const text = failure ? `Couldn’t open: ${failure}` : note.text;
  const run = () => {
    if (!action) return;
    setFailure(null);
    openWithEditor(action.editor).catch((err: unknown) => {
      setFailure(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <div className="shrink-0 px-3 py-2">
      <Alert role="status" variant={noteTone(note, readOnly, failure != null)} className="py-1.5">
        <AlertDescription className="flex min-w-0 items-center gap-2 text-[12px]">
          <NoteText text={text} />
          {readOnly ? <span className="shrink-0 text-muted-foreground">Read-only</span> : null}
          {action ? (
            <Button variant="ghost" size="xs" className="-me-1.5 ms-auto text-foreground" onClick={run}>
              {action.label}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** The note's text, with the whole of it on hover only when it is cut. */
function NoteText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    <Tooltip disabled={!cut}>
      <TooltipTrigger render={<span ref={ref} className="min-w-0 truncate text-foreground" />}>{text}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
