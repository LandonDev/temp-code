import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@renderer/components/ui/button";
import type { ApprovalDecision } from "../lib/harness";
import { hiddenApprovalNotices, type PendingApprovalNotice } from "../lib/approvalToast";
import { useServerSessions } from "../lib/tcserver/store";
import { useFocus } from "../stores/focus";
import { useWorkspaceTabs } from "../stores/workspace";
import { sessionDisplayTitle, type Session } from "../lib/session";
import { useToastSync } from "./toastSync";

type Notice = PendingApprovalNotice & { session: Session };

type Props = {
  notices: Notice[];
  onFocusSession: (sessionId: string) => void;
  onApproval: (
    sessionId: string,
    requestId: string | number,
    decision: ApprovalDecision,
  ) => void;
};

/** Toasts for approvals pending in sessions the user is not looking at.
 *  Subscribes to the store itself so App does not re-render per push. */
export function HiddenApprovalToasts(rest: Omit<Props, "notices">) {
  const tabs = useWorkspaceTabs((s) => s.tabs);
  const activeTabId = useWorkspaceTabs((s) => s.activeTabId);
  const composerFocused = useFocus((s) => s.composerFocused);
  const sessions = useServerSessions();
  const notices = useMemo(
    () => hiddenApprovalNotices(sessions, activeTabId, tabs, composerFocused),
    [sessions, activeTabId, tabs, composerFocused],
  );
  return <ApprovalToasts notices={notices} {...rest} />;
}

/** One sonner toast per pending approval, held until it is answered: the
 *  thread's title opens it, Allow and Deny answer it. */
export function ApprovalToasts({ notices, onFocusSession, onApproval }: Props) {
  useToastSync(
    notices,
    (notice) => `approval:${notice.sessionId}:${notice.requestId}`,
    ({ session, label, requestId }, id) =>
      toast.warning(
        <Button variant="link" className="h-auto p-0 font-medium" onClick={() => onFocusSession(session.id)}>
          {sessionDisplayTitle(session.title, session.harness)}
        </Button>,
        {
          id,
          description: label,
          duration: Infinity,
          action: { label: "Allow", onClick: () => onApproval(session.id, requestId, "allow") },
          cancel: { label: "Deny", onClick: () => onApproval(session.id, requestId, "deny") },
        },
      ),
  );
  return null;
}
