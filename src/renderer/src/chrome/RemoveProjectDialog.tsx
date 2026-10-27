import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { projectSessionCount } from "../lib/projectData";

type Props = {
  name: string;
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/** The one line under the title: what stays, and how many threads go once counted. */
export function removeProjectLine(sessions: number | null): string {
  if (!sessions) return "Files on disk stay.";
  return sessions === 1 ? "Files on disk stay. Its thread is deleted." : `Files on disk stay. Its ${sessions} threads are deleted.`;
}

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
    <ConfirmDialog
      title={`Remove “${name}”?`}
      body={removeProjectLine(sessions)}
      confirmLabel="Remove"
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
