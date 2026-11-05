import { Fragment, useCallback, useEffect, useState } from "react";
import type { RemoteKey, RemotePairing, RemoteSession, RemoteStatus, SavedEnvironment } from "@server/shared/contract-remote";
import type { HarnessSyncStatus } from "@server/shared/contract-harness";
import type { MemorySyncStatus } from "@server/shared/contract-memory";
import type { AttachmentSettings } from "@server/shared/contract-attachments";
import { PageError, PageRowsSkeleton } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { ConfirmDialog, errorText } from "../../../chrome/ConfirmDialog";
import { forgetSeen, useEnvironments } from "../../../lib/connection";
import { useHostDevicesHosts } from "../../../lib/hostDevices";
import { useMacBridgeHosts } from "../../../lib/macBridge";
import { isWebMode } from "../../../lib/nativeWeb";
import { loadSavedEnvironments } from "../../../lib/tcserver/link";
import { environment as environmentSelection } from "../../../stores/environment";
import { MacBridgeRememberedSection } from "../../../chrome/MacBridgeRemember";
import { HostAdmission } from "./Admission";
import { Clients } from "./Clients";
import { HostDeploy, LocalRelease, useJobPolling } from "./Deploy";
import { DevicesGroup, useDevicesPolling } from "./Devices";
import { AddHostDialog } from "./dialogs/AddHostDialog";
import { NewKeyDialog } from "./dialogs/NewKeyDialog";
import { PairDialog } from "./dialogs/PairDialog";
import { RenameHostDialog } from "./dialogs/RenameHostDialog";
import { RoutesDialog } from "./dialogs/RoutesDialog";
import { hostSections } from "./hostSections";
import { LoadLimitRow, MacBridgeGroup, useMacBridgePolling } from "./MacBridgeGroup";
import { HostSection, type HostMenuAction } from "./HostSection";
import { rpc } from "./rpc";
import { HostSync, LocalSync } from "./Sync";
import { ThisHost } from "./ThisHost";

/**
 * Settings → Hosts (docs/LAYOUT.md "Settings"): this machine and every host
 * it is paired with, one section each, this machine first. A section is a
 * header row and that host's groups; whatever is rarely touched (routes,
 * rename, the Mac bridge's caps and folders) sits behind a dialog or the
 * host's menu. Every RPC, poll and confirm is the one the two pages it
 * replaced (Remote access, Environments) had.
 */

const POLL_MS = 5000;

type Dialog =
  | { kind: "key" }
  | { kind: "pair" }
  | { kind: "add"; repair?: SavedEnvironment }
  | { kind: "rename"; env: SavedEnvironment }
  | { kind: "routes"; env: SavedEnvironment }
  | { kind: "remove"; env: SavedEnvironment };

type RemoteData = {
  status: RemoteStatus;
  keys: RemoteKey[];
  pairings: RemotePairing[];
  sessions: RemoteSession[];
  harness: HarnessSyncStatus | null;
  memory: MemorySyncStatus | null;
  attachments: AttachmentSettings | null;
};

/** This host's remote access: the listener, its clients and the sync, read every 5 s so a phone pairing shows without a click. */
function useRemoteData() {
  const [data, setData] = useState<RemoteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [status, keys, pairings, sessions, harness, memory, attachments] = await Promise.all([
        rpc<RemoteStatus>("remote.status"),
        rpc<RemoteKey[]>("remote.keys.list"),
        rpc<RemotePairing[]>("remote.pairings.list"),
        rpc<RemoteSession[]>("remote.sessions.list"),
        // An older host without the sync answers an error: its rows stay away.
        rpc<HarnessSyncStatus>("harness.status").catch(() => null),
        rpc<MemorySyncStatus>("memory.status").catch(() => null),
        rpc<AttachmentSettings>("attachment.settings", {}).catch(() => null),
      ]);
      setData({ status, keys, pairings, sessions, harness, memory, attachments });
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);
  /** Resolves null once the call landed, else its failure, which the
   *  caller says under its own row (never the page's: the listener's
   *  line is Remote access's alone). */
  const act = useCallback(
    async (method: string, params: unknown): Promise<string | null> => {
      try {
        await rpc(method, params);
      } catch (err) {
        return errorText(err);
      }
      await refresh();
      return null;
    },
    [refresh],
  );
  /** Sync now on a host runs whichever legs are on: the harness config out, the memory both ways. */
  const sync = useCallback(
    async (environmentId: string, harnessOn: boolean, memoryOn: boolean): Promise<string | null> => {
      try {
        if (harnessOn) await rpc("harness.sync", { environmentId });
        if (memoryOn) await rpc("memory.sync", { environmentId });
      } catch (err) {
        return errorText(err);
      }
      await refresh();
      return null;
    },
    [refresh],
  );
  return { data, error, refresh, act, sync };
}

/** The hosts this window has paired (desktop only: a web page reaches one host). */
function useSavedHosts(web: boolean) {
  const [saved, setSaved] = useState<SavedEnvironment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (web) return;
    try {
      setSaved(await rpc<SavedEnvironment[]>("remote.environments.list"));
      setError(null);
      await loadSavedEnvironments();
    } catch (err) {
      setError(errorText(err));
    }
  }, [web]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { saved, error, refresh };
}

export function HostsPage({ onOpenSession }: { onOpenSession?: (sessionId: string) => void } = {}) {
  const web = isWebMode();
  const remote = useRemoteData();
  const hosts = useSavedHosts(web);
  const environments = useEnvironments();
  const bridgeHosts = useMacBridgeHosts();
  const deviceHosts = useHostDevicesHosts();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useJobPolling(
    hosts.saved.map((h) => h.id),
    !web,
  );
  useMacBridgePolling(!web);
  useDevicesPolling();

  if (!remote.data) return <PageSkeleton error={remote.error} />;
  const { status, keys, pairings, sessions, harness, memory, attachments } = remote.data;
  const sections = hostSections({ environments, saved: hosts.saved, bridgeHosts, deviceHosts: deviceHosts ?? [], web });
  const close = (): void => setDialog(null);
  const onMenu = (env: SavedEnvironment) => (action: HostMenuAction) =>
    setDialog(action === "repair" ? { kind: "add", repair: env } : { kind: action, env });
  const remove = async (env: SavedEnvironment): Promise<void> => {
    await rpc("remote.environments.remove", { id: env.id });
    environmentSelection.forget(env.id);
    forgetSeen(env.id);
    await hosts.refresh();
  };

  return (
    <div className="flex flex-col gap-6" data-hosts-page>
      {sections.map((section) => (
        <Fragment key={section.id}>
          {section.local || section.saved ? (
            <HostSection
              id={section.id}
              name={section.local && web ? status.name || section.name : section.name}
              saved={section.saved}
              environmentId={section.local ? status.environmentId : undefined}
              onMenu={section.saved ? onMenu(section.saved) : undefined}
            >
              {section.local ? (
                <>
                  <ThisHost
                    status={status}
                    attachments={attachments}
                    error={remote.error}
                    onSettings={(patch) => remote.act("remote.settings.set", patch)}
                    onAct={remote.act}
                  />
                  <HostAdmission environmentId={section.id} />
                  {web ? null : <LoadLimitRow />}
                </>
              ) : (
                <>
                  <HostDeploy environmentId={section.id} name={section.name} />
                  <HostAdmission environmentId={section.id} />
                  {harness ? (
                    <HostSync environmentId={section.id} harness={harness} memory={memory} onSync={remote.sync} />
                  ) : null}
                </>
              )}
            </HostSection>
          ) : null}
          {section.local ? (
            <>
              <Clients
                pairings={pairings}
                keys={keys}
                sessions={sessions}
                onPair={() => setDialog({ kind: "pair" })}
                onNewKey={() => setDialog({ kind: "key" })}
                onAct={remote.act}
              />
              {web ? null : <LocalRelease />}
              {harness ? <LocalSync harness={harness} memory={memory} onAct={remote.act} /> : null}
              {web ? null : <MacBridgeRememberedSection />}
            </>
          ) : null}
          {section.bridge ? <MacBridgeGroup host={section.bridge} /> : null}
          {section.devices ? <DevicesGroup host={section.devices} onOpenSession={onOpenSession} /> : null}
        </Fragment>
      ))}
      {hosts.error ? <PageError>{hosts.error}</PageError> : null}
      {web ? null : (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "add" })}>
            Add host
          </Button>
        </div>
      )}

      {dialog?.kind === "key" ? <NewKeyDialog onClose={close} onChanged={remote.refresh} /> : null}
      {dialog?.kind === "pair" ? <PairDialog onClose={close} onChanged={remote.refresh} /> : null}
      {dialog?.kind === "add" ? <AddHostDialog repair={dialog.repair} onClose={close} onChanged={hosts.refresh} /> : null}
      {dialog?.kind === "rename" ? <RenameHostDialog env={dialog.env} onClose={close} onChanged={hosts.refresh} /> : null}
      {dialog?.kind === "routes" ? <RoutesDialog env={dialog.env} onClose={close} onChanged={hosts.refresh} /> : null}
      {dialog?.kind === "remove" ? (
        <ConfirmDialog
          title={`Remove ${dialog.env.name}`}
          body="This window forgets the host and its key. Nothing changes on the host."
          confirmLabel="Remove"
          danger
          onCancel={close}
          onConfirm={async () => {
            await remove(dialog.env);
            close();
          }}
        />
      ) : null}
    </div>
  );
}

/** This machine's first rows (Remote access, Port, Public origin, Stuck after). */
const THIS_HOST_SKELETON = [
  { description: true, control: "switch" },
  { control: "number" },
  { description: true, control: "field" },
  { description: true, control: "number" },
] as const;

/** The page's shape while the first `remote.status` answers: this machine's
 *  section, its 12px heading on its 20px line and its first rows. */
function PageSkeleton({ error }: { error: string | null }) {
  return (
    <div className="flex flex-col" data-hosts-loading aria-busy="true">
      <div className="flex h-5 items-center">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="mt-2">
        <PageRowsSkeleton rows={THIS_HOST_SKELETON} />
      </div>
      {error ? <PageError>{error}</PageError> : null}
    </div>
  );
}
