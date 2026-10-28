import { useCallback, useEffect, useState, type ReactNode } from "react";
import { InboxProviderMark } from "../../chrome/InboxProviderMark";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import { SettingSwitch } from "../../components/setting-switch";
import {
  loadTranscriptAnchor,
  saveTranscriptAnchor,
  TRANSCRIPT_ANCHOR_CHANGE_EVENT,
} from "../../lib/appearance";
import { IS_MAC } from "../../lib/platform";
import { clearInboxCache } from "../../lib/githubTasks";
import {
  disconnectLinear,
  linearConnected,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  notifyLinearChange,
  saveHiddenLinearTeamIds,
  saveLinearToken,
  type LinearTeam,
} from "../../lib/linear";
import { BUNDLED_RELEASE } from "../../lib/releaseNotes";
import {
  loadMidTurnDefault,
  saveMidTurnDefault,
  type MidTurnDefault,
} from "../../lib/settings";
import { loadSoundsEnabled, saveSoundsEnabled } from "../../lib/sounds";
import { registry } from "../../lib/connection";
import { updateStore, useUpdateSnapshot } from "../../lib/updateStore";
import { MANUAL_DOWNLOAD_URL, canRetry } from "../../lib/updater";
import { isWebMode, openUrl } from "../../lib/native";
import { releaseNotesChunk } from "../chunks";
import { Keys } from "./keys";

/** A stored boolean setting with its own state; every flip saves. */
function useStoredFlag(load: () => boolean, save: (on: boolean) => void): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(load);
  return [
    on,
    (next) => {
      save(next);
      setOn(next);
    },
  ];
}

/** A row whose control is one switch, named by the row's title. */
function SwitchRow({
  title,
  description,
  on,
  onChange,
}: {
  title: string;
  description?: ReactNode;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <PageRow title={title} description={description}>
      <SettingSwitch label={title} on={on} onChange={onChange} />
    </PageRow>
  );
}

const MOD_ENTER = IS_MAC ? ["⌘", "↩"] : ["Ctrl", "Enter"];

export function GeneralPage({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string, markdown?: string) => void;
}) {
  const [transcriptAnchor, setTranscriptAnchor] = useState(loadTranscriptAnchor);
  const [midTurn, setMidTurn] = useState<MidTurnDefault>(loadMidTurnDefault);
  const [soundsEnabled, setSoundsEnabled] = useStoredFlag(loadSoundsEnabled, saveSoundsEnabled);

  // The menu flips the anchor too; follow it while the page is open.
  useEffect(() => {
    const onAnchor = (event: Event) => setTranscriptAnchor((event as CustomEvent<boolean>).detail === true);
    window.addEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    return () => window.removeEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
  }, []);


  return (
    <>
      <PageSection title="Transcript">
        <SwitchRow
          title="Prompt at the top"
          description="A sent prompt sits at the top and the reply grows below it."
          on={transcriptAnchor}
          onChange={(next) => {
            saveTranscriptAnchor(next);
            setTranscriptAnchor(next);
          }}
        />
      </PageSection>

      <PageSection title="Composer">
        <PageRow
          title="Enter during a turn"
          description={
            <>
              Queue waits for the turn, Steer sends into it;
              <Keys keys={MOD_ENTER} />
              does the other.
            </>
          }
        >
          <ChoiceSelect
            label="Enter during a turn"
            value={midTurn}
            options={[
              { value: "queue", label: "Queue" },
              { value: "steer", label: "Steer" },
            ]}
            onChange={(next) => {
              saveMidTurnDefault(next);
              setMidTurn(next);
            }}
          />
        </PageRow>
      </PageSection>

      <LinearSettings />

      <PageSection title="Extras">
        <SwitchRow
          title="Sounds"
          on={soundsEnabled}
          onChange={setSoundsEnabled}
        />
      </PageSection>

      {/* The page at /ui updates with its host; the browser has nothing to install. */}
      {isWebMode() ? null : (
        <PageSection title="About">
          <UpdateRow />
          <ReleaseNotesRow onOpenWhatsNew={onOpenWhatsNew} />
        </PageSection>
      )}
    </>
  );
}

function LinearSettings() {
  const [connecting, setConnecting] = useState(false);
  // null until the host answers: the key field and Connect would otherwise
  // show for a connected account and then flip to Disconnect.
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [hiddenTeamIds, setHiddenTeamIds] = useState(loadHiddenLinearTeamIds);

  const loadTeams = useCallback(async () => {
    try {
      const next = await listLinearTeams(registry.primary().environmentId);
      setTeams(next);
    } catch {
      setTeams([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void linearConnected(registry.primary().environmentId)
      .then((status) => {
        if (cancelled) return;
        setConnected(status.connected);
        if (status.connected) void loadTeams();
      })
      .catch(() => !cancelled && setConnected(false));
    return () => {
      cancelled = true;
    };
  }, [loadTeams]);

  // The dialog awaits this; a refusal stays in the dialog as its red line.
  const onConnect = async (token: string) => {
    await saveLinearToken(registry.primary().environmentId, token);
    setConnected(true);
    setConnecting(false);
    clearInboxCache();
    notifyLinearChange();
    await loadTeams();
  };

  const onDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectLinear(registry.primary().environmentId);
      setConnected(false);
      setTeams([]);
      clearInboxCache();
      notifyLinearChange();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleTeam = (id: string) => {
    const next = new Set(hiddenTeamIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ids = [...next];
    setHiddenTeamIds(ids);
    saveHiddenLinearTeamIds(ids);
    clearInboxCache();
  };

  return (
    <>
      <PageSection title="Linear">
        {connected === null ? (
          <PageRowsSkeleton rows={1} />
        ) : (
          <PageRow
            media={<InboxProviderMark provider="linear" className="size-4" />}
            title="API key"
            // The title and the one control say it all; where to make a key is Connect…'s line.
            error={error}
          >
            {connected ? (
              <Button variant="secondary" size="sm" onClick={() => void onDisconnect()} disabled={busy}>
                {busy ? <Spinner className="size-3.5" /> : null}
                Disconnect
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setConnecting(true)}>
                Connect…
              </Button>
            )}
          </PageRow>
        )}
      </PageSection>
      <ConnectLinearDialog open={connecting} onClose={() => setConnecting(false)} onConnect={onConnect} />
      {connected && teams.length > 0 ? (
        <PageSection title="Teams in the inbox">
          {teams.map((team) => (
            <PageRow key={team.id} title={team.name} description={team.key || undefined}>
              <Checkbox
                aria-label={team.name}
                checked={!hiddenTeamIds.includes(team.id)}
                onCheckedChange={() => toggleTeam(team.id)}
              />
            </PageRow>
          ))}
        </PageSection>
      ) : null}
    </>
  );
}

/** The key field behind Linear's Connect…: Enter or Connect checks it with
 *  the host; a refusal stays here as the red line, success closes it. */
function ConnectLinearDialog({
  open,
  onClose,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  onConnect: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setToken("");
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConnect(token.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Connect Linear</DialogTitle>
          <DialogDescription>Create a personal key in Linear, under Settings, Security and access.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input
            autoFocus
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="lin_api_…"
            aria-label="Linear API key"
            autoComplete="off"
            spellCheck={false}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !token.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UpdateRow() {
  const snapshot = useUpdateSnapshot();
  const downloading = snapshot.phase === "downloading";
  const ready = snapshot.phase === "ready";
  const busy = snapshot.phase === "checking" || downloading;
  const hasUpdate = snapshot.phase === "available";
  const canApply = snapshot.canApply === true;

  const status = downloading
    ? `Downloading ${snapshot.availableVersion ?? "the update"}…`
    : ready
      ? `Release ${snapshot.availableVersion} is downloaded. Restart to finish.`
      : snapshot.phase === "checking"
        ? "Checking…"
        : snapshot.phase === "error"
          ? (snapshot.error ?? "Update failed.")
          : hasUpdate
            ? canApply
              ? (snapshot.notes ??
                `Release ${snapshot.availableVersion} is ready.`)
              : `Release ${snapshot.availableVersion} is out. Dev build — updates apply to the installed app.`
            : snapshot.canApply === false
              ? "Dev build — updates apply to the installed app."
              : "Up to date.";

  const retry = canRetry(snapshot);
  const actionable = (hasUpdate && canApply) || ready || retry;

  const failed = snapshot.phase === "error";
  return (
    <PageRow
      title={
        <>
          Release
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{snapshot.currentVersion}</span>
        </>
      }
      description={
        failed ? undefined : (
          <>
            {status}
            {downloading ? (
              <Progress aria-label="Download" value={Math.round(snapshot.percent ?? 0)} className="mt-2 w-64" />
            ) : null}
          </>
        )
      }
      error={
        failed ? (
          <>
            {status}
            {canApply ? (
              <>
                {" "}
                <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => void openUrl(MANUAL_DOWNLOAD_URL)}>
                  Download the installer
                </Button>
              </>
            ) : null}
          </>
        ) : undefined
      }
    >
      <Button
        variant={actionable ? "default" : "secondary"}
        size="sm"
        onClick={() => void (actionable ? updateStore.install() : updateStore.check(true))}
        disabled={busy}
      >
        {busy ? <Spinner className="size-3.5" /> : null}
        {updateActionLabel(snapshot.phase, { canApply, retry })}
      </Button>
    </PageRow>
  );
}

/** The release notes: a waiting update's from the feed, else the ones this
 *  build shipped with (its version is already on the Release row). */
function ReleaseNotesRow({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string, markdown?: string) => void;
}) {
  const snapshot = useUpdateSnapshot();
  const waiting = snapshot.phase === "available" && snapshot.availableVersion && snapshot.notes ? snapshot : null;
  const open = () =>
    waiting
      ? onOpenWhatsNew(waiting.availableVersion!, waiting.notes!)
      : onOpenWhatsNew(BUNDLED_RELEASE.version, BUNDLED_RELEASE.notes);
  return (
    <PageRow title="Release notes" description={waiting ? `For ${waiting.availableVersion}` : undefined}>
      <span className="contents" {...releaseNotesChunk.intent}>
        <Button variant="secondary" size="sm" onClick={open}>
          Open
        </Button>
      </span>
    </PageRow>
  );
}

/** The update button's word for the updater's phase. */
export function updateActionLabel(
  phase: ReturnType<typeof useUpdateSnapshot>["phase"],
  { canApply, retry }: { canApply: boolean; retry: boolean },
): string {
  if (phase === "ready") return "Restart";
  if (retry) return "Retry";
  if (phase === "available" && canApply) return "Update";
  return "Check for updates";
}
