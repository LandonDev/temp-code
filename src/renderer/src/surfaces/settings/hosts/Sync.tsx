import type { HarnessSyncStatus } from "@server/shared/contract-harness";
import type { MemorySyncStatus } from "@server/shared/contract-memory";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Switch } from "../../../components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { ChevronRight } from "../../../chrome/icons";
import { revealPath } from "../../../lib/fs";
import { isWebMode } from "../../../lib/nativeWeb";
import { ago, harnessParts, setsText } from "../../harnessLine";
import { memoryParts } from "../../memoryLine";
import { Facts } from "./Facts";
import { Group, Row } from "./Group";

/**
 * Sync on this machine: the harness config going out to every host it holds
 * an admin key for, and memory both ways, each a switch; the conflict copies
 * the memory sync kept here open under the memory row.
 */
export function LocalSync({
  harness,
  memory,
  onAct,
}: {
  harness: HarnessSyncStatus;
  memory: MemorySyncStatus | null;
  onAct: (method: string, params: unknown) => void;
}) {
  const conflicts = memory?.conflicts ?? [];
  return (
    <Group title="Sync" data-sync="local">
      <Row
        title="Harness config"
        description={harness.skipped > 0 ? `${harness.skipped} ${harness.skipped === 1 ? "file stays" : "files stay"} here: over 16 MB, a symlink out of reach, or a macOS binary` : undefined}
      >
        <Switch aria-label="Sync harness config" checked={harness.enabled} onCheckedChange={(enabled) => onAct("harness.settings.set", { enabled })} />
      </Row>
      {memory ? (
        <Row title="Memory">
          <Switch aria-label="Sync memory" checked={memory.enabled} onCheckedChange={(enabled) => onAct("memory.settings.set", { enabled })} />
        </Row>
      ) : null}
      {conflicts.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group/fold flex h-7 items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="size-3 transition-transform duration-(--dur-fast) group-data-[panel-open]/fold:rotate-90 motion-reduce:transition-none" />
            {conflicts.length === 1 ? "1 conflict copy" : `${conflicts.length} conflict copies`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mb-1 flex flex-col rounded-lg bg-muted/40 px-3" data-memory-conflicts={conflicts.length}>
              {conflicts.map((c) => (
                <Row key={c.path} title={c.of} description={<Facts parts={[`${c.host}'s copy`, ago(c.at)]} />}>
                  {isWebMode() ? null : (
                    <Tooltip>
                      <TooltipTrigger render={<Button variant="ghost" size="sm" onClick={() => void revealPath(c.path)} />}>Reveal</TooltipTrigger>
                      <TooltipContent className="font-mono">{c.path}</TooltipContent>
                    </Tooltip>
                  )}
                </Row>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </Group>
  );
}

/** A paired host's sync: what went over last and when, both legs, with Sync now. */
export function HostSync({
  environmentId,
  harness,
  memory,
  onSync,
}: {
  environmentId: string;
  harness: HarnessSyncStatus;
  memory: MemorySyncStatus | null;
  onSync: (environmentId: string, harnessOn: boolean, memoryOn: boolean) => void;
}) {
  const env = harness.environments.find((e) => e.id === environmentId);
  if (!env) return null;
  const mem = memory?.environments.find((m) => m.id === environmentId) ?? null;
  const running = env.running || mem?.running === true;
  const memoryOn = memory?.enabled ?? false;
  const sets = setsText(env.sets);
  return (
    <Group
      title="Sync"
      data-sync={environmentId}
      action={
        <Button
          variant="secondary"
          size="sm"
          disabled={(!harness.enabled && !memoryOn) || !env.connected || running}
          onClick={() => onSync(environmentId, harness.enabled, memoryOn)}
        >
          Sync now
        </Button>
      }
    >
      <Row
        title="Harness config"
        description={
          sets ? (
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-default" />}>
                <Facts parts={harnessParts(env)} />
              </TooltipTrigger>
              <TooltipContent>{sets}</TooltipContent>
            </Tooltip>
          ) : (
            <Facts parts={harnessParts(env)} />
          )
        }
      />
      {mem ? <Row title="Memory" description={<Facts parts={memoryParts(mem)} />} /> : null}
    </Group>
  );
}
