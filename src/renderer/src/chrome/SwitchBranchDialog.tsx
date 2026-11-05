import { WandSparkles } from "./icons";
import { useRef, useState } from "react";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { DialogFooter, ErrorLine, errorText } from "./ConfirmDialog";
import { Tip } from "../components/tip";
import { Modal } from "./Modal";
import { generateCommitMessage } from "../lib/harness";
import { MOD } from "../lib/platform";

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

export function SwitchBranchDialog(props: Props) {
  const [generating, setGenerating] = useState(false);
  return (
    <Modal
      onClose={props.onCancel}
      busy={Boolean(props.busy) || generating}
      title="Uncommitted changes"
      description={`Stash or commit them before ${props.creating ? "creating" : "switching to"} “${props.branch}”.`}
      size="sm"
    >
      <Body {...props} generating={generating} setGenerating={setGenerating} />
    </Modal>
  );
}

function Body({
  cwd,
  busy,
  error,
  onStash,
  onCommit,
  onCancel,
  generating,
  setGenerating,
}: Props & { generating: boolean; setGenerating: (on: boolean) => void }) {
  const [message, setMessage] = useState("");
  const [generateError, setGenerateError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trimmed = message.trim();
  const waiting = Boolean(busy) || generating;
  const canCommit = trimmed.length > 0 && !waiting;

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
      field.current?.focus();
    }
  };

  return (
    <>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="relative">
          <Textarea
            ref={field}
            autoFocus
            rows={1}
            value={message}
            placeholder={`Message (${MOD}↩ to commit)`}
            disabled={waiting}
            aria-label="Commit message"
            className="max-h-40 min-h-8 resize-none overflow-x-hidden overflow-y-auto py-1.5 pe-9"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canCommit) {
                event.preventDefault();
                onCommit(trimmed);
              }
            }}
          />
          <Tip label="Generate commit message">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Generate commit message"
              disabled={waiting}
              onClick={() => void generate()}
              className="absolute end-1 top-1 text-muted-foreground"
            >
              {generating ? <BusyLabel busy label="" /> : <WandSparkles />}
            </Button>
          </Tip>
        </div>
        <ErrorLine error={error || generateError} />
      </div>
      <DialogFooter
        onCancel={onCancel}
        confirmLabel="Stash & switch"
        pending={busy === "stash"}
        busy={waiting && busy !== "stash"}
        onConfirm={onStash}
      >
        <Button variant="secondary" disabled={!canCommit} onClick={() => onCommit(trimmed)}>
          <BusyLabel busy={busy === "commit"} label="Commit & switch" />
        </Button>
      </DialogFooter>
    </>
  );
}
