// A8 (action rows): the row for one call that is not a file change.
import { useContext, useState } from "react";
import { Collapsible, CollapsibleContent } from "../../components/ui/collapsible";
import { resolveWorkspacePath } from "../../lib/paths";
import type { OpenFileFn } from "../../lib/search";
import type { Block } from "../../lib/session";
import { SelectSessionContext } from "../AgentMarkdown";
import { useOpenAgentDetail } from "../agentDetailContext";
import { CallPortLink } from "../CallPortLink";
import { FileRefMenu } from "../FileRefMenu";
import { QuestionCard } from "../QuestionCard";
import { ReconnectChip, SubagentSteps } from "../ToolChips";
import { ToolDetails } from "../ToolDetails";
import { useTranscriptHost } from "../transcriptSession";
import { ActionLine } from "./ActionLine";
import { CommandCard } from "./CommandCard";
import { useAction, type Action } from "./actionModel";
import { ApprovalCard } from "./ApprovalCard";
import { ToolGlyph } from "./ToolGlyph";
import type { ApprovalHandler } from "./types";

/**
 * One call as one quiet line. A read opens its file; a command, a search,
 * a tool open their body in place under the line; a call waiting on the
 * person shows its body open, with the approval card under it.
 */
export function ActionRow({
  block,
  cwd,
  live,
  onOpenFile,
  onApproval,
  approval = true,
}: {
  block: Block;
  cwd?: string;
  /** False when the call's approval card is drawn by the row's parent (an edit's bookkeeping row). */
  approval?: boolean;
  /** The tense to speak in; the call's own state when not given. */
  live?: boolean;
  onOpenFile?: OpenFileFn;
  onApproval?: ApprovalHandler;
}) {
  const action = useAction(block, cwd, live);
  const [open, setOpen] = useState(false);
  const threadHost = useTranscriptHost();
  const openThread = useThreadOpener(action);
  const hasBody = action.opens !== "file" && action.opens !== "none";
  // While the call waits on the person its body shows what it asks, and stays open.
  const shown = open || (action.pending && hasBody);
  const filePath = action.opens === "file" && action.path ? resolveWorkspacePath(action.path, cwd) : undefined;
  const openFile =
    filePath && onOpenFile
      ? () =>
          onOpenFile(
            filePath,
            action.line ? { line: action.line } : undefined,
            threadHost ? { environmentId: threadHost } : undefined,
          )
      : undefined;
  const label = [action.verb, action.object].filter(Boolean).join(" ") || "Tool call";

  const line = (
    <ActionLine
      glyph={<ToolGlyph action={action} block={block} />}
      verb={action.verb}
      object={action.object}
      title={action.title}
      label={label}
      onObject={openThread}
      trailing={<Extras block={block} />}
      open={shown}
      onToggle={hasBody && !action.pending ? () => setOpen((value) => !value) : undefined}
      onActivate={openFile}
    />
  );

  return (
    <div data-block={block.id} className="flex min-w-0 flex-col">
      {filePath ? (
        <FileRefMenu target={action.path ?? ""} cwd={cwd} onOpenFile={onOpenFile}>
          {line}
        </FileRefMenu>
      ) : (
        line
      )}
      {hasBody ? (
        <Collapsible open={shown} onOpenChange={setOpen}>
          <CollapsibleContent>
            <div className="pb-2">
              <div data-row-body className={BODY_FRAME}>
              {action.opens === "command" ? (
                <CommandCard block={block} failed={action.failed} />
              ) : (
                <ToolDetails block={block} />
              )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {/* Allow and Deny under the body while the call waits, its verdict once decided. */}
      {approval ? <ApprovalCard block={block} onApproval={onApproval} /> : null}
      {block.question ? <QuestionCard question={block.question} /> : null}
    </div>
  );
}

/**
 * A row's open body is a card of its own (hairline, rounded-lg, p-3) when
 * the row stands alone; inside the group's list, which is already that
 * card, it draws nothing, so no card sits within a card.
 */
export const BODY_FRAME =
  "rounded-lg border border-border bg-card p-3 in-[.bg-card]:rounded-none in-[.bg-card]:border-0 in-[.bg-card]:bg-transparent in-[.bg-card]:p-0";

/** The thread an app call names: the agent's detail when it is a subagent, else the pane. */
function useThreadOpener(action: Action): (() => void) | undefined {
  const onSelectSession = useContext(SelectSessionContext);
  const openDetail = useOpenAgentDetail();
  const open = action.agent && openDetail ? openDetail : onSelectSession;
  const id = action.threadId;
  return id && open ? () => open(id) : undefined;
}

/** The trailing slot, in its order: steps, the dev server it opened, reconnect. */
function Extras({ block }: { block: Block }) {
  const steps = block.tool?.subCount;
  const reauth = block.tool?.reauth;
  if (!steps && !block.tool?.callId && !reauth) return null;
  return (
    <>
      <SubagentSteps count={steps} />
      <CallPortLink callId={block.tool?.callId} />
      {reauth ? <ReconnectChip reauth={reauth} /> : null}
    </>
  );
}
