import type { SessionStatus } from "../lib/tcserver/types";
import { ConfirmDialog } from "./ConfirmDialog";

/** The delete confirm's one line: a thread still at work stops first, a
 *  queued one never starts. */
export function deleteBody(status: SessionStatus | undefined): string {
  const live = status === "running" || status === "starting" || status === "waiting" || status === "watching" || status === "paused";
  if (live) return "It stops first, and its transcript is gone for good.";
  if (status === "queued") return "It leaves the queue unstarted, and its transcript is gone for good.";
  return "Its transcript is gone for good.";
}

/** A thread menu's Delete… (chrome/useThreadMenu.tsx), in the dialogs chunk:
 *  it names the thread and says what happens to one still at work. */
export function DeleteThreadDialog({
  title,
  status,
  onCancel,
  onConfirm,
}: {
  title: string;
  status: SessionStatus | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <ConfirmDialog title={`Delete ${title}?`} body={deleteBody(status)} confirmLabel="Delete thread" danger onCancel={onCancel} onConfirm={onConfirm} />;
}
