import { ArrowDownCircle, Check, RefreshCw } from "../../chrome/icons";
import { useCallback, useEffect, useState } from "react";
import { InboxProviderMark } from "../../chrome/InboxProviderMark";
import {
  loadSidebarLayout,
  loadTranscriptLayout,
  loadTranscriptZen,
  loadTranscriptAnchor,
  saveSidebarLayout,
  saveTranscriptLayout,
  saveTranscriptZen,
  saveTranscriptAnchor,
  TRANSCRIPT_ZEN_CHANGE_EVENT,
  TRANSCRIPT_ANCHOR_CHANGE_EVENT,
  type SidebarLayout,
  type TranscriptLayout,
} from "../../lib/appearance";
import { ALT, MOD } from "../../lib/platform";
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
import {
  Heading,
  Input,
  Row,
  Segmented,
  SecondaryButton,
  Toggle,
} from "../settingsBits";
import { EditorRow } from "../EditorRow";
import { MatrixSpinner } from "../threads/bits";
import { PlanSettingsEditor } from "../../chrome/PlanSettingsFields";
import { updateStore, useUpdateSnapshot } from "../../lib/updateStore";
import { MANUAL_DOWNLOAD_URL, canRetry } from "../../lib/updater";
import { openUrl } from "../../lib/native";
import { releaseNotesChunk } from "../chunks";

export function GeneralPage({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string) => void;
}) {
  const [layout, setLayout] = useState<SidebarLayout>(loadSidebarLayout);
  const [transcriptLayout, setTranscriptLayout] =
    useState<TranscriptLayout>(loadTranscriptLayout);
  const [transcriptZen, setTranscriptZen] = useState(loadTranscriptZen);
  const [transcriptAnchor, setTranscriptAnchor] =
    useState(loadTranscriptAnchor);
  const [composerRunner, setComposerRunner] = useState(loadComposerRunner);
  const [gridArcadeEnabled, setGridArcadeEnabled] = useState(
    loadGridArcadeEnabled,
  );
  const [notesEnabled, setNotesEnabled] = useState(loadNotesEnabled);
  const [liveAgentsEnabled, setLiveAgentsEnabled] = useState(
    loadLiveAgentsEnabled,
  );
  const [soundsEnabled, setSoundsEnabled] = useState(loadSoundsEnabled);
  const [claudeHooks, setClaudeHooks] = useState(loadClaudeHooks);

  useEffect(() => {
    const onZen = (event: Event) => {
      setTranscriptZen((event as CustomEvent<boolean>).detail === true);
    };
    const onAnchor = (event: Event) => {
      setTranscriptAnchor((event as CustomEvent<boolean>).detail === true);
    };
    window.addEventListener(TRANSCRIPT_ZEN_CHANGE_EVENT, onZen);
    window.addEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    return () => {
      window.removeEventListener(TRANSCRIPT_ZEN_CHANGE_EVENT, onZen);
      window.removeEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    };
  }, []);

  const onLayout = (next: SidebarLayout) => {
    saveSidebarLayout(next);
    setLayout(next);
  };

  const onTranscriptZen = (next: boolean) => {
    saveTranscriptZen(next);
    setTranscriptZen(next);
  };

  const onTranscriptLayout = (next: TranscriptLayout) => {
    saveTranscriptLayout(next);
    setTranscriptLayout(next);
  };

  const onTranscriptAnchor = (next: boolean) => {
    saveTranscriptAnchor(next);
    setTranscriptAnchor(next);
  };

  const onComposerRunner = (next: boolean) => {
    saveComposerRunner(next);
    setComposerRunner(next);
  };

  const onGridArcadeEnabled = (next: boolean) => {
    saveGridArcadeEnabled(next);
    setGridArcadeEnabled(next);
  };

  const onNotesEnabled = (next: boolean) => {
    saveNotesEnabled(next);
    setNotesEnabled(next);
  };

  const onLiveAgentsEnabled = (next: boolean) => {
    saveLiveAgentsEnabled(next);
    setLiveAgentsEnabled(next);
  };

  const onSoundsEnabled = (next: boolean) => {
    saveSoundsEnabled(next);
    setSoundsEnabled(next);
  };

  const onClaudeHooks = (next: boolean) => {
    saveClaudeHooks(next);
    setClaudeHooks(next);
  };

  return (
    <>
      <Row
        label="Workspace layout"
        description="Deck adds the project rail, workspace panel and terminal dock."
      >
        <Segmented
          label="Workspace layout"
          value={layout}
          options={[
            { value: "deck", label: "Deck" },
            { value: "classic", label: "Classic" },
          ]}
          onChange={onLayout}
        />
      </Row>
      <Row
        label="Transcript layout"
        description="Chat aligns your prompts to the right."
      >
        <Segmented
          label="Transcript layout"
          value={transcriptLayout}
          options={[
            { value: "full", label: "Full width" },
            { value: "chat", label: "Chat" },
          ]}
          onChange={onTranscriptLayout}
        />
      </Row>
      <Row
        label="Anchor prompts to top"
        description="A sent prompt sits at the top and the reply grows below it."
      >
        <Toggle
          label="Anchor prompts to top"
          on={transcriptAnchor}
          onChange={onTranscriptAnchor}
        />
      </Row>
      <Row
        label="Zen mode"
        description={`Folds each run of tool calls under its heading (${MOD}${ALT}Z).`}
      >
        <Toggle
          label="Zen mode"
          on={transcriptZen}
          onChange={onTranscriptZen}
        />
      </Row>
      <Row
        label="Composer mascot"
        description="The project mascot runs along the composer during a turn."
      >
        <Toggle
          label="Composer mascot"
          on={composerRunner}
          onChange={onComposerRunner}
        />
      </Row>
      <Row
        label="Enter while a turn runs"
        description={`Queue waits for the turn, Steer sends into it (${MOD}Enter does the other).`}
      >
        <MidTurnSwitch />
      </Row>
      <Row
        label="Empty session games"
        description="Pac-man and snake idle on the empty-session grid."
      >
        <Toggle
          label="Empty session games"
          on={gridArcadeEnabled}
          onChange={onGridArcadeEnabled}
        />
      </Row>
      <Row
        label="Notes"
        description="A markdown notebook on the project rail."
      >
        <Toggle label="Notes" on={notesEnabled} onChange={onNotesEnabled} />
      </Row>
      <Row
        label="Working agents"
        description="A rail card lists chats in flight across projects."
      >
        <Toggle
          label="Working agents"
          on={liveAgentsEnabled}
          onChange={onLiveAgentsEnabled}
        />
      </Row>
      <Row
        label="Sounds"
        description="Short cues for finished turns, inbox items and updates."
      >
        <Toggle label="Sounds" on={soundsEnabled} onChange={onSoundsEnabled} />
      </Row>
      <Row
        label="Claude Code hooks"
        description="Run the hooks from your settings.json files on the next turn."
      >
        <Toggle
          label="Claude Code hooks"
          on={claudeHooks}
          onChange={onClaudeHooks}
        />
      </Row>
      <EditorRow />

      <PlanSettingsEditor />

      <Heading title="Linear" />
      <LinearSettings />

      <Heading title="About" />
      <UpdateRow onOpenWhatsNew={onOpenWhatsNew} />
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
      <Row
        label={
          <span className="flex items-center gap-2">
            <InboxProviderMark provider="linear" className="size-4 shrink-0" />
            API key
          </span>
        }
        description="Create a personal API key in Linear → Settings → Security & Access."
      >
        {connected ? (
          <SecondaryButton onClick={() => void onDisconnect()} disabled={busy}>
            Disconnect
          </SecondaryButton>
        ) : (
          <div className="flex items-center gap-2">
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
              className="w-52 shrink-0"
            />
            <SecondaryButton
              onClick={() => void onSave()}
              disabled={busy || !token.trim()}
            >
              {busy ? <MatrixSpinner cell={1.5} /> : null}
              Connect
            </SecondaryButton>
          </div>
        )}
      </Row>
      {error ? (
        <p className="pb-2 text-[12px] text-danger">{error}</p>
      ) : null}
      {connected && teams.length > 0 ? (
        <div className="border-b border-content/5 py-4">
          <div className="text-[13px] font-medium text-content">
            Linear Teams
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-content/40">
            Unchecked teams stay out of the inbox.
          </p>
          <div className="mt-3 flex flex-col gap-0.5">
            {teams.map((team) => {
              const checked = !hiddenTeamIds.includes(team.id);
              return (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => toggleTeam(team.id)}
                  className="flex h-7 items-center gap-3 rounded-lg px-2 text-left text-[13px] text-content hover:bg-content/5 active:bg-content/10"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {team.name}
                    {team.key ? (
                      <span className="ml-1.5 text-content/40">{team.key}</span>
                    ) : null}
                  </span>
                  {checked ? (
                    <Check className="size-3.5 shrink-0" strokeWidth={2.25} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
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

  return (
    <Row
      label={
        <span className="flex items-baseline gap-2">
          Release
          <span className="font-mono text-[12px] text-content/40 tabular-nums">
            {snapshot.currentVersion}
          </span>
        </span>
      }
      description={
        <>
          <span className="block">{status}</span>
          {downloading ? <DownloadProgress percent={snapshot.percent ?? 0} /> : null}
        </>
      }
    >
      <div className="flex items-center gap-2">
        {snapshot.phase === "error" && canApply ? (
          <SecondaryButton onClick={() => void openUrl(MANUAL_DOWNLOAD_URL)}>
            Download the installer
          </SecondaryButton>
        ) : (
          <span className="contents" {...releaseNotesChunk.intent}>
            <SecondaryButton onClick={onWhatsNew}>What's new</SecondaryButton>
          </span>
        )}
        <SecondaryButton
          onClick={() =>
            void (actionable ? updateStore.install() : updateStore.check(true))
          }
          disabled={busy}
        >
          {busy ? (
            <MatrixSpinner cell={1.5} />
          ) : actionable ? (
            <ArrowDownCircle className="size-3.5 text-accent" strokeWidth={1.75} aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} aria-hidden />
          )}
          {ready ? "Restart" : retry ? "Retry" : hasUpdate && canApply ? "Update" : "Check for updates"}
        </SecondaryButton>
      </div>
    </Row>
  );
}

/** The download, as main reports it. */
function DownloadProgress({ percent }: { percent: number }) {
  const fraction = Math.min(1, Math.max(0, percent / 100));
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className="mt-2 block h-1 w-64 overflow-hidden rounded-full bg-content/10"
    >
      <span
        className="block h-full origin-left rounded-full bg-accent transition-transform duration-200"
        style={{ transform: `scaleX(${fraction})` }}
      />
    </span>
  );
}

function MidTurnSwitch() {
  const [value, setValue] = useState<MidTurnDefault>(loadMidTurnDefault);
  return (
    <Segmented
      label="Enter while a turn runs"
      value={value}
      options={[
        { value: "queue", label: "Queue" },
        { value: "steer", label: "Steer" },
      ]}
      onChange={(next) => {
        saveMidTurnDefault(next);
        setValue(next);
      }}
    />
  );
}
