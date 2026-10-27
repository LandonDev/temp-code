import { useState } from "react";
import { useClosingDialog } from "../../../chrome/Modal";
import { X } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { Sheet, SheetClose, SheetContent } from "../../../components/ui/sheet";
import type { OpenFileFn } from "../../../lib/search";
import { useMetaById } from "../../../lib/threads/agents";
import { AgentDetailBody } from "./AgentDetailBody";

/**
 * A subagent in a 672px Sheet at the window's right edge: the container
 * for its content (AgentDetailBody: header, transcript, steer field), with
 * the close button.
 *
 * Every close (the button, Escape, the backdrop, Open) plays the slide out
 * first and then runs the parent's callback once. The transcript is a
 * heavy, live-streaming subtree: mounted inside the sliding sheet it
 * re-lays out on every chunk and wrecks the slide, so it mounts once the
 * open has completed and unmounts when the close starts.
 */
export function AgentDetail({
  agentId,
  parentCwd,
  onClose,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
}: {
  agentId: string;
  parentCwd: string;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
}) {
  const meta = useMetaById(agentId);
  const [settled, setSettled] = useState(false);
  const { root, closeThen } = useClosingDialog(onClose, false);

  if (!meta) return null;

  return (
    <Sheet
      {...root}
      onOpenChangeComplete={(open) => {
        if (open) setSettled(true);
        root.onOpenChangeComplete(open);
      }}
    >
      <SheetContent side="right" width={672} showCloseButton={false} aria-label={meta.title || "Subagent"} data-agent-detail>
        <AgentDetailBody
          agentId={agentId}
          parentCwd={parentCwd}
          ready={settled && root.open}
          // Open closes first: the body calls onClose, then onOpenSession,
          // and the last closeThen wins, so the parent hears both once the
          // slide out has played.
          onClose={() => closeThen(onClose)}
          onOpenSession={
            onOpenSession
              ? (id) =>
                  closeThen(() => {
                    onClose();
                    onOpenSession(id);
                  })
              : undefined
          }
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
        <SheetClose
          aria-label="Close"
          render={<Button variant="ghost" size="icon-sm" className="absolute end-3 top-3.5 text-muted-foreground" />}
        >
          <X />
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}
