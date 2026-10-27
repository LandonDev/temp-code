// A8 (action rows): the one 14px glyph a row leads with.
import {
  Bot,
  CircleAlert,
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
import { Spinner } from "../../components/ui/spinner";
import { StatusMark } from "../../components/ui/status";
import type { Block } from "../../lib/session";
import { useMetaById } from "../../lib/threads/agents";
import { agentIdOf } from "../appTool";
import { ConnectorMark, ProviderMark } from "../ToolChips";
import { agentProviderOf } from "../toolMarks";
import type { Action, GlyphKey } from "./actionModel";

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
 * The row's glyph, in order: the spinner while it runs, the waiting mark
 * while it asks, the failed mark, the connector's or the subagent's mark,
 * else the kind's icon. Always one 14px box, so the verbs line up.
 */
export function ToolGlyph({ action, block }: { action: Action; block: Block }) {
  return (
    <span className="grid size-3.5 shrink-0 place-items-center text-muted-foreground" data-glyph>
      <GlyphBody action={action} block={block} />
    </span>
  );
}

function GlyphBody({ action, block }: { action: Action; block: Block }) {
  if (action.pending) return <StatusMark state="waiting" word={false} />;
  if (action.running) return <Spinner className="size-3.5" />;
  if (action.failed) {
    return <CircleAlert aria-label="Failed" className="size-3.5 text-destructive" strokeWidth={1.5} />;
  }
  if (action.connector) return <ConnectorMark app={action.connector} />;
  if (action.agent) return <AgentGlyph block={block} />;
  const Icon = GLYPH[action.glyph];
  return <Icon className="size-3.5" strokeWidth={1.5} />;
}

/** The provider a subagent runs on; the app's glyph until the fold knows it. */
function AgentGlyph({ block }: { block: Block }) {
  const meta = useMetaById(agentIdOf(block));
  const provider = agentProviderOf(block, meta?.provider ?? null);
  if (provider) return <ProviderMark harness={provider} />;
  return <Bot className="size-3.5" strokeWidth={1.5} />;
}
