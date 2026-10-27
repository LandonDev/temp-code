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
import { ApprovalControls } from "./Approval";
import { ToolGlyph } from "./ToolGlyph";
import type { ApprovalHandler } from "./types";

/**
 * One call as one quiet line. A read opens its file; a command, a search,
 * a tool open their body in place under the line; a call waiting on the
 * person carries the approval card where its body would open.
 */
export function ActionRow({
  block,
  cwd,
  live,
  onOpenFile,
  onApproval,
}: {
  block: Block;
  cwd?: string;
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
      open={open}
      onToggle={hasBody ? () => setOpen((value) => !value) : undefined}
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
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleContent>
            <div className="pb-2">
              {action.opens === "command" ? (
                <CommandCard block={block} failed={action.failed} />
              ) : (
                <ToolDetails block={block} />
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {/* Pending: the board. Decided: its one-line verdict. Neither: nothing. */}
      <ApprovalControls block={block} onApproval={onApproval} />
      {block.question ? <QuestionCard question={block.question} /> : null}
    </div>
  );
}

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
