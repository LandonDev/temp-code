import { useCallback, useEffect, useState } from "react";
import type { MacBridgeHostPolicy, MacBridgePolicy } from "@server/shared/contract-macbridge";
import { trimNumber, type MacBridgeLoad } from "@server/shared/contract-macbridge";
import { macUrl } from "@server/shared/contract-ports";
import { Button } from "../../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { errorText } from "../../../chrome/ConfirmDialog";
import { MacBridgeRunningList } from "../../../chrome/MacBridgeRunning";
import { openUrl } from "../../../lib/devPorts";
import { refreshMacBridgeHosts, refreshMacBridgeLoad, setMacBridgeLoadLimit, setMacBridgePolicy, useMacBridgeLoad } from "../../../lib/macBridge";
import { useHostForwards } from "../../../lib/portForwards";
import { CommitField } from "./CommitField";
import { Facts } from "./Facts";
import { Group, Row } from "./Group";
import { MacBridgeHostDialog } from "./MacBridgeHostDialog";

/**
 * A host's Mac bridge on this Mac (docs/box.md "The Mac bridge"): what its
 * threads may do here, what runs or waits for it now (with Stop), and its
 * dev servers forwarded to this Mac's loopback. The caps,
 * forwarding and the shared folders are its Settings… dialog.
 */

export const POLICIES: { value: MacBridgePolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "read+run", label: "Read and run" },
  { value: "full", label: "Full access" },
];

/** What each level lets the host's threads do, in one line under Access. */
export const POLICY_TEXT: Record<MacBridgePolicy, string> = {
  off: "Nothing on this Mac",
  read: "Reads shared folders and projects; asks for the rest",
  "read+run": "Also runs commands; each asks unless remembered",
  full: "Any file except keys and credentials; commands ask unless remembered or from a thread in full access",
};

/** The host list and the Mac's load, every 5 s while the page shows (desktop only: the bridge is this Mac's). */
export function useMacBridgePolling(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const refresh = async (): Promise<void> => {
      // An older server answers an error: the bridge's rows stay away.
      if (!(await refreshMacBridgeHosts().then(() => true, () => false))) return;
      await refreshMacBridgeLoad().catch(() => null);
    };
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [enabled]);
}

export function MacBridgeGroup({ host }: { host: MacBridgeHostPolicy }) {
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  return (
    <Group
      title="Mac bridge"
      data-mac-bridge-host={host.environmentId}
      action={
        <Button variant="secondary" size="sm" onClick={() => setSettings(true)}>
          Settings…
        </Button>
      }
    >
      <Row title="Access" description={POLICY_TEXT[host.policy]} error={error}>
        <Select
          items={POLICIES}
          value={host.policy}
          onValueChange={(policy) => {
            if (policy && policy !== host.policy) void run(() => setMacBridgePolicy(host.environmentId, policy as MacBridgePolicy));
          }}
        >
          <SelectTrigger size="sm" aria-label={`What ${host.name} may do on this Mac`} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <MacBridgeRunningList environmentId={host.environmentId} hostName={host.name} />
      <Forwards environmentId={host.environmentId} />
      {settings ? <MacBridgeHostDialog host={host} onClose={() => setSettings(false)} /> : null}
    </Group>
  );
}

/** The host's dev servers forwarded to this Mac: the number here first, and why it moved when the host's own was taken. */
function Forwards({ environmentId }: { environmentId: string }) {
  const fwd = useHostForwards(environmentId);
  if (!fwd?.enabled || fwd.forwards.length === 0) return null;
  return (
    <div className="flex flex-col" data-port-forwards={environmentId}>
      {fwd.forwards.map((f) =>
        f.macPort === null ? (
          <Row
            key={f.id}
            data-port-forward={f.id}
            title={f.title}
            description={
              f.error ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="cursor-default text-destructive" />}>Not forwarded</TooltipTrigger>
                  <TooltipContent className="max-w-sm">{f.error}</TooltipContent>
                </Tooltip>
              ) : (
                <span className="text-destructive">Not forwarded</span>
              )
            }
          />
        ) : (
          <Row
            key={f.id}
            data-port-forward={f.id}
            title={f.title}
            description={<Facts parts={[`localhost:${f.macPort}`, ...(f.macPort !== f.port ? [`${f.port} is taken here`] : [])]} />}
          >
            <Button variant="ghost" size="sm" onClick={() => openUrl(macUrl(f.macPort as number))}>
              Open
            </Button>
          </Row>
        ),
      )}
    </div>
  );
}

/**
 * This Mac's load guard (docs/box.md "The load guard"): the one-minute load
 * beside the cores, and the limit over which new commands and jobs wait
 * (2 × cores until typed; an empty field follows the cores again).
 */
export function LoadLimitRow() {
  const load = useMacBridgeLoad();
  const [error, setError] = useState<string | null>(null);
  if (!load) return null;
  return <LoadLimit load={load} error={error} onError={setError} />;
}

function LoadLimit({ load, error, onError }: { load: MacBridgeLoad; error: string | null; onError: (e: string | null) => void }) {
  return (
    <Row
      title="Load limit"
      data-mac-bridge-load={load.busy ? "holding" : "ok"}
      description={
        <>
          <Facts parts={[`Load ${load.load.toFixed(1)}`, `${load.cores} cores`]} className="flex" />
          {load.busy ? <span className="block text-warning">Holding new commands until under {trimNumber(load.resumeBelow)}</span> : null}
        </>
      }
      error={error}
    >
      <CommitField
        kind="decimal"
        aria-label="Load limit"
        value={load.pinned ? load.limit : null}
        allowEmpty
        min={0.1}
        max={10_000}
        placeholder={trimNumber(load.limit)}
        onCommit={(n) => {
          onError(null);
          void setMacBridgeLoadLimit(n).catch((e) => onError(errorText(e)));
        }}
      />
    </Row>
  );
}
