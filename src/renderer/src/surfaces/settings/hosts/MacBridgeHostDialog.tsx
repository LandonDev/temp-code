import { useState } from "react";
import {
  MAC_BRIDGE_MAX_RUNNING_CAP,
  MAC_BRIDGE_MAX_THREADS_CAP,
  type MacBridgeHostPolicy,
} from "@server/shared/contract-macbridge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { errorText } from "../../../chrome/ConfirmDialog";
import { pickFolder } from "../../../lib/fs";
import { setMacBridgeLimits, setMacBridgeShared, setMacBridgeShowRunning, useMacBridgeHosts } from "../../../lib/macBridge";
import { isWebMode } from "../../../lib/nativeWeb";
import { setForwarding, useHostForwards } from "../../../lib/portForwards";
import { CommitField } from "./CommitField";
import { Facts } from "./Facts";
import { DANGER_GHOST, Group, Row } from "./Group";
import { usageParts } from "./parts";

/**
 * A host's Mac bridge settings: whether a command admitted without asking
 * shows as a card, whether its dev servers are forwarded here, how many
 * commands and threads it may run at once, and the folders it reads without
 * asking. Each change saves at once; Done closes.
 */
export function MacBridgeHostDialog({ host: initial, onClose }: { host: MacBridgeHostPolicy; onClose: () => void }) {
  // The store's row, live: a change lands there and the dialog follows it.
  const host = useMacBridgeHosts().find((h) => h.environmentId === initial.environmentId) ?? initial;
  const fwd = useHostForwards(host.environmentId);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = host.environmentId;
  const runs = host.policy === "read+run" || host.policy === "full";
  const run = async (work: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const add = (folder: string): Promise<void> => run(() => setMacBridgeShared(id, [...host.shared, folder])).then(() => setPath(""));
  const browse = async (): Promise<void> => {
    const picked = await pickFolder("Share a folder with this host");
    if (picked) await add(picked);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="default" data-mac-bridge-settings={id}>
        <DialogHeader>
          <DialogTitle>Mac bridge on {host.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Group>
            {runs ? (
              <Row
                title="Show running commands"
                description={host.showRunning ? "A command allowed without asking shows as a card" : "A command allowed without asking shows only on the Hosts page, with Stop"}
              >
                <Switch
                  aria-label={`Show commands running from ${host.name}`}
                  checked={host.showRunning}
                  onCheckedChange={(on) => void run(() => setMacBridgeShowRunning(id, on))}
                />
              </Row>
            ) : null}
            {fwd ? (
              <Row title="Forward dev servers">
                <Switch aria-label={`Forward ${host.name}'s dev servers to this Mac`} checked={fwd.enabled} onCheckedChange={(on) => void run(() => setForwarding(id, on))} />
              </Row>
            ) : null}
            {runs ? (
              <Row title="Commands at once" description={<Facts parts={usageParts(host)} />}>
                <CommitField
                  kind="int"
                  aria-label={`Commands and jobs running at once from ${host.name}`}
                  value={host.maxRunning}
                  min={1}
                  max={MAC_BRIDGE_MAX_RUNNING_CAP}
                  className="w-16"
                  onCommit={(n) => n !== null && void run(() => setMacBridgeLimits(id, { maxRunning: n }))}
                />
              </Row>
            ) : null}
            <Row title="Threads at once" description={runs ? undefined : <Facts parts={usageParts(host)} />}>
              <CommitField
                kind="int"
                aria-label={`Threads ${host.name} may start on this Mac at once`}
                value={host.maxThreads}
                min={0}
                max={MAC_BRIDGE_MAX_THREADS_CAP}
                className="w-16"
                onCommit={(n) => n !== null && void run(() => setMacBridgeLimits(id, { maxThreads: n }))}
              />
            </Row>
          </Group>
          {host.policy !== "off" ? (
            <Group title="Shared folders" data-mac-bridge-shared={host.shared.length}>
              {host.shared.length === 0 ? (
                <p className="py-1.5 text-xs text-muted-foreground">
                  {host.policy === "full" ? "None: full access reads everywhere except keys and credentials" : "None: every read outside this Mac's projects asks"}
                </p>
              ) : null}
              {host.shared.map((folder) => (
                <Row key={folder} title={<span className="block truncate font-mono text-xs font-normal">{folder}</span>}>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={DANGER_GHOST}
                    onClick={() => void run(() => setMacBridgeShared(id, host.shared.filter((f) => f !== folder)))}
                  >
                    Remove
                  </Button>
                </Row>
              ))}
              <form
                className="flex items-center gap-2 pt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (path.trim()) void add(path.trim());
                }}
              >
                <Input
                  aria-label="Folder to share"
                  value={path}
                  placeholder="/Users/you/Documents/shared"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7 flex-1 font-mono text-xs"
                  onChange={(e) => setPath(e.target.value)}
                />
                <Button type="submit" variant="secondary" size="sm" disabled={!path.trim()}>
                  Add
                </Button>
                {isWebMode() ? null : (
                  <Button type="button" variant="secondary" size="sm" onClick={() => void browse()}>
                    Choose…
                  </Button>
                )}
              </form>
            </Group>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
