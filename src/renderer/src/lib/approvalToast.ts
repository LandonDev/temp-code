import { leafIds, type WorkspaceTab } from "./layout";
import { pendingApprovalIndex, sessionDisplayTitle, type Block, type Session } from "./session";
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

/** Toast data never retains a block or a Session. */
export type ApprovalToastNotice = Pick<PendingApprovalNotice, "sessionId" | "requestId" | "label" | "tool"> & {
  title: string;
};

const approvalLabels = new WeakMap<Block, { cwd: string; label: string; tool: string }>();

function labelsForApproval(block: Block, cwd: string): { label: string; tool: string } {
  let facts = approvalLabels.get(block);
  if (!facts || facts.cwd !== cwd) {
    facts = {
      cwd,
      label: toolCallLabel(block, cwd),
      tool: block.tool?.name ? humanName(block.tool.name) : "a tool",
    };
    approvalLabels.set(block, facts);
  }
  return facts;
}

export function approvalToastNotice(session: Session, previous?: ApprovalToastNotice): ApprovalToastNotice | null {
  const block = session.blocks[pendingApprovalIndex(session.blocks)];
  if (!block?.approval) return null;
  const { label, tool } = labelsForApproval(block, session.cwd);
  const requestId = block.approval.requestId;
  const title = sessionDisplayTitle(session.title, session.harness);
  if (previous && previous.sessionId === session.id && previous.requestId === requestId && previous.label === label && previous.tool === tool && previous.title === title) return previous;
  return { sessionId: session.id, requestId, label, tool, title };
}

/** Latest undecided approval in a session, if any. */
export function pendingApprovalForSession(
  session: Session,
): PendingApprovalNotice | null {
  const block = session.blocks[pendingApprovalIndex(session.blocks)];
  if (!block?.approval) return null;
  const { label, tool } = labelsForApproval(block, session.cwd);
  return { sessionId: session.id, requestId: block.approval.requestId, label, tool, block };
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
