import { AddonMark } from "../chrome/AddonMark";
import { Button } from "../components/ui/button";
import { HarnessIcon } from "../chrome/HarnessIcon";
import { addonTitle } from "../lib/addonNames";
import { openUrl } from "../lib/native";
import type { Block, HarnessId } from "../lib/session";
import { useMetaById } from "../lib/threads/agents";
import { asHarness } from "../lib/tcserver/store";
import type { SlashCommand } from "../lib/tcserver/types";
import { agentIdOf } from "./appTool";
import { agentProviderOf } from "./toolMarks";

/** The connector's brand in place of the tool icon. */
export function ConnectorMark({ app, className = "" }: { app: string; className?: string }) {
  return (
    <span className={`grid size-3.5 shrink-0 place-items-center ${className}`} aria-label={addonTitle(app)}>
      <AddonMark command={{ name: app, source: "mcp" }} size={13} colored={false} className="text-muted-foreground" />
    </span>
  );
}

/**
 * The provider a subagent call runs on, in place of the tool icon. The
 * spawned session's own provider wins once the fold knows it.
 */
export function SubagentMark({ block, className = "" }: { block: Block; className?: string }) {
  const meta = useMetaById(agentIdOf(block));
  const provider = agentProviderOf(block, meta?.provider ?? null);
  if (!provider) return null;
  return <ProviderMark harness={provider} className={className} />;
}

export function ProviderMark({ harness, className = "" }: { harness: HarnessId; className?: string }) {
  return (
    <span className={`grid size-3.5 shrink-0 place-items-center text-muted-foreground ${className}`}>
      <HarnessIcon harness={asHarness(harness)} className="size-3" />
    </span>
  );
}

/** Steps a subagent ran under this call: "12 steps". */
export function SubagentSteps({ count }: { count?: number }) {
  if (!count) return null;
  return (
    <span className="shrink-0 font-sans text-xs tabular-nums text-muted-foreground">
      {count} {count === 1 ? "step" : "steps"}
    </span>
  );
}

/** A connector's grant expired: the button opens the page that renews it. */
export function ReconnectChip({ reauth }: { reauth: { app: string; url: string } }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="text-warning hover:text-warning"
      onClick={(event) => {
        event.stopPropagation();
        void openUrl(reauth.url);
      }}
    >
      <AddonMark command={{ name: reauth.app, source: "mcp" }} size={11} colored={false} />
      Reconnect {addonTitle(reauth.app)}
    </Button>
  );
}

/** The first reauth a group of steps carries, for its folded header. */
export function reauthOf(blocks: Block[]): { app: string; url: string } | undefined {
  for (const b of blocks) if (b.tool?.reauth) return b.tool.reauth;
  return undefined;
}

/** A `/command` in the user's words, as the addon it names. */
export function CommandChip({ command }: { command: Pick<SlashCommand, "name" | "source"> }) {
  const proper = command.source === "mcp" || command.source === "plugin";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-content/10 px-1 align-baseline text-[13px] text-content"
      title={`/${command.name}`}
    >
      <AddonMark command={command} size={11} colored={false} />
      {proper ? addonTitle(command.name) : `/${command.name}`}
    </span>
  );
}
