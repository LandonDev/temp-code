import { useEffect, useState } from "react";
import { DANGER, GHOST } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { prettyCwd } from "../lib/paths";
import { projectSessionCount } from "../lib/projectData";

type Props = {
  name: string;
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Removing drops the workspace from the rail along with its projects and
 * threads on the server. Files and worktrees on disk are left alone; opening
 * the folder again brings the workspace back empty.
 */
export function RemoveProjectDialog({ name, path, onCancel, onConfirm }: Props) {
  const [sessions, setSessions] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void projectSessionCount(path).then((count) => {
      if (!cancelled) setSessions(count);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <Modal onClose={onCancel} title={`Remove “${name}”?`} description={prettyCwd(path)} size="sm">
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="text-[12px] leading-snug text-content/50">
          Its projects and threads leave the app; files on disk stay.
        </p>
        <p className="min-h-4 text-[12px] leading-4 text-content/40 tabular-nums">
          {sessions
            ? `${sessions} saved conversation${sessions === 1 ? "" : "s"} will be removed.`
            : ""}
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
        <button type="button" onClick={onCancel} className={GHOST}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className={DANGER}>
          Remove
        </button>
      </div>
    </Modal>
  );
}
