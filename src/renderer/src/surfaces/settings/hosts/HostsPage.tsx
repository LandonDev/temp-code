import { Fragment, useCallback, useEffect, useState } from "react";
import type { RemoteKey, RemotePairing, RemoteSession, RemoteStatus, SavedEnvironment } from "@server/shared/contract-remote";
import type { HarnessSyncStatus } from "@server/shared/contract-harness";
import type { MemorySyncStatus } from "@server/shared/contract-memory";
import type { AttachmentSettings } from "@server/shared/contract-attachments";
import { Button } from "../../../components/ui/button";
import { Separator } from "../../../components/ui/separator";
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
import { Group } from "./Group";
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
  const act = useCallback(
    async (method: string, params: unknown) => {
      try {
        await rpc(method, params);
        await refresh();
      } catch (err) {
        setError(errorText(err));
      }
    },
    [refresh],
  );
  /** Sync now on a host runs whichever legs are on: the harness config out, the memory both ways. */
  const sync = useCallback(
    async (environmentId: string, harnessOn: boolean, memoryOn: boolean) => {
      try {
        if (harnessOn) await rpc("harness.sync", { environmentId });
        if (memoryOn) await rpc("memory.sync", { environmentId });
        await refresh();
      } catch (err) {
        setError(errorText(err));
      }
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
      {sections.map((section, i) => (
        <Fragment key={section.id}>
          {i > 0 ? <Separator /> : null}
          <HostSection
            id={section.id}
            name={section.local && web ? status.name || section.name : section.name}
            saved={section.saved}
            onMenu={section.saved ? onMenu(section.saved) : undefined}
          >
            {section.local ? (
              <>
                <ThisHost
                  status={status}
                  attachments={attachments}
                  error={remote.error}
                  onSettings={(patch) => void remote.act("remote.settings.set", patch)}
                  onAct={(method, params) => void remote.act(method, params)}
                />
                <Clients
                  pairings={pairings}
                  keys={keys}
                  sessions={sessions}
                  onPair={() => setDialog({ kind: "pair" })}
                  onNewKey={() => setDialog({ kind: "key" })}
                  onAct={(method, params) => void remote.act(method, params)}
                />
                {web ? null : <LocalRelease />}
                <Group>
                  <HostAdmission environmentId={section.id} />
                  {web ? null : <LoadLimitRow />}
                </Group>
                {harness ? <LocalSync harness={harness} memory={memory} onAct={(method, params) => void remote.act(method, params)} /> : null}
                {web ? null : <MacBridgeRememberedSection />}
                {section.devices ? <DevicesGroup host={section.devices} onOpenSession={onOpenSession} /> : null}
              </>
            ) : (
              <>
                {section.saved ? (
                  <Group>
                    <HostDeploy environmentId={section.id} name={section.name} />
                    <HostAdmission environmentId={section.id} />
                  </Group>
                ) : null}
                {harness && section.saved ? (
                  <HostSync environmentId={section.id} harness={harness} memory={memory} onSync={(id, h, m) => void remote.sync(id, h, m)} />
                ) : null}
                {section.bridge ? <MacBridgeGroup host={section.bridge} /> : null}
                {section.devices ? <DevicesGroup host={section.devices} onOpenSession={onOpenSession} /> : null}
              </>
            )}
          </HostSection>
        </Fragment>
      ))}
      {hosts.error ? <p className="text-xs text-destructive">{hosts.error}</p> : null}
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

/** The page's shape while the first `remote.status` answers: a header and a few rows. */
function PageSkeleton({ error }: { error: string | null }) {
  return (
    <div className="flex flex-col gap-4" data-hosts-loading aria-busy="true">
      <Skeleton className="h-5 w-32" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-7 w-20" />
        </div>
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
