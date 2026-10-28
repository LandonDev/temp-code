import { leafIds, type WorkspaceTab } from "./layout";
import { hasPendingApproval, type Block, type Session } from "./session";
import { toolCallLabel } from "../surfaces/transcriptActivity";
import { humanName } from "./toolPhrase";

export type PendingApprovalNotice = {
  sessionId: string;
  requestId: string | number;
  /** What the call does, in words ("Creating empty file notes.txt"): the toast's line, where no card shows it. */
  label: string;
  /** The tool's name ("Bash"): a state's detail, "Needs you  approve Bash", beside a card that shows the rest. */
  tool: string;
  block: Block;
};

/** Latest undecided approval in a session, if any. */
export function pendingApprovalForSession(
  session: Session,
): PendingApprovalNotice | null {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (!block.approval || block.approval.decided) continue;
    return {
      sessionId: session.id,
      requestId: block.approval.requestId,
      label: toolCallLabel(block, session.cwd),
      tool: block.tool?.name ? humanName(block.tool.name) : "a tool",
      block,
    };
  }
  return null;
}

/** True when the conversation pane for this session is focused and active. */
export function isSessionConversationFocused(
  sessionId: string,
  activeTabId: string,
  tabs: WorkspaceTab[],
  composerFocused: boolean,
): boolean {
  const tab = tabs.find((entry) => entry.id === activeTabId);
  if (!tab) return false;
  if (!leafIds(tab.layout).includes(sessionId)) return false;
  if (tab.focusedId !== sessionId) return false;
  return composerFocused;
}

export function hiddenApprovalNotices(
  sessions: Session[],
  activeTabId: string,
  tabs: WorkspaceTab[],
  composerFocused: boolean,
): Array<PendingApprovalNotice & { session: Session }> {
  const notices: Array<PendingApprovalNotice & { session: Session }> = [];
  for (const session of sessions) {
    if (!hasPendingApproval(session.blocks)) continue;
    const pending = pendingApprovalForSession(session);
    if (!pending) continue;
    if (
      isSessionConversationFocused(
        session.id,
        activeTabId,
        tabs,
        composerFocused,
      )
    ) {
      continue;
    }
    notices.push({ ...pending, session });
  }
  return notices;
}
