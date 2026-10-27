import {
  formatRelativeTime,
  githubReviewDecisionLabel,
  inboxItemRef,
  inboxItemStatus,
  type InboxItem,
} from "./githubTasks";
import { projectName } from "./paths";

/**
 * What one inbox row says, in two lines: the kind glyph, the title and the
 * time; then the ref, the source when the list spans more than one, the
 * author, and a status only when it needs eyes (checks failed on an open
 * pull request). Draft, review and open/closed states are the detail
 * pane's, in plain words (`inboxStateWords`).
 */
export type InboxRowModel = {
  kind: "pr" | "issue";
  title: string;
  unseen: boolean;
  time: string | null;
  /** The ref, then the source when shown, then the author's login. */
  line: string[];
  status: { state: "failed"; detail: "checks" } | null;
};

export function inboxRowModel(
  item: InboxItem,
  opts: { unseen: boolean; showSource: boolean },
): InboxRowModel {
  const author = item.author?.login?.trim() ?? "";
  const source = opts.showSource ? inboxItemSource(item) : "";
  return {
    kind: item.kind === "pr" ? "pr" : "issue",
    title: item.title,
    unseen: opts.unseen,
    time: formatRelativeTime(item.updatedAt) || null,
    line: [inboxItemRef(item), source, author].filter(Boolean),
    status: checksFailed(item) ? { state: "failed", detail: "checks" } : null,
  };
}

/** The repo (GitHub) or team (Linear) the item lives in. */
export function inboxItemSource(item: InboxItem): string {
  if (item.provider === "linear") return item.teamName || item.repo;
  return item.repo || projectName(item.projectPath);
}

/** Checks failed on an open GitHub pull request: the one row status. */
export function checksFailed(item: InboxItem): boolean {
  return (
    item.provider === "github" &&
    item.kind === "pr" &&
    !item.draft &&
    item.state.toLowerCase() === "open" &&
    (item.checks === "FAILURE" || item.checks === "ERROR")
  );
}

/** The detail pane's state, as plain words: Draft, Open, Merged or Closed
 *  (a Linear issue's own state name), then the review decision of an open
 *  pull request. `reviewDecision` defaults to the snapshot's. */
export function inboxStateWords(item: InboxItem, reviewDecision = item.reviewDecision ?? ""): string[] {
  if (item.provider === "linear") return [item.state || inboxItemStatus(item)];
  const status = inboxItemStatus({ ...item, state: item.state.toLowerCase() });
  const review = item.kind === "pr" && status === "Open" ? githubReviewDecisionLabel(reviewDecision) : "";
  return review ? [status, review] : [status];
}
