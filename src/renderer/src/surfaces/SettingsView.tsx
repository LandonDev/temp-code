import {
  ArrowDownCircle,
  Check,
  Loader,
  RefreshCw,
  RotateCcw,
  Search,
} from "../chrome/icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { HarnessIcon } from "../chrome/HarnessIcon";
import { InboxProviderMark } from "../chrome/InboxProviderMark";
import { RemoveProjectDialog } from "../chrome/RemoveProjectDialog";
import { WindowControls } from "../chrome/WindowControls";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import {
  applyBodyGlass,
  applyThemePreference,
  applySidebarOpacity,
  applyThemeTint,
  BODY_GLASS_DEFAULT,
  THEME_PREFERENCE_DEFAULT,
  loadBodyGlass,
  loadThemePreference,
  loadSidebarLayout,
  loadSidebarOpacity,
  loadThemeHue,
  loadThemeSaturation,
  loadTranscriptLayout,
  loadTranscriptZen,
  loadTranscriptAnchor,
  saveBodyGlass,
  saveThemePreference,
  saveSidebarLayout,
  saveSidebarOpacity,
  saveThemeHue,
  saveThemeSaturation,
  saveTranscriptLayout,
  saveTranscriptZen,
  saveTranscriptAnchor,
  TRANSCRIPT_ZEN_CHANGE_EVENT,
  TRANSCRIPT_ANCHOR_CHANGE_EVENT,
  SIDEBAR_OPACITY_DEFAULT,
  SIDEBAR_OPACITY_MAX,
  SIDEBAR_OPACITY_MIN,
  THEME_HUE_DEFAULT,
  THEME_HUE_MAX,
  THEME_HUE_MIN,
  THEME_SATURATION_DEFAULT,
  THEME_SATURATION_MAX,
  THEME_SATURATION_MIN,
  type ThemePreference,
  type SidebarLayout,
  type TranscriptLayout,
} from "../lib/appearance";
import {
  getHarnessAvailabilitySnapshot,
  harnessUnavailableHint,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
} from "../lib/harness/availability";
import { refreshHarnessCatalogs } from "../lib/harness/registry";
import {
  defaultModelId,
  getModelSnapshot,
  isPickerProviderVisible,
  loadDefaultModels,
  loadLastModelChoice,
  modelsFor,
  resolveModel,
  saveDefaultModel,
  saveLastModelChoice,
  savePickerProviderVisible,
  subscribeModels,
} from "../lib/models";
import { prettyCwd, projectName } from "../lib/paths";
import { ALT, IS_MAC, MOD } from "../lib/platform";
import {
  loadArchivedProjects,
  looksLikeProject,
  subscribeArchivedProjects,
  type ArchivedProject,
} from "../lib/recents";
import {
  HARNESSES,
  HARNESS_TITLE,
  sessionDisplayTitle,
  type HarnessId,
} from "../lib/session";
import {
  loadSessionSidebarFilters,
  saveSessionSidebarFilters,
} from "../lib/sessionFilters";
import { clearInboxCache } from "../lib/githubTasks";
import {
  disconnectLinear,
  linearConnected,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  notifyLinearChange,
  saveHiddenLinearTeamIds,
  saveLinearToken,
  type LinearTeam,
} from "../lib/linear";
import { loadTabGroupLabels, resolveTabGroupLabel } from "../lib/tabGroups";
import { probeDoctor, type Doctor, type DoctorRow } from "../lib/tcserver/catalog";
import { useSessionMetas } from "../lib/tcserver/store";
import { useProjects } from "../lib/tcserver/workspaces";
import { BUNDLED_RELEASE } from "../lib/releaseNotes";
import type { SessionMeta } from "@shared/events";
import type { LspStatusRow } from "@shared/domain";
import {
  filterKeybindings,
  KEYBINDINGS,
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
  settingsSectionDescription,
  settingsSectionLabel,
  type MidTurnDefault,
} from "../lib/settings";
import { SPRING_LAYOUT } from "../lib/ease";
import { loadSoundsEnabled, saveSoundsEnabled } from "../lib/sounds";
import {
  loadAutoSave,
  loadFormatOnSave,
  loadGhostText,
  saveAutoSave,
  saveFormatOnSave,
  saveGhostText,
  type FormatOnSave,
} from "../lib/settings";
import { client } from "../lib/tcserver/client";
import { retryBlockedEnsures } from "../lib/monaco/lspGate";
import { Modal } from "../chrome/Modal";
import { OrchestrationRulesEditor } from "../chrome/OrchestrationRules";
import { BuildEditor, takeRequestedBuildScope } from "../chrome/rail/buildSettings";
import { ThreadDefaultsEditor } from "../chrome/ThreadDefaultsDialog";
import { TurnPassEditor } from "../chrome/TurnPassFields";
import { openOrchestrationSettings, takeRequestedScope } from "../lib/tcserver/rules";
import { useWorkspaces, workspaceLabelKey } from "../lib/tcserver/workspaces";
import { workspaceOfSection } from "../lib/settings";
import { Heading, Row, Segmented, Select, SecondaryButton, Toggle } from "./settingsBits";
import { DANGER, GHOST, PRIMARY } from "../chrome/ConfirmDialog";
import { AppshotsPage } from "./AppshotsSettings";
import { MatrixSpinner } from "./threads/bits";
import { installing, updateStore, useUpdateSnapshot } from "../lib/updateStore";
import { shell, useShell } from "../stores/shell";

type Props = {
  cwd: string;
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => void;
  onOpenWhatsNew: (version: string, markdown?: string) => void;
};

export function SettingsView({
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
  onOpenWhatsNew,
}: Props) {
  // `cwd` stays in Props for the caller; the archive page lists every
  // project's threads from the server instead.
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const section = useShell((s) => s.settingsSection);
  const appearance = useAppearanceSettings();
  const workspaceId = workspaceOfSection(section);
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const title = workspace?.name ?? settingsSectionLabel(section);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A dialog on top of the page owns its own Escape.
      if ((event.target as Element | null)?.closest?.('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      shell.closeSettings();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      role="region"
      aria-label="Settings"
      data-app-settings
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-content/10"
        data-tauri-drag-region="deep"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <span className="shrink-0 text-content/40">Settings</span>
          <span aria-hidden className="shrink-0 text-content/20">
            /
          </span>
          <span className="min-w-0 truncate text-content">{title}</span>
        </div>
        {section === "appearance" ? (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={appearance.restoreDefaults}
            className="mr-2 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
            Restore defaults
          </button>
        ) : null}
        {IS_MAC ? null : <WindowControls />}
      </div>

      <div
        ref={lockOverscroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        <div className="mx-auto w-full max-w-5xl px-8 py-8">
          <PageHeader
            title={title}
            description={
              workspaceId
                ? workspace
                  ? prettyCwd(workspace.path)
                  : "This workspace was removed."
                : settingsSectionDescription(section)
            }
          />
          {section === "general" ? (
            <GeneralPage onOpenWhatsNew={onOpenWhatsNew} />
          ) : null}
          {section === "defaults" ? <ThreadDefaultsEditor workspaceId={null} first /> : null}
          {workspace ? <WorkspacePage key={workspace.id} workspaceId={workspace.id} /> : null}
          {section === "appearance" ? (
            <AppearancePage appearance={appearance} />
          ) : null}
          {section === "editor" ? <EditorPage /> : null}
          {section === "keybindings" ? <KeybindingsPage /> : null}
          {section === "providers" ? <ProvidersPage /> : null}
          {section === "orchestration" ? <OrchestrationPage /> : null}
          {section === "build" ? <BuildPage /> : null}
          {section === "appshots" ? <AppshotsPage /> : null}
          {section === "archive" ? (
            <ArchivePage
              onOpenSession={onOpenSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
              onRestoreProject={onRestoreProject}
              onDeleteProject={onDeleteProject}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GeneralPage({
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
        description="Classic keeps a single sidebar. Deck adds the project rail, the workspace panel, and the project terminal dock."
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
        description="Full width keeps user prompts as a spanning card. Chat aligns them to the right with a max width, like a messaging app."
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
        description="When you send, the new prompt sits at the top of the transcript and the reply grows into the space below. Turn this off to keep the classic layout, with the latest message resting on the composer."
      >
        <Toggle
          label="Anchor prompts to top"
          on={transcriptAnchor}
          onChange={onTranscriptAnchor}
        />
      </Row>
      <Row
        label="Zen mode"
        description={`The agent's work reads as groups: a run of related tool calls under the line the agent wrote to introduce it. The group it is in stays open and grows a step at a time — tool calls, thinking, the notes it drops between them — and folds back to its header the moment it moves on, leaving a labelled outline above the final answer. Click any group to read it back. Edits waiting on approval still show their diff. ${MOD}${ALT}Z toggles it.`}
      >
        <Toggle
          label="Zen mode"
          on={transcriptZen}
          onChange={onTranscriptZen}
        />
      </Row>
      <Row
        label="Composer mascot"
        description="When a turn is running, the project mascot runs along the composer, bonks the scroll-to-latest button the first time, then jumps it, and sometimes grabs a coin."
      >
        <Toggle
          label="Composer mascot"
          on={composerRunner}
          onChange={onComposerRunner}
        />
      </Row>
      <Row
        label="Enter while a turn runs"
        description={`Queue waits for the turn to settle; Steer sends into the running turn. ${MOD}Enter does the other one.`}
      >
        <MidTurnSwitch />
      </Row>
      <Row
        label="Empty session games"
        description="Pac-man and snake idle on the empty-session grid. Hover the band to take control of whichever is on screen. Turn this off to keep the pane still."
      >
        <Toggle
          label="Empty session games"
          on={gridArcadeEnabled}
          onChange={onGridArcadeEnabled}
        />
      </Row>
      <Row
        label="Notes"
        description="A global markdown notebook on the project rail. Save a finished turn from the transcript, then mention it later with @note or add it to chat. Turn this off to hide Notes from the UI."
      >
        <Toggle label="Notes" on={notesEnabled} onChange={onNotesEnabled} />
      </Row>
      <Row
        label="Working agents"
        description="When two or more chats are in flight, a card on the project rail lists them so you can jump across projects. Finished turns stay until you open that session. Turn this off to hide the card."
      >
        <Toggle
          label="Working agents"
          on={liveAgentsEnabled}
          onChange={onLiveAgentsEnabled}
        />
      </Row>
      <Row
        label="Sounds"
        description="Short cues when a turn finishes, a new inbox item appears on the project rail, or an update is available. Switches and Copy on a finished turn also play."
      >
        <Toggle label="Sounds" on={soundsEnabled} onChange={onSoundsEnabled} />
      </Row>
      <Row
        label="Claude Code hooks"
        description="Run the hooks configured in your settings.json files — PreToolUse command rewrites, blocks, notifications, and the rest — just as the Claude Code CLI would. Turn this off if a hook is misbehaving and you need the session back. Takes effect on the next turn."
      >
        <Toggle
          label="Claude Code hooks"
          on={claudeHooks}
          onChange={onClaudeHooks}
        />
      </Row>

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
      const next = await listLinearTeams();
      setTeams(next);
    } catch {
      setTeams([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void linearConnected().then((status) => {
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
      await saveLinearToken(token);
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
      await disconnectLinear();
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
        description="Create a personal API key in Linear → Settings → Security & Access. Disconnect deletes it."
      >
        {connected ? (
          <SecondaryButton onClick={() => void onDisconnect()} disabled={busy}>
            Disconnect
          </SecondaryButton>
        ) : (
          <div className="flex items-center gap-2">
            <label className="flex h-7 w-52 shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
              <input
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
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
              />
            </label>
            <SecondaryButton
              onClick={() => void onSave()}
              disabled={busy || !token.trim()}
            >
              {busy ? "Saving" : "Connect"}
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
          <div className="mt-3 flex flex-col gap-0.5 -mx-2">
            {teams.map((team) => {
              const checked = !hiddenTeamIds.includes(team.id);
              return (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => toggleTeam(team.id)}
                  className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-content hover:bg-content/5"
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
  const building = snapshot.phase === "building";
  const busy = snapshot.phase === "checking" || installing(snapshot);
  const hasUpdate = snapshot.phase === "available";
  const canApply = snapshot.canApply === true;

  const status = building
    ? (snapshot.detail ?? "Starting the build…")
    : snapshot.phase === "restarting"
      ? "Restarting…"
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

  return (
    <Row
      label={
        <span className="flex items-baseline gap-2">
          Release
          <span className="font-mono text-[12px] text-content/40">
            {snapshot.currentVersion}
          </span>
        </span>
      }
      description={
        <>
          <span className="block">{status}</span>
          {building ? (
            <StepProgress
              startedAt={snapshot.stepStartedAt}
              etaMs={snapshot.stepEtaMs}
            />
          ) : null}
        </>
      }
    >
      <div className="flex items-center gap-2">
        <SecondaryButton onClick={onWhatsNew}>What's new</SecondaryButton>
        <SecondaryButton
          onClick={() =>
            void (hasUpdate && canApply
              ? updateStore.install()
              : updateStore.check(true))
          }
          disabled={busy}
        >
          {busy ? (
            <Loader className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : hasUpdate && canApply ? (
            <ArrowDownCircle className="size-3.5 text-accent" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} aria-hidden />
          )}
          {building && snapshot.step
            ? `${snapshot.step}…`
            : hasUpdate && canApply
              ? `Update to ${snapshot.availableVersion}`
              : "Check for updates"}
        </SecondaryButton>
      </div>
    </Row>
  );
}

/** A real progress bar while main builds: the ETA is how long this step
 *  took last time. Without one the bar just pulses. */
function StepProgress({
  startedAt,
  etaMs,
}: {
  startedAt?: number;
  etaMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const known = startedAt != null && etaMs != null && etaMs > 0;
  const fraction = known
    ? Math.min(0.96, Math.max(0.02, (now - startedAt) / etaMs))
    : null;
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction == null ? undefined : Math.round(fraction * 100)}
      className="mt-2 block h-1 w-64 overflow-hidden rounded-full bg-content/10"
    >
      <span
        className={`block h-full rounded-full bg-accent transition-[width] duration-300 ${
          fraction == null ? "w-1/3 motion-safe:animate-pulse" : ""
        }`}
        style={fraction == null ? undefined : { width: `${fraction * 100}%` }}
      />
    </span>
  );
}

type AppearanceSettings = ReturnType<typeof useAppearanceSettings>;

function useAppearanceSettings() {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(loadThemePreference);
  const [opacity, setOpacity] = useState(loadSidebarOpacity);
  const [themeHue, setThemeHue] = useState(loadThemeHue);
  const [themeSaturation, setThemeSaturation] = useState(loadThemeSaturation);
  const [bodyGlass, setBodyGlass] = useState(loadBodyGlass);

  const onThemePreference = useCallback((next: ThemePreference) => {
    applyThemePreference(next);
    saveThemePreference(next);
    setThemePreference(next);
  }, []);

  const onOpacity = useCallback((percent: number) => {
    const next = applySidebarOpacity(percent / 100);
    saveSidebarOpacity(next);
    setOpacity(next);
  }, []);

  const onTint = useCallback((hue: number, saturation: number) => {
    const next = applyThemeTint(hue, saturation);
    saveThemeHue(next.hue);
    saveThemeSaturation(next.saturation);
    setThemeHue(next.hue);
    setThemeSaturation(next.saturation);
  }, []);

  const onBodyGlass = useCallback((next: boolean) => {
    applyBodyGlass(next);
    saveBodyGlass(next);
    setBodyGlass(next);
  }, []);

  const restoreDefaults = useCallback(() => {
    onThemePreference(THEME_PREFERENCE_DEFAULT);
    onOpacity(Math.round(SIDEBAR_OPACITY_DEFAULT * 100));
    onTint(THEME_HUE_DEFAULT, THEME_SATURATION_DEFAULT);
    onBodyGlass(BODY_GLASS_DEFAULT);
  }, [onBodyGlass, onThemePreference, onOpacity, onTint]);

  return {
    themePreference,
    opacity,
    themeHue,
    themeSaturation,
    bodyGlass,
    onThemePreference,
    onOpacity,
    onTint,
    onBodyGlass,
    restoreDefaults,
  };
}

function AppearancePage({ appearance }: { appearance: AppearanceSettings }) {
  const percent = Math.round(appearance.opacity * 100);

  return (
    <>
      <Row
        label="Theme"
        description="System follows the OS appearance. Dark and light share the same tint, so the hue below applies to both."
      >
        <Segmented
          label="Theme"
          value={appearance.themePreference}
          options={[
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onChange={appearance.onThemePreference}
        />
      </Row>
      <Row
        label="Sidebar opacity"
        description="How much of the desktop shows through the sidebar and the project rail."
      >
        <Slider
          label="Sidebar opacity"
          value={percent}
          display={`${percent}%`}
          min={Math.round(SIDEBAR_OPACITY_MIN * 100)}
          max={Math.round(SIDEBAR_OPACITY_MAX * 100)}
          onChange={appearance.onOpacity}
        />
      </Row>
      <Row label="Hue" description="Base hue for accents and tinted surfaces.">
        <Slider
          label="Hue"
          value={appearance.themeHue}
          display={`${appearance.themeHue}°`}
          min={THEME_HUE_MIN}
          max={THEME_HUE_MAX}
          onChange={(value) =>
            appearance.onTint(value, appearance.themeSaturation)
          }
        />
      </Row>
      <Row
        label="Saturation"
        description="How strongly the hue tints the interface. Zero keeps it neutral."
      >
        <Slider
          label="Saturation"
          value={appearance.themeSaturation}
          display={`${appearance.themeSaturation}%`}
          min={THEME_SATURATION_MIN}
          max={THEME_SATURATION_MAX}
          onChange={(value) => appearance.onTint(appearance.themeHue, value)}
        />
      </Row>
      <Row
        label="Main pane glass"
        description="Extend the translucent treatment to the main pane behind sessions and editors."
      >
        <Toggle
          label="Main pane glass"
          on={appearance.bodyGlass}
          onChange={appearance.onBodyGlass}
        />
      </Row>
    </>
  );
}

function KeybindingsPage() {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => filterKeybindings(KEYBINDINGS, query), [query]);

  return (
    <>
      <div className="flex items-center justify-end gap-3 pb-3">
        <span className="shrink-0 text-[12px] text-content/40 tabular-nums">
          {rows.length} {rows.length === 1 ? "binding" : "bindings"}
        </span>
        <label className="flex h-7 w-52 shrink-0 items-center gap-2 rounded-md border border-content/10 px-2 text-content/40 focus-within:border-content/20">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            aria-label="Filter keybindings"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-lg border border-content/10">
        <div className="flex items-center border-b border-content/10 bg-content/5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
          <span className="min-w-0 flex-1">Command</span>
          <span className="w-40 shrink-0">Keybinding</span>
          <span className="w-28 shrink-0">When</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-content/40">
            No matching bindings
          </p>
        ) : (
          rows.map((row) => (
            <div
              key={`${row.command}-${row.keys}`}
              className="flex items-center border-b border-content/5 px-3 py-2 text-[12px] last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate">{row.command}</span>
              <span className="w-40 shrink-0 font-mono text-[12px] text-content/70">
                {row.keys}
              </span>
              <span className="w-28 shrink-0 font-mono text-[11px] text-content/40">
                {row.when}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="pt-3 text-[12px] text-content/40">
        Bindings come from the app menu and the workspace key handler; they
        aren’t customizable yet.
      </p>
    </>
  );
}

function ProvidersPage() {
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const [choice, setChoice] = useState(loadLastModelChoice);
  const [defaultModels, setDefaultModels] = useState(loadDefaultModels);
  const [doctor, setDoctor] = useState<Doctor | null>(null);

  const refreshDoctor = useCallback((force = false) => {
    void probeHarnessAvailability({ force });
    void probeDoctor({ force })
      .then(setDoctor)
      .catch(() => setDoctor({}));
  }, []);

  useEffect(() => {
    refreshDoctor();
  }, [refreshDoctor]);

  const onModelChange = (harness: HarnessId, model: string) => {
    saveDefaultModel(harness, model);
    setDefaultModels((prev) => ({ ...prev, [harness]: model }));
    if (choice?.harness === harness) {
      saveLastModelChoice(harness, model);
      setChoice({ harness, model });
    }
  };

  const onDefault = (harness: HarnessId, model: string) => {
    saveLastModelChoice(harness, model);
    setDefaultModels((prev) => ({ ...prev, [harness]: model }));
    setChoice({ harness, model });
  };

  return (
    <>
      <p className="pb-2 text-[12px] leading-relaxed text-content/40">
        A provider is listed as installed once its CLI is found on your PATH;
        uninstalled ones are left out of the model picker. The model beside
        each provider is what new threads use when that provider is selected.
      </p>
      {HARNESSES.map((harness) => (
        <ProviderRow
          key={harness}
          harness={harness}
          doctor={doctor ? (doctor[harness] ?? { found: false }) : undefined}
          onUpdated={(row) => {
            setDoctor((prev) => ({ ...(prev ?? {}), [harness]: row }));
            refreshDoctor(true);
          }}
          selectedModel={
            defaultModels[harness] ??
            (choice?.harness === harness
              ? choice.model
              : defaultModelId(harness))
          }
          isDefault={choice?.harness === harness}
          onDefault={onDefault}
          onModelChange={onModelChange}
        />
      ))}
    </>
  );
}

/** Providers whose CLI the server knows how to update in place. */
/** "2.1.263 (Claude Code)" → "v2.1.263 (Claude Code)"; "codex-cli 0.153.4" stays as is. */
function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

const UPDATABLE: ReadonlySet<HarnessId> = new Set(["claude", "codex", "cursor"]);

function ProviderRow({
  harness,
  doctor,
  onUpdated,
  selectedModel,
  isDefault,
  onDefault,
  onModelChange,
}: {
  harness: HarnessId;
  /** undefined while the first probe runs */
  doctor: DoctorRow | undefined;
  onUpdated: (row: DoctorRow) => void;
  selectedModel: string;
  isDefault: boolean;
  onDefault: (harness: HarnessId, model: string) => void;
  onModelChange: (harness: HarnessId, model: string) => void;
}) {
  const models = modelsFor(harness);
  const available = isHarnessAvailable(harness);
  const current =
    models.length > 0 ? resolveModel(harness, selectedModel) : null;
  const [inPicker, setInPicker] = useState(() =>
    isPickerProviderVisible(harness),
  );
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!available || models.length > 0) return;
    void refreshHarnessCatalogs([harness]);
  }, [available, harness, models.length]);

  const onPickerVisible = (visible: boolean) => {
    savePickerProviderVisible(harness, visible);
    setInPicker(visible);
  };

  const onUpdate = async () => {
    if (updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const row = await client.request<DoctorRow>("providers.update", {
        provider: harness,
      });
      onUpdated(row);
      void refreshHarnessCatalogs([harness]);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  const health =
    doctor === undefined ? (
      <span className="text-content/40">Checking…</span>
    ) : doctor.found ? (
      <>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${doctor.error ? "bg-warning" : "bg-success"}`}
          />
          {doctor.version ? versionLabel(doctor.version) : "Installed"}
          {models.length > 0 ? (
            <span className="text-content/40">
              · {models.length} {models.length === 1 ? "model" : "models"}
            </span>
          ) : null}
        </span>
        {doctor.path ? (
          <span className="block truncate font-mono text-[11px] text-content/40">
            {doctor.path}
          </span>
        ) : null}
        {doctor.error ? (
          <span className="block text-warning">{doctor.error}</span>
        ) : null}
      </>
    ) : (
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full bg-danger" />
        {harnessUnavailableHint(harness)}
      </span>
    );

  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <HarnessIcon harness={harness} className="size-4 shrink-0" />
          {HARNESS_TITLE[harness]}
          {isDefault ? (
            <span className="rounded-full bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/50">
              Default
            </span>
          ) : null}
        </span>
      }
      description={
        <>
          {health}
          {updateError ? (
            <span className="block whitespace-pre-line text-danger">
              {updateError}
            </span>
          ) : null}
        </>
      }
    >
      {doctor?.found && UPDATABLE.has(harness) ? (
        <SecondaryButton onClick={() => void onUpdate()} disabled={updating}>
          {updating ? (
            <Loader className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : null}
          {updating ? "Updating…" : "Update"}
        </SecondaryButton>
      ) : null}
      {current ? (
        <Select
          label={`${HARNESS_TITLE[harness]} model`}
          value={current.id}
          onChange={(next) => onModelChange(harness, next)}
          options={models.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
        />
      ) : null}
      <SecondaryButton
        onClick={() => current && onDefault(harness, current.id)}
        disabled={isDefault || !current}
      >
        {isDefault ? "Default" : "Use by default"}
      </SecondaryButton>
      {available ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-content/50">Show in picker</span>
          <Toggle
            label={`Show ${HARNESS_TITLE[harness]} in the model picker`}
            on={inPicker}
            onChange={onPickerVisible}
          />
        </div>
      ) : null}
    </Row>
  );
}

/** Global rules, or one workspace's whole-object override, picked by scope.
 *  The workspace menu deep-links here with its workspace preselected. */
/**
 * One workspace's overrides. Anything untouched inherits the global setting;
 * orchestration rules edit on their own page with this workspace in scope.
 */
function WorkspacePage({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      <ThreadDefaultsEditor workspaceId={workspaceId} first />
      <TurnPassEditor workspaceId={workspaceId} />
      <Heading title="Build" />
      <BuildEditor workspaceId={workspaceId} />
      <Heading title="Orchestration" />
      <Row
        label="Rules"
        description="What threads that spawn subagents may do themselves, and where each kind of work goes."
      >
        <SecondaryButton onClick={() => openOrchestrationSettings(workspaceId)}>
          Edit rules
        </SecondaryButton>
      </Row>
    </>
  );
}

function OrchestrationPage() {
  const workspaces = useWorkspaces();
  const [scope, setScope] = useState<string | null>(() => takeRequestedScope() ?? null);
  const known = scope === null || workspaces.some((w) => w.id === scope);
  return (
    <>
      {workspaces.length > 0 ? (
        <Row label="Scope" description="The global rules, or one workspace's override of them.">
          <Select
            label="Rules scope"
            value={known ? (scope ?? "") : ""}
            onChange={(next) => setScope(next || null)}
            options={[
              { value: "", label: "Global" },
              ...workspaces.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Row>
      ) : null}
      <OrchestrationRulesEditor key={scope ?? ""} workspaceId={known ? scope : null} />
    </>
  );
}

/** One workspace's build command; the Build rail tab deep-links here. */
function BuildPage() {
  const workspaces = useWorkspaces();
  const [scope, setScope] = useState<string | null>(() => takeRequestedBuildScope() ?? null);
  const selected = workspaces.find((w) => w.id === scope) ?? workspaces[0];
  if (!selected) {
    return <p className="py-4 text-[12px] text-content/40">No workspaces yet.</p>;
  }
  return (
    <>
      {workspaces.length > 1 ? (
        <Row label="Workspace">
          <Select
            label="Build workspace"
            value={selected.id}
            onChange={setScope}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        </Row>
      ) : null}
      <BuildEditor key={selected.id} workspaceId={selected.id} />
    </>
  );
}

function useArchivedProjects(): ArchivedProject[] {
  const [items, setItems] = useState(loadArchivedProjects);
  useEffect(
    () => subscribeArchivedProjects(() => setItems(loadArchivedProjects())),
    [],
  );
  return items;
}

function useArchivedProjectLabel(): (path: string) => string {
  const workspaces = useWorkspaces();
  return (path) =>
    resolveTabGroupLabel(
      workspaceLabelKey(workspaces, path, projectName(path)),
      loadTabGroupLabels(),
      projectName(path),
    );
}

function ArchivePage({
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
}: {
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (
    sessionId: string,
    options?: { confirmed?: boolean },
  ) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => void;
}) {
  const archivedProjectLabel = useArchivedProjectLabel();
  const [filters, setFilters] = useState(loadSessionSidebarFilters);
  const [deleting, setDeleting] = useState<ArchivedProject | null>(null);
  const [deletingThread, setDeletingThread] = useState<SessionMeta | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const archivedProjects = useArchivedProjects();
  const metas = useSessionMetas();
  const projects = useProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const nameOf = useCallback(
    (meta: SessionMeta) =>
      (meta.projectId ? projectNames.get(meta.projectId) : undefined) ??
      (looksLikeProject(meta.cwd) ? projectName(meta.cwd) : ""),
    [projectNames],
  );
  const archived = useMemo(
    () =>
      metas
        .filter((meta) => meta.archived && !meta.parentId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [metas],
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return archived;
    return archived.filter((meta) =>
      [meta.title, nameOf(meta), HARNESS_TITLE[meta.provider], meta.provider]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [archived, nameOf, query]);

  const onShowArchived = (showArchived: boolean) => {
    const next = { ...filters, showArchived };
    saveSessionSidebarFilters(next);
    setFilters(next);
  };

  const restore = (meta: SessionMeta) => {
    onArchiveSession(meta.id, false);
    onOpenSession(meta.id);
  };

  return (
    <>
      <Heading title="Archived projects" first />
      {archivedProjects.length === 0 ? (
        <p className="py-3 text-[12px] text-content/40">
          Archive a project from the rail to keep its chats without listing it
          in the sidebar.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-content/10">
          {archivedProjects.map((project) => (
            <div
              key={project.path}
              className="flex items-center gap-3 border-b border-content/5 px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {archivedProjectLabel(project.path)}
                </div>
                <div className="truncate text-[11px] text-content/40">
                  {prettyCwd(project.path)}
                </div>
              </div>
              {onRestoreProject ? (
                <SecondaryButton onClick={() => onRestoreProject(project.path)}>
                  Restore
                </SecondaryButton>
              ) : null}
              {onDeleteProject ? (
                <SecondaryButton danger onClick={() => setDeleting(project)}>
                  Delete
                </SecondaryButton>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Row
        label="Show archived in the sidebar"
        description="Keep archived conversations listed alongside the active ones."
      >
        <Toggle
          label="Show archived in the sidebar"
          on={filters.showArchived}
          onChange={onShowArchived}
        />
      </Row>

      <Heading title="Archived threads" />

      {archived.length === 0 ? (
        <p className="py-3 text-[12px] text-content/40">
          Nothing archived. Right-click a tab to archive it.
        </p>
      ) : (
        <>
          <label className="mb-3 flex items-center gap-2 rounded-md border border-content/10 px-2.5 py-1.5 text-[12px] text-content/50 focus-within:border-content/20">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${archived.length} archived…`}
              aria-label="Search archived threads"
              className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40"
            />
          </label>
          {shown.length === 0 ? (
            <p className="py-3 text-[12px] text-content/40">
              No archived thread matches.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-content/10">
              {shown.map((meta) => (
                <div
                  key={meta.id}
                  className="flex items-center gap-3 border-b border-content/5 px-3 py-2 last:border-b-0"
                >
                  <HarnessIcon
                    harness={meta.provider}
                    className="size-3.5 shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => restore(meta)}
                    className="min-w-0 flex-1 text-left hover:text-content"
                  >
                    <span className="block truncate text-[13px]">
                      {sessionDisplayTitle(meta.title, meta.provider)}
                    </span>
                    {nameOf(meta) ? (
                      <span className="block truncate text-[11px] text-content/40">
                        {nameOf(meta)}
                      </span>
                    ) : null}
                  </button>
                  <span className="shrink-0 text-[11px] text-content/40 tabular-nums">
                    {formatDate(meta.updatedAt)}
                  </span>
                  <SecondaryButton onClick={() => restore(meta)}>
                    Restore
                  </SecondaryButton>
                  <SecondaryButton
                    danger
                    onClick={() => setDeletingThread(meta)}
                  >
                    Delete
                  </SecondaryButton>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {deleting ? (
        <RemoveProjectDialog
          name={archivedProjectLabel(deleting.path)}
          path={deleting.path}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDeleteProject?.(deleting.path);
            setDeleting(null);
          }}
        />
      ) : null}
      {deletingThread ? (
        <Modal
          onClose={() => setDeletingThread(null)}
          title={`Delete ${clampTitle(
            sessionDisplayTitle(deletingThread.title, deletingThread.provider),
          )}?`}
          description="The thread and its whole transcript are gone for good."
          size="sm"
        >
          <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
            <button type="button" onClick={() => setDeletingThread(null)} className={GHOST}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onDeleteSession(deletingThread.id, { confirmed: true });
                setDeletingThread(null);
              }}
              className={DANGER}
            >
              Delete thread
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="pb-4">
      <h1 className="text-[20px] font-semibold leading-tight text-content">
        {title}
      </h1>
      {description ? (
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-content/40">
          {description}
        </p>
      ) : null}
    </header>
  );
}

function MidTurnSwitch() {
  const [value, setValue] = useState<MidTurnDefault>(loadMidTurnDefault);
  const reduce = useReducedMotion();
  const pick = (next: MidTurnDefault) => {
    saveMidTurnDefault(next);
    setValue(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Enter while a turn runs"
      className="flex gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
    >
      {(["queue", "steer"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => pick(option)}
          className={`relative rounded-[5px] px-3 py-1 transition-colors ${
            value === option ? "text-content" : "text-content/50 hover:text-content"
          }`}
        >
          {value === option ? (
            <motion.span
              layoutId="mid-turn-pill"
              transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              className="absolute inset-0 rounded-[5px] bg-content/10"
            />
          ) : null}
          <span className="relative">{option === "queue" ? "Queue" : "Steer"}</span>
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex w-56 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        className="sidebar-opacity-slider min-w-0 flex-1"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 shrink-0 text-right text-[12px] text-content tabular-nums">
        {display}
      </span>
    </div>
  );
}

type IdeaEngine = { dist: boolean; accepted: boolean; build: string };
type JavaDoctor = {
  found: boolean;
  path?: string;
  version?: string;
  jdtls: boolean;
  ideaServer?: IdeaEngine;
  error?: string;
};

const LSP_LABEL: Record<LspStatusRow["lang"], string> = {
  java: "jdtls",
  idea: "IntelliJ engine",
  web: "vtsls",
};

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function lspRowStatus(row: LspStatusRow): string {
  if (row.state === "running") {
    const parts = [row.memoryBytes != null ? fmtBytes(row.memoryBytes) : "running"];
    if (row.idleMs > 60_000) parts.push(`idle ${Math.round(row.idleMs / 60_000)}m`);
    return parts.join(" · ");
  }
  if (row.state === "error") return row.error ?? "error";
  return `${row.state}…`;
}

/** Live language-server rows, polled while the page is open. M7a's push
 *  of readiness changes can replace the poll once it lands. */
function LanguageServersRow() {
  const [rows, setRows] = useState<LspStatusRow[] | null>(null);
  const projects = useProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      void client
        .request<LspStatusRow[]>("lsp.status")
        .then((next) => {
          if (!cancelled) setRows(next);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <Row
      label="Language servers"
      description={
        rows === null
          ? "…"
          : rows.length === 0
            ? "None running. A server starts when a file that needs it opens."
            : undefined
      }
    >
      {rows && rows.length > 0 ? (
        <div className="flex flex-col items-end gap-1 text-[12px]">
          {rows.map((row) => (
            <span key={row.serverId} className="flex items-center gap-2">
              <span className="text-content">{LSP_LABEL[row.lang]}</span>
              <span className="text-content/40">
                {projectNames.get(row.projectId) ?? row.projectId}
              </span>
              <span
                className={`tabular-nums ${row.state === "error" ? "text-danger" : "text-content/40"}`}
              >
                {lspRowStatus(row)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </Row>
  );
}

function EditorPage() {
  const [autoSave, setAutoSave] = useState(loadAutoSave);
  const [formatOnSave, setFormatOnSave] = useState<FormatOnSave>(loadFormatOnSave);
  const [ghostText, setGhostText] = useState(loadGhostText);
  const [engine, setEngine] = useState<IdeaEngine | null | undefined>(undefined);
  const [java, setJava] = useState<JavaDoctor | null | undefined>(undefined);
  const [eula, setEula] = useState<{ build: string; text: string } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refreshEngine = useCallback(() => {
    void client
      .request<{ java?: JavaDoctor }>("doctor.get")
      .then((doctor) => {
        setJava(doctor.java ?? null);
        setEngine(doctor.java?.ideaServer ?? null);
      })
      .catch(() => {
        setJava(null);
        setEngine(null);
      });
  }, []);

  useEffect(() => {
    refreshEngine();
  }, [refreshEngine]);

  const onFormat = (patch: Partial<FormatOnSave>) => {
    const next = { ...formatOnSave, ...patch };
    saveFormatOnSave(next);
    setFormatOnSave(next);
  };

  const openGate = () => {
    setGateOpen(true);
    setNote(null);
    if (eula) return;
    // The first open downloads the dist to read its license.
    void client
      .request<{ build: string; text: string }>("idea.eula")
      .then(setEula)
      .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
  };

  const accept = () => {
    void client
      .request("idea.acceptEula")
      .then(() => {
        setGateOpen(false);
        retryBlockedEnsures();
        refreshEngine();
      })
      .catch((error) => setNote(error instanceof Error ? error.message : String(error)));
  };

  const checkUpdate = () => {
    setNote("Checking…");
    void client
      .request<{ current: string; latest: string; updated: boolean }>("idea.checkUpdate")
      .then((r) => {
        setNote(r.updated ? `Updated to ${r.latest}. Accept the EULA again.` : "Up to date.");
        refreshEngine();
      })
      .catch(() => setNote("Update check failed."));
  };

  const jdkState =
    java === undefined
      ? "…"
      : !java || !java.found
        ? (java?.error ?? "No JDK found. Install JDK 21 or newer for Java.")
        : java.error
          ? `JDK ${java.version} — needs 21+`
          : `JDK ${java.version} · ${java.jdtls ? "jdtls ready" : "jdtls downloads on first use"}`;

  const engineState =
    engine === undefined
      ? "…"
      : !engine || !engine.dist
        ? "Not downloaded"
        : engine.accepted
          ? `Ready · build ${engine.build}`
          : "Needs the EULA";

  return (
    <>
      <Row label="Auto save" description="Write 800 ms after the last keystroke. ⌘S still writes at once.">
        <Toggle
          label="Auto save"
          on={autoSave}
          onChange={(on) => {
            saveAutoSave(on);
            setAutoSave(on);
          }}
        />
      </Row>
      <Row label="Format on save">
        <span className="text-[12px] text-content/50">Java</span>
        <Toggle label="Format Java on save" on={formatOnSave.java} onChange={(on) => onFormat({ java: on })} />
        <span className="ml-3 text-[12px] text-content/50">Web</span>
        <Toggle label="Format TypeScript and JavaScript on save" on={formatOnSave.web} onChange={(on) => onFormat({ web: on })} />
      </Row>
      <Row label="Ghost text" description="Inline completions from Claude on your existing login.">
        <Toggle
          label="Ghost text"
          on={ghostText}
          onChange={(on) => {
            saveGhostText(on);
            setGhostText(on);
          }}
        />
      </Row>
      <Row
        label="JDK"
        description={
          <>
            <span className={`block ${java && java.error ? "text-warning" : ""}`}>
              {jdkState}
            </span>
            {java?.path ? (
              <span className="block truncate font-mono text-[11px] text-content/40">
                {java.path}
              </span>
            ) : null}
          </>
        }
      />
      <Row label="IntelliJ engine" description={note ?? engineState}>
        {engine?.accepted ? (
          <SecondaryButton onClick={checkUpdate}>Check for update</SecondaryButton>
        ) : (
          <SecondaryButton onClick={openGate}>Accept EULA</SecondaryButton>
        )}
      </Row>
      <LanguageServersRow />
      {gateOpen ? (
        <Modal
          onClose={() => setGateOpen(false)}
          title="JetBrains EULA"
          description={`intellij-server ${eula?.build ?? ""}`.trim()}
          size="md"
        >
          <div className="px-4 py-3">
            {eula ? (
              <pre className="max-h-80 overflow-y-auto rounded-[10px] border border-content/10 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-content/70">
                {eula.text}
              </pre>
            ) : note ? (
              <p className="text-[12px] text-danger">{note}</p>
            ) : (
              <p className="flex items-center gap-2 text-[12px] text-content/50">
                <MatrixSpinner cell={1.5} /> Downloading the engine to read its license…
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
            <button type="button" onClick={() => setGateOpen(false)} className={GHOST}>
              Cancel
            </button>
            <button type="button" disabled={!eula} onClick={accept} className={PRIMARY}>
              Accept and enable
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
