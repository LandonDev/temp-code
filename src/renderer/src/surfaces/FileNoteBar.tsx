import { useState, type ReactNode } from "react";
import type { FileNote } from "../lib/layout";
import { openWithEditor } from "../lib/native";
import { Alert, AlertDescription, type AlertTone } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";

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
    <EditorAlert
      tone={noteTone(note, readOnly, failure != null)}
      role="status"
      text={text}
      aside={readOnly ? "Read-only" : undefined}
      actions={action ? [{ label: action.label, onClick: run }] : []}
    />
  );
}

export type EditorAlertAction = { label: string; onClick: () => void; tooltip?: ReactNode };

/**
 * One line above a buffer: the note (FileNoteBar), the disk conflict
 * (ConflictBar), the engine's EULA. One shape, so the lines stacked over a
 * file never drift apart: the text wraps and is never cut, an optional muted
 * aside and the actions kept together at the end; they drop under the text
 * only when the row cannot hold a few of its words beside them.
 */
export function EditorAlert({
  tone,
  role,
  text,
  aside,
  actions,
}: {
  tone: AlertTone;
  role: "status" | "alert";
  text: string;
  aside?: string;
  actions: readonly EditorAlertAction[];
}) {
  return (
    <div className="shrink-0 px-3 py-2">
      <Alert role={role} variant={tone} className="py-1.5">
        <AlertDescription className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          <span className="min-w-0 grow basis-40 text-pretty text-foreground">{text}</span>
          {aside || actions.length > 0 ? (
            <span data-alert-end className="ms-auto flex shrink-0 items-center gap-2">
              {aside ? <span className="text-muted-foreground">{aside}</span> : null}
              {actions.map((item, index) => {
                const className = cn("text-foreground", index === actions.length - 1 && "-me-1.5");
                if (!item.tooltip) {
                  return (
                    <Button key={item.label} variant="ghost" size="xs" className={className} onClick={item.onClick}>
                      {item.label}
                    </Button>
                  );
                }
                return (
                  <Tooltip key={item.label}>
                    <TooltipTrigger render={<Button variant="ghost" size="xs" className={className} onClick={item.onClick} />}>
                      {item.label}
                    </TooltipTrigger>
                    <TooltipContent>{item.tooltip}</TooltipContent>
                  </Tooltip>
                );
              })}
            </span>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}

