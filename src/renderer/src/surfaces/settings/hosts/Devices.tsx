import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  deleteSimulatorConfirm,
  devicesSummary,
  holderText,
  type HostDevicesHost,
  type HostDevicesReport,
  type Phone,
  type Simulator,
} from "@server/shared/contract-hostdevices";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { ConfirmDialog, errorText } from "../../../chrome/ConfirmDialog";
import { deleteSimulator, openXcodeDevices, refreshHostDevicesHosts, shutdownSimulator, useHostDevices } from "../../../lib/hostDevices";
import { isWebMode } from "../../../lib/nativeWeb";
import { Facts, splitFacts } from "./Facts";
import { Group, Row } from "./Group";

/**
 * The devices a Mac is running (docs/box.md "Devices on the Mac"), in that
 * Mac's section: the summary at the heading's end, one row per simulator and
 * iPhone with its state, the thread that holds it, and on hover or focus its
 * actions (Shutdown, Delete behind a confirm that names the holder; Open in
 * Xcode for an iPhone). The report is read every 30 s only while the group
 * is on screen; the list of Macs every 15 s while the page is.
 */

export function useDevicesPolling(): void {
  useEffect(() => {
    void refreshHostDevicesHosts().catch(() => {});
    const t = window.setInterval(() => void refreshHostDevicesHosts().catch(() => {}), 15_000);
    return () => window.clearInterval(t);
  }, []);
}

export function DevicesGroup({ host, onOpenSession }: { host: HostDevicesHost; onOpenSession?: (sessionId: string) => void }) {
  const { report, error } = useHostDevices(host.environmentId);
  const id = host.environmentId;
  return (
    <DevicesBlock
      host={host}
      report={report}
      error={error}
      onOpenSession={onOpenSession}
      onShutdown={(udid) => shutdownSimulator(id, udid)}
      onDelete={(udid) => deleteSimulator(id, udid)}
      onOpenXcode={() => openXcodeDevices(id)}
      loadElsewhere={host.local && !isWebMode()}
    />
  );
}

export interface DevicesBlockProps {
  host: HostDevicesHost;
  report: HostDevicesReport | null;
  error: string | null;
  onOpenSession?: (sessionId: string) => void;
  onShutdown: (udid: string) => Promise<unknown>;
  onDelete: (udid: string) => Promise<unknown>;
  onOpenXcode: () => Promise<unknown>;
  /** The page shows this Mac's load in its Load limit row (the desktop's own Mac); else the heading keeps it. */
  loadElsewhere?: boolean;
}

/** The group itself, with everything it shows passed in (the dom test renders this). */
export function DevicesBlock({ host, report, error, onOpenSession, onShutdown, onDelete, onOpenXcode, loadElsewhere = false }: DevicesBlockProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Simulator | null>(null);
  const run = useCallback(async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setFailed(null);
    try {
      await work();
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setBusy(null);
    }
  }, []);

  // The heading says what the rows cannot: the phones' state and the Xcode in use. The simulator count is the
  // rows themselves; the load is the Load limit row's when the page has one for this Mac.
  const summaryParts = report
    ? [
        ...splitFacts(devicesSummary(report)).filter((part) => !/^(No simulators|\d+ simulators?)/.test(part) && !(loadElsewhere && part.startsWith("load "))),
        ...(report.xcode ? [`${report.xcode.name}${report.xcode.version ? ` ${report.xcode.version}` : ""}`] : []),
        ...(report.xcode?.from === "developerDir" ? ["DEVELOPER_DIR"] : []),
        ...report.problems,
      ]
    : [];
  const summary = report ? (
    <Facts parts={summaryParts} className="justify-end text-xs text-muted-foreground" />
  ) : error ? (
    <span className="text-xs text-muted-foreground">Not reachable</span>
  ) : null;

  return (
    <Group title={host.local ? "Devices" : `Devices on ${host.name}`} data-devices={host.environmentId} action={<span data-summary className="min-w-0">{summary}</span>}>
      {!report && !error ? (
        <div data-looking className="flex flex-col gap-2 py-2" aria-busy="true">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-56" />
        </div>
      ) : null}
      {error && !report ? <p className="py-1.5 text-xs text-destructive">{error}</p> : null}
      {report ? (
        <>
          {report.simulators.length === 0 ? (
            <p className="py-1.5 text-xs text-muted-foreground" data-empty>
              No simulators
            </p>
          ) : null}
          {report.simulators.map((sim) => (
            <DeviceRow
              key={sim.udid}
              udid={sim.udid}
              name={sim.name}
              detail={sim.runtime}
              state={simulatorState(sim)}
              holder={sim.holder}
              onOpenSession={onOpenSession}
              busy={busy === sim.udid}
            >
              {sim.state === "booted" ? (
                <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void run(sim.udid, () => onShutdown(sim.udid))}>
                  Shutdown
                </Button>
              ) : null}
              <Button variant="destructive" size="xs" disabled={busy !== null} onClick={() => setConfirm(sim)}>
                Delete
              </Button>
            </DeviceRow>
          ))}
          {report.phones.map((phone) => (
            <DeviceRow
              key={phone.udid}
              udid={phone.udid}
              name={phone.model}
              detail={<Facts parts={[phone.name, phone.os]} />}
              state={phoneState(phone)}
              holder={phone.holder}
              onOpenSession={onOpenSession}
              busy={busy === "xcode"}
            >
              <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void run("xcode", onOpenXcode)}>
                Open in Xcode
              </Button>
            </DeviceRow>
          ))}
        </>
      ) : null}
      {failed ? <p className="pt-1 text-xs text-destructive">{failed}</p> : null}
      {confirm ? (
        <ConfirmDialog
          {...deleteSimulatorConfirm(confirm)}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const udid = confirm.udid;
            setConfirm(null);
            await run(udid, () => onDelete(udid));
          }}
        />
      ) : null}
    </Group>
  );
}

/** "Booted", "34% CPU"; "Shutdown"; the simulator's own word while it changes. */
export const simulatorState = (sim: Simulator): string[] => {
  if (sim.state === "booted") return sim.cpu !== undefined ? ["Booted", `${Math.round(sim.cpu)}% CPU`] : ["Booted"];
  if (sim.state === "shutdown") return ["Shutdown"];
  return [sim.stateText ?? "Changing"];
};

/** "Connected", "USB"; "Paired"; "Unavailable". */
export const phoneState = (phone: Phone): string[] => {
  if (phone.connection === "connected") return phone.transport ? ["Connected", phone.transport] : ["Connected"];
  if (phone.connection === "paired") return ["Paired"];
  return ["Unavailable"];
};

function DeviceRow({
  udid,
  name,
  detail,
  state,
  holder,
  onOpenSession,
  busy,
  children,
}: {
  udid: string;
  name: string;
  detail: ReactNode;
  state: string[];
  holder: Simulator["holder"];
  onOpenSession?: (sessionId: string) => void;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <Row
      title={name}
      data-device={udid}
      description={
        <>
          {detail}
          {holder ? (
            <span data-holder className="block truncate">
              {onOpenSession ? (
                <Button variant="link" size="xs" className="h-auto max-w-full truncate px-0 text-xs font-normal text-muted-foreground hover:text-foreground" onClick={() => onOpenSession(holder.sessionId)}>
                  {holderText(holder)}
                </Button>
              ) : (
                holderText(holder)
              )}
            </span>
          ) : null}
        </>
      }
    >
      {/* The actions show on hover or focus, with no transition: rows do not move. */}
      <span className={`flex items-center gap-1 ${busy ? "" : "opacity-0 group-hover/item:opacity-100 focus-within:opacity-100"}`}>{children}</span>
      <Facts parts={state} className="text-xs text-muted-foreground" />
    </Row>
  );
}
