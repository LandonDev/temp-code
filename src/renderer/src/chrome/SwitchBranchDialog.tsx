import { WandSparkles } from "./icons";
import { useEffect, useRef, useState } from "react";
import { GHOST, PRIMARY, errorText } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { generateCommitMessage } from "../lib/harness";
import { MOD } from "../lib/platform";
import { MatrixSpinner } from "../surfaces/threads/bits";

type Busy = "stash" | "commit" | null;

type Props = {
  cwd: string;
  branch: string;
  creating?: boolean;
  busy: Busy;
  error?: string | null;
  onStash: () => void;
  onCommit: (message: string) => void;
  onCancel: () => void;
};

export function SwitchBranchDialog({
  cwd,
  branch,
  creating = false,
  busy,
  error,
  onStash,
  onCommit,
  onCancel,
}: Props) {
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = message.trim();
  const waiting = Boolean(busy) || generating;
  const canCommit = trimmed.length > 0 && !waiting;

  // The modal focuses its close button on mount; the message field wins
  // on the next frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => messageRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const el = messageRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [message]);

  const generate = async () => {
    if (waiting) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      setMessage(await generateCommitMessage(cwd));
    } catch (err) {
      setGenerateError(errorText(err));
    } finally {
      setGenerating(false);
      messageRef.current?.focus();
    }
  };

  const shown = error || generateError;

  return (
    <Modal
      onClose={onCancel}
      busy={waiting}
      title="Uncommitted changes"
      description={`Stash or commit them before ${creating ? "creating" : "switching to"} “${branch}”.`}
      size="sm"
    >
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="relative">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            placeholder={`Message (${MOD}↩ to commit)`}
            disabled={waiting}
            aria-label="Commit message"
            className="max-h-40 w-full resize-none overflow-y-auto rounded-lg border border-content/10 bg-content/5 py-1.5 pr-8 pl-2 text-[12px] leading-5 text-content outline-none placeholder:text-content/40 focus:border-content/20 disabled:cursor-default disabled:opacity-40"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canCommit) {
                event.preventDefault();
                onCommit(trimmed);
              }
            }}
          />
          <button
            type="button"
            title="Generate commit message"
            aria-label="Generate commit message"
            disabled={waiting}
            onClick={() => void generate()}
            className="pressable absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-sm text-content/50 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40"
          >
            {generating ? (
              <MatrixSpinner cell={1.5} />
            ) : (
              <WandSparkles className="size-3.5" strokeWidth={1.75} />
            )}
          </button>
        </div>
        {shown ? (
          <p className="whitespace-pre-wrap text-[11px] leading-4 text-danger">{shown}</p>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
        <button type="button" disabled={waiting} onClick={onCancel} className={GHOST}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!canCommit}
          onClick={() => onCommit(trimmed)}
          className={`${GHOST} flex items-center gap-2`}
        >
          {busy === "commit" ? <MatrixSpinner cell={1.5} /> : null}
          Commit & switch
        </button>
        <button type="button" disabled={waiting} onClick={onStash} className={PRIMARY}>
          {busy === "stash" ? <MatrixSpinner cell={1.5} /> : null}
          Stash & switch
        </button>
      </div>
    </Modal>
  );
}
