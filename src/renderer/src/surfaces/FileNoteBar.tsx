import { useState } from "react";
import type { FileNote } from "../lib/layout";
import { openWithEditor } from "../lib/native";
import { CircleAlert, GitBranch } from "../chrome/icons";

/**
 * The line above a file the app shows instead of handing it to the
 * editor (lib/openInEditor.ts): why ("Mac copy differs: on branch X
 * here"), whether it is read-only, and the one way out ("Open the Mac copy
 * anyway"). Same height and hairline as the panel headers; no colour, the
 * text carries the state.
 */
export function FileNoteBar({ note, readOnly }: { note: FileNote; readOnly?: boolean }) {
  const [failure, setFailure] = useState<string | null>(null);
  const action = note.action;
  const Icon = /branch/.test(note.text) ? GitBranch : CircleAlert;
  const run = () => {
    if (!action) return;
    setFailure(null);
    openWithEditor(action.editor).catch((err: unknown) => {
      setFailure(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-content/10 px-3 text-[12px] leading-none"
    >
      <Icon className="size-3.5 shrink-0 text-content/50" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate text-content/70" title={failure ?? note.text}>
        {failure ? `Couldn’t open: ${failure}` : note.text}
        {readOnly ? <span className="text-content/40"> · Read-only</span> : null}
      </span>
      {action ? (
        <button
          type="button"
          onClick={run}
          className="h-6 shrink-0 rounded-md px-2 text-[12px] font-medium text-content hover:bg-content/10 focus-visible:bg-content/10 focus-visible:outline-none"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
