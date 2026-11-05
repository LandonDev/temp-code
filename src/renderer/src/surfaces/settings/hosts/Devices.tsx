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
import { PageEmpty, PageError, PageRowsSkeleton } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { reveal } from "../../../components/ui/reveal";
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

  // The heading says what the rows cannot: the Xcode in use, and the load when the page has no Load limit row
  // for this Mac. Each simulator and phone, with its state, is a row of its own, so the heading names none.
  const summaryParts = report
    ? [
        ...splitFacts(devicesSummary(report)).filter((part) => part.startsWith("load ") && !loadElsewhere),
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
        <div data-looking>
          <PageRowsSkeleton rows={2} description control="none" />
        </div>
      ) : null}
      {error && !report ? <PageError>{error}</PageError> : null}
      {report ? (
        <>
          {report.simulators.length === 0 ? (
            <PageEmpty data-empty>No simulators</PageEmpty>
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
                  Shut down
                </Button>
              ) : null}
              <Button variant="ghost" className="text-muted-foreground hover:text-destructive" size="xs" disabled={busy !== null} onClick={() => setConfirm(sim)}>
                Delete
              </Button>
            </DeviceRow>
          ))}
          {report.phones.map((phone) => (
            <DeviceRow
              key={phone.udid}
              udid={phone.udid}
              name={phone.name}
              // The model only when the owner's name for it says something else.
              detail={<Facts parts={phone.model && phone.model !== phone.name ? [phone.model, phone.os] : [phone.os]} />}
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
      {failed ? <PageError>{failed}</PageError> : null}
      {confirm ? (
        <ConfirmDialog
          {...deleteSimulatorConfirm(confirm)}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(null)}
          // The delete runs inside the confirm: a refusal is its red line and it stays.
          onConfirm={async () => {
            setBusy(confirm.udid);
            setFailed(null);
            try {
              await onDelete(confirm.udid);
            } finally {
              setBusy(null);
            }
          }}
          onDone={() => setConfirm(null)}
        />
      ) : null}
    </Group>
  );
}

/** "Booted", "34% CPU"; "Shut down"; the simulator's own word while it changes. */
export const simulatorState = (sim: Simulator): string[] => {
  if (sim.state === "booted") return sim.cpu !== undefined ? ["Booted", `${Math.round(sim.cpu)}% CPU`] : ["Booted"];
  if (sim.state === "shutdown") return ["Shut down"];
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
            onOpenSession ? (
              // The 16px link reaches 24px; its words truncate inside it, so nothing clips the hit area.
              <span data-holder className="flex min-w-0">
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto max-w-full min-w-0 shrink px-0 text-xs font-normal text-muted-foreground hover:text-foreground after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']"
                  onClick={() => onOpenSession(holder.sessionId)}
                >
                  <span className="min-w-0 truncate">{holderText(holder)}</span>
                </Button>
              </span>
            ) : (
              <span data-holder className="block truncate">
                {holderText(holder)}
              </span>
            )
          ) : null}
        </>
      }
    >
      {/* The actions wait on the shared hover reveal; a busy row keeps them shown. */}
      <span data-device-actions className={`flex items-center gap-1 ${busy ? "" : reveal("item", { row: true })}`}>{children}</span>
      <Facts parts={state} className="text-xs text-muted-foreground" />
    </Row>
  );
}
