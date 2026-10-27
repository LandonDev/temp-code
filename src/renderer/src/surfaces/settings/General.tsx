import { useCallback, useEffect, useState, type ReactNode } from "react";
import { InboxProviderMark } from "../../chrome/InboxProviderMark";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Kbd, KbdGroup } from "../../components/ui/kbd";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import { SettingSwitch } from "../../components/setting-switch";
import {
  loadTranscriptLayout,
  loadTranscriptAnchor,
  saveTranscriptLayout,
  saveTranscriptAnchor,
  TRANSCRIPT_ANCHOR_CHANGE_EVENT,
  type TranscriptLayout,
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
  loadClaudeHooks,
  loadComposerRunner,
  loadGridArcadeEnabled,
  loadMidTurnDefault,
  loadLiveAgentsEnabled,
  loadNotesEnabled,
  saveClaudeHooks,
  saveComposerRunner,
  saveGridArcadeEnabled,
  saveMidTurnDefault,
  saveLiveAgentsEnabled,
  saveNotesEnabled,
  type MidTurnDefault,
} from "../../lib/settings";
import { loadSoundsEnabled, saveSoundsEnabled } from "../../lib/sounds";
import { registry } from "../../lib/connection";
import { EditorRow } from "../EditorRow";
import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { updateStore, useUpdateSnapshot } from "../../lib/updateStore";
import { MANUAL_DOWNLOAD_URL, canRetry } from "../../lib/updater";
import { openUrl } from "../../lib/native";
import { releaseNotesChunk } from "../chunks";

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

/** Keys as caps: "⌘ ↩" on macOS, "Ctrl Enter" elsewhere. */
export function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup className="mx-0.5 align-[-2px]">
      {keys.map((key) => (
        <Kbd key={key} size="sm">
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

const MOD_ENTER = IS_MAC ? ["⌘", "↩"] : ["Ctrl", "Enter"];

export function GeneralPage({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string, markdown?: string) => void;
}) {
  const [transcriptLayout, setTranscriptLayout] = useState<TranscriptLayout>(loadTranscriptLayout);
  const [transcriptAnchor, setTranscriptAnchor] = useState(loadTranscriptAnchor);
  const [midTurn, setMidTurn] = useState<MidTurnDefault>(loadMidTurnDefault);
  const [composerRunner, setComposerRunner] = useStoredFlag(loadComposerRunner, saveComposerRunner);
  const [notesEnabled, setNotesEnabled] = useStoredFlag(loadNotesEnabled, saveNotesEnabled);
  const [liveAgentsEnabled, setLiveAgentsEnabled] = useStoredFlag(loadLiveAgentsEnabled, saveLiveAgentsEnabled);
  const [soundsEnabled, setSoundsEnabled] = useStoredFlag(loadSoundsEnabled, saveSoundsEnabled);
  const [gridArcadeEnabled, setGridArcadeEnabled] = useStoredFlag(loadGridArcadeEnabled, saveGridArcadeEnabled);
  const [claudeHooks, setClaudeHooks] = useStoredFlag(loadClaudeHooks, saveClaudeHooks);

  // The menu flips the anchor too; follow it while the page is open.
  useEffect(() => {
    const onAnchor = (event: Event) => setTranscriptAnchor((event as CustomEvent<boolean>).detail === true);
    window.addEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    return () => window.removeEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
  }, []);


  return (
    <>
      <PageSection title="Transcript">
        <PageRow title="Transcript layout" description="Chat sets your prompts on the right.">
          <ChoiceSelect
            label="Transcript layout"
            value={transcriptLayout}
            options={[
              { value: "full", label: "Full width" },
              { value: "chat", label: "Chat" },
            ]}
            onChange={(next) => {
              saveTranscriptLayout(next);
              setTranscriptLayout(next);
            }}
          />
        </PageRow>
        <SwitchRow
          title="Anchor prompts to top"
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
          title="Enter while a turn runs"
          description={
            <>
              Queue waits for the turn, Steer sends into it.
              <Keys keys={MOD_ENTER} />
              does the other.
            </>
          }
        >
          <ChoiceSelect
            label="Enter while a turn runs"
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
        <SwitchRow
          title="Composer mascot"
          description="The project mascot runs along the composer during a turn."
          on={composerRunner}
          onChange={setComposerRunner}
        />
      </PageSection>

      <PageSection title="Rail">
        <SwitchRow title="Notes" description="A markdown notebook on the project rail." on={notesEnabled} onChange={setNotesEnabled} />
        <SwitchRow
          title="Working agents"
          description="A rail card lists chats in flight across projects."
          on={liveAgentsEnabled}
          onChange={setLiveAgentsEnabled}
        />
      </PageSection>

      <PlanSettingsEditor />

      <LinearSettings />

      <PageSection title="Extras">
        <SwitchRow
          title="Sounds"
          description="Short cues for finished turns, inbox items and updates."
          on={soundsEnabled}
          onChange={setSoundsEnabled}
        />
        <SwitchRow
          title="Empty session games"
          description="Pac-man and snake idle on the empty-session grid."
          on={gridArcadeEnabled}
          onChange={setGridArcadeEnabled}
        />
        <SwitchRow
          title="Claude Code hooks"
          description="Run the hooks from your settings.json files on the next turn."
          on={claudeHooks}
          onChange={setClaudeHooks}
        />
        <EditorRow />
      </PageSection>

      <PageSection title="About">
        <UpdateRow onOpenWhatsNew={onOpenWhatsNew} />
      </PageSection>
    </>
  );
}

function LinearSettings() {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
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
    void linearConnected(registry.primary().environmentId).then((status) => {
      if (cancelled) return;
      setConnected(status.connected);
      if (status.connected) void loadTeams();
    });
    return () => {
      cancelled = true;
    };
  }, [loadTeams]);

  const onSave = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveLinearToken(registry.primary().environmentId, token);
      setToken("");
      setConnected(true);
      clearInboxCache();
      notifyLinearChange();
      await loadTeams();
    } catch (err: unknown) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
        <PageRow
          media={<InboxProviderMark provider="linear" className="size-4" />}
          title="API key"
          description="Create a personal key in Linear, under Settings, Security and access."
          error={error}
        >
          {connected ? (
            <Button variant="secondary" size="sm" onClick={() => void onDisconnect()} disabled={busy}>
              {busy ? <Spinner className="size-3.5" /> : null}
              Disconnect
            </Button>
          ) : (
            <>
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSave();
                }}
                placeholder="lin_api_…"
                aria-label="Linear API key"
                autoComplete="off"
                spellCheck={false}
                className="h-7 w-52"
              />
              <Button variant="secondary" size="sm" onClick={() => void onSave()} disabled={busy || !token.trim()}>
                {busy ? <Spinner className="size-3.5" /> : null}
                Connect
              </Button>
            </>
          )}
        </PageRow>
      </PageSection>
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

function UpdateRow({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string, markdown?: string) => void;
}) {
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

  // With an update waiting, What's new shows the feed's notes for it;
  // otherwise the notes this build shipped with.
  const onWhatsNew = () =>
    hasUpdate && snapshot.availableVersion && snapshot.notes
      ? onOpenWhatsNew(snapshot.availableVersion, snapshot.notes)
      : onOpenWhatsNew(BUNDLED_RELEASE.version, BUNDLED_RELEASE.notes);

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
      error={failed ? status : undefined}
    >
      {failed && canApply ? (
        <Button variant="secondary" size="sm" onClick={() => void openUrl(MANUAL_DOWNLOAD_URL)}>
          Download the installer
        </Button>
      ) : (
        <span className="contents" {...releaseNotesChunk.intent}>
          <Button variant="secondary" size="sm" onClick={onWhatsNew}>
            What's new
          </Button>
        </span>
      )}
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
