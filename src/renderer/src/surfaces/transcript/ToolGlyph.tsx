// A8 (action rows): the one 14px glyph a row leads with.
import {
  Bot,
  FilePlusCorner,
  FileText,
  Folder,
  Globe,
  ListChecks,
  MessageSquare,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  type IconComponent,
} from "../../chrome/icons";
import { StatusMark } from "../../components/ui/status";
import type { Block } from "../../lib/session";
import { useMetaById } from "../../lib/threads/agents";
import { agentIdOf } from "../appTool";
import { ConnectorMark, ProviderMark } from "../ToolChips";
import { agentProviderOf } from "../toolMarks";
import { SwapIcon } from "../../motion/IconSwap";
import type { Action, GlyphKey } from "./actionModel";
import { GLYPH_SLOT } from "./stepLine";

/** Each kind's icon; one glyph per row, no file-type icon beside the name. */
export const GLYPH: Record<GlyphKey, IconComponent> = {
  run: Terminal,
  read: FileText,
  write: FilePlusCorner,
  edit: PenLine,
  patch: PenLine,
  delete: Trash2,
  search: Search,
  glob: Search,
  list: Folder,
  fetch: Globe,
  web: Globe,
  todo: ListChecks,
  skill: Sparkles,
  question: MessageSquare,
  app: Bot,
  mcp: Wrench,
  tool: Wrench,
};

/**
 * The row's glyph, in order: the working or failed StatusMark (a call
 * waiting on the person keeps its icon; the approval line draws the mark)
 * (the one status map), the connector's or the subagent's mark, else the
 * kind's icon. Always one 14px box, so the verbs line up; a change between
 * them (a call settling: the arc to its icon) swaps in place through the
 * keyed SwapIcon. Working's arc is still: a running row shows only for agent
 * work or under a turn that is over, and the turn's working line is the one
 * moving mark.
 */
export function ToolGlyph({ action, block }: { action: Action; block: Block }) {
  return (
    <span className={GLYPH_SLOT} data-glyph>
      <SwapIcon state={glyphState(action)}>
        <GlyphBody action={action} block={block} />
      </SwapIcon>
    </span>
  );
}

/** Which of the glyph's faces shows: the key its swap turns on. */
export function glyphState(action: Action): "working" | "failed" | "icon" {
  // A call waiting on the person keeps its tool icon: the approval line under it carries the amber mark.
  if (action.running) return "working";
  if (action.failed) return "failed";
  return "icon";
}

function GlyphBody({ action, block }: { action: Action; block: Block }) {
  if (action.running) return <StatusMark state="working" word={false} still />;
  if (action.failed) return <StatusMark state="failed" word={false} />;
  if (action.connector) return <ConnectorMark app={action.connector} />;
  if (action.agent) return <AgentGlyph block={block} />;
  const Icon = GLYPH[action.glyph];
  return <Icon className="size-3.5" />;
}

/** The provider a subagent runs on; the app's glyph until the fold knows it. */
function AgentGlyph({ block }: { block: Block }) {
  const meta = useMetaById(agentIdOf(block));
  const provider = agentProviderOf(block, meta?.provider ?? null);
  if (provider) return <ProviderMark harness={provider} />;
  return <Bot className="size-3.5" />;
}
