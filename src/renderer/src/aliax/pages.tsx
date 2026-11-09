import { registry, useEnvironments } from "../lib/connection";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ServiceId } from "aliax-core/shared/types";
import { isRoutedProvider, PROVIDER_OF, SIGN_IN_NAME, type AccountProvider } from "@shared/accounts";
import type { StatsBundle, StatsStatus } from "@shared/aliaxStats";
import { CANCELLED, SIGN_IN_REFRESHED } from "@shared/signInWords";
import { RefreshCw } from "@renderer/chrome/icons";
import { Page } from "@renderer/components/page";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Dialog } from "@renderer/components/ui/dialog";
import { ConfirmDialog, DialogFooter, ErrorLine } from "@renderer/chrome/ConfirmDialog";
import { ModalBody, ModalPanel } from "@renderer/chrome/Modal";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { displayName } from "@aliax/lib/accounts";
import { compact, localDayTime } from "@aliax/lib/viz";
import { AccountsSkeleton, AccountsView } from "@aliax/views/accounts";
import { AddKeyDialog } from "@aliax/views/AddKeyDialog";
import { StatsView } from "@aliax/views/stats";
import { useAliax } from "./useAliax";

type Result = { ok: boolean; error?: string; notes?: string[]; name?: string };

/** The account a Remove… asked about, held until the confirm's exit has played. */
type Removing = { serviceId: ServiceId; name: string; label: string; keyed: boolean };

/** A sign-in under way: the service, the address it was started for, and the error that stopped it. */
type Login = { serviceId: ServiceId; hint?: string; error: string | null };

export function AccountsPage(): React.JSX.Element {
  const { views, usage, layout, headroom, refresh, snapshot } = useAliax();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  /** The key service whose Add key… dialog is open. */
  const [keyFor, setKeyFor] = useState<ServiceId | null>(null);
  const keyProvider = keyFor ? PROVIDER_OF[keyFor] : undefined;
  // The page, not the row, holds the Remove confirm: the refreshed list drops
  // the row before the confirm's exit plays.
  const [removing, setRemoving] = useState<Removing | null>(null);
  // Each sign-in attempt's number: an answer for an attempt the person cancelled says nothing.
  const attempt = useRef(0);
  // The hosts this machine shares accounts with: the snapshot's peers, named by the registry.
  const environments = useEnvironments();
  const peers = snapshot.peers ?? {};
  const peerList = useMemo(
    () => Object.entries(peers).map(([id, p]) => ({ id, name: environments.find((e) => e.id === id)?.name ?? p.name ?? id })),
    [peers, environments],
  );
  const localName = environments.find((e) => e.id === registry.primary().environmentId)?.name ?? "this machine";

  const reload = async () => {
    setRefreshing(true);
    try {
      await refresh(true);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * A one-year token for one account, or for every Claude account at once:
   * minted in the main process, each row showing its own progress from the
   * snapshot; a sign-in window opens only for a row whose stored session has
   * lapsed.
   */
  const convert = async (name?: string) => {
    const result = await window.aliax.convertStatic(name);
    if (!result.ok) toast.error(result.error ?? "No token was made");
    else toast.success(result.notes?.[0] ?? `Token saved for ${result.name}`);
    await refresh(true);
  };
  const local = () => registry.primary();
  const onSetHome = async (provider: AccountProvider, environmentId: string | null) => {
    await local().request("accounts.setHome", { provider, environmentId });
    await refresh(true);
  };
  const onSync = async (environmentId: string) => {
    await local().request("accounts.sync", { environmentId });
    await refresh(true);
  };

  /** One action, one toast; the key stays busy until the refreshed list lands, so a switch holds on until the new snapshot does. */
  const run = async (key: string, action: () => Promise<Result>, fallback: string) => {
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) toast.success(result.notes?.[0] ?? fallback);
      else toast.error(result.error ?? "Something went wrong");
      await refresh(true);
    } finally {
      setBusy(null);
    }
  };

  /** Remove runs inside its confirm: a refusal is the confirm's red line and
   *  the dialog stays; once it lands the dialog closes and the toast says so. */
  const remove = async (serviceId: ServiceId, name: string) => {
    const result: Result = await window.aliax.remove(serviceId, name);
    if (!result.ok) throw new Error(result.error ?? "Something went wrong");
    toast.success(result.notes?.[0] ?? "Removed");
    await refresh(true);
  };

  const onUse = (serviceId: ServiceId, name: string) => run(`use:${serviceId}:${name}`, () => window.aliax.activate(serviceId, name), "Switched");

  /**
   * Adding never switches; the toast offers the switch. A hint pre-fills the
   * address so an expired account signs itself back in; re-signing the same
   * address refreshes the saved row in place. A closed window says nothing,
   * any other error is the dialog's one red line, never a toast.
   */
  const addAccount = async (serviceId: ServiceId, hint?: string) => {
    const n = ++attempt.current;
    setLogin({ serviceId, hint, error: null });
    const result: Result = await window.aliax.loginStart(serviceId, hint);
    if (n !== attempt.current) return;
    if (!result.ok) {
      if (result.error === CANCELLED) setLogin(null);
      else setLogin({ serviceId, hint, error: result.error ?? "Sign-in failed" });
      return;
    }
    setLogin(null);
    const notes = result.notes ?? [];
    const name = result.name;
    const rest = notes.filter((note) => note !== SIGN_IN_REFRESHED);
    if (name && notes.includes(SIGN_IN_REFRESHED)) toast.success(`Updated ${name}`, { description: rest[0] });
    else {
      toast.success(name ? `Added ${name}` : "Account added", {
        description: rest[0],
        action: name ? { label: "Switch to it", onClick: () => void onUse(serviceId, name) } : undefined,
      });
    }
    await refresh(true);
  };

  const closeLogin = () => {
    if (!login) return;
    attempt.current++;
    if (login.error === null) void window.aliax.loginCancel(login.serviceId);
    setLogin(null);
  };

  const loginName = views?.find((v) => v.id === login?.serviceId)?.name ?? "";

  return (
    <Page
      title="Accounts"
      width="table"
      description="The sign-ins and keys threads route through."
      actions={
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Refresh usage" disabled={refreshing} onClick={() => void reload()} />}>
            {refreshing ? <BusyLabel busy label="" /> : <RefreshCw />}
          </TooltipTrigger>
          <TooltipContent>Refresh usage</TooltipContent>
        </Tooltip>
      }
    >
      {views === null ? (
        <AccountsSkeleton />
      ) : (
        <AccountsView
          views={views}
          usage={usage}
          layout={layout}
          headroom={headroom}
          busy={busy}
          homes={snapshot.homes ?? {}}
          peers={peers}
          environments={peerList}
          localName={localName}
          mint={snapshot.providers.claude.mint}
          onCapture={(id) => void run(`capture:${id}`, () => window.aliax.capture(id), "Saved")}
          onAdd={(id) => void addAccount(id)}
          onAddKey={setKeyFor}
          onReauth={(id, email) => void addAccount(id, email)}
          onUse={(id, name) => void onUse(id, name)}
          onRemove={(serviceId, profile) => setRemoving({ serviceId, name: profile.name, label: displayName(profile), keyed: profile.kind === "key" })}
          onRefresh={() => void refresh(true)}
          onSetupToken={(_id, identity) => void convert(identity.name)}
          onConvertAll={() => void convert()}
          onSetHome={(provider, id) => void onSetHome(provider, id)}
          onSync={(id) => void onSync(id)}
        />
      )}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          body={removing.keyed ? "The key is deleted from every host. Adding it again brings it back." : "Its saved sign-in is deleted. Signing in again brings it back."}
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing.serviceId, removing.name)}
          onDone={() => setRemoving(null)}
        />
      ) : null}

      <AddKeyDialog
        open={keyFor !== null}
        onOpenChange={(open) => !open && setKeyFor(null)}
        serviceName={keyProvider && isRoutedProvider(keyProvider) ? SIGN_IN_NAME[keyProvider] : ""}
        submit={({ name, key }) => window.aliax.addKey({ serviceId: keyFor ?? "meta", name, key })}
        onAdded={(name) => {
          toast.success(name ? `Added ${name}` : "Key added");
          void refresh(true);
        }}
      />

      <Dialog open={login !== null} onOpenChange={(open) => !open && closeLogin()}>
        <ModalPanel
          title={`Sign in to ${loginName}`}
          size="sm"
          description={
            login?.error ? undefined : (
              <span className="inline-flex items-center gap-2">
                <Spinner />
                Finish in the window that opened
              </span>
            )
          }
        >
          {login?.error ? (
            <ModalBody>
              <ErrorLine error={login.error} />
            </ModalBody>
          ) : null}
          <DialogFooter
            onCancel={closeLogin}
            confirmLabel={login?.error ? "Try again" : undefined}
            onConfirm={login ? () => void addAccount(login.serviceId, login.hint) : undefined}
          />
        </ModalPanel>
      </Dialog>
    </Page>
  );
}

/**
 * History from the local session logs. The page owns the loading: the
 * bundle and the index status at mount, a 2.5 s poll while the first index
 * pass runs, and Reindex.
 */
export function StatsPage(): React.JSX.Element {
  const [data, setData] = useState<StatsBundle | null>(null);
  const [status, setStatus] = useState<StatsStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const load = useCallback(async () => {
    const [bundle, next] = await Promise.all([window.aliax.stats(), window.aliax.statsStatus()]);
    setData(bundle);
    setStatus(next);
  }, []);

  useEffect(() => {
    void load();
    // The first index pass walks thousands of files; poll until it settles.
    const timer = setInterval(async () => {
      const next = await window.aliax.statsStatus();
      setStatus(next);
      if (!next.indexing) {
        setData(await window.aliax.stats());
        clearInterval(timer);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [load]);

  const reindex = async () => {
    setReindexing(true);
    try {
      await window.aliax.statsReindex();
      await load();
    } finally {
      setReindexing(false);
    }
  };

  const description = data?.unavailable ? (
    <span className="text-destructive">Couldn't load the stats: {data.unavailable}</span>
  ) : status?.indexing
    ? `Indexing ${status.filesDone.toLocaleString()} of ${status.filesTotal.toLocaleString()} session logs`
    : data && data.totals.turns > 0
      ? `From ${compact(data.totals.turns)} turns in your local session logs, updated ${localDayTime(data.generatedAt)}`
      : undefined;

  return (
    <Page
      title="Stats"
      description={description}
      actions={
        <Button variant="ghost" size="sm" disabled={reindexing} onClick={() => void reindex()}>
          {reindexing ? <BusyLabel busy label="" /> : <RefreshCw />}
          Reindex
        </Button>
      }
    >
      <StatsView data={data} status={status} />
    </Page>
  );
}
