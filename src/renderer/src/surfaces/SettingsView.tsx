import { RotateCcw } from "../chrome/icons";
import { useEffect } from "react";
import { WindowControls } from "../chrome/WindowControls";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { prettyCwd } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { settingsSectionDescription, settingsSectionLabel } from "../lib/settings";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { workspaceOfSection } from "../lib/settings";
import { AppshotsPage } from "./AppshotsSettings";
import { ReviewsPage } from "./ReviewSettings";
import { RemoteSettings } from "./RemoteSettings";
import { EnvironmentsSettings } from "./EnvironmentsSettings";
import { shell, useShell } from "../stores/shell";
import { isWebMode } from "../lib/nativeWeb";
import { Page } from "../components/page";
import { GeneralPage } from "./settings/General";
import { ThreadDefaultsPage } from "./settings/ThreadDefaults";
import { AppearancePage, useAppearanceSettings } from "./settings/Appearance";
import { EditorPage } from "./settings/Editor";
import { KeybindingsPage } from "./settings/Keybindings";
import { ProvidersPage } from "./settings/Providers";
import { WorkspacePage } from "./settings/Workspace";
import { OrchestrationPage } from "./settings/Orchestration";
import { BuildPage } from "./settings/Build";
import { ArchivePage } from "./settings/Archive";

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
        <div className="flex-1" />
        {section === "appearance" ? (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={appearance.restoreDefaults}
            className="pressable mr-2 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
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
        <Page
          title={title}
          description={
            workspaceId
              ? workspace
                ? prettyCwd(workspace.path)
                : "This workspace was removed."
              : settingsSectionDescription(section)
          }
        >
          {/* A page not yet built on PageSection renders inside one block, so the
              frame's 24px section gap never lands between its rows. */}
          {section === "general" ? <GeneralPage onOpenWhatsNew={onOpenWhatsNew} /> : null}
          {section === "defaults" ? <ThreadDefaultsPage /> : null}
          {workspace ? (
            <div>
              <WorkspacePage key={workspace.id} workspaceId={workspace.id} />
            </div>
          ) : null}
          {section === "appearance" ? (
            <div>
              <AppearancePage appearance={appearance} />
            </div>
          ) : null}
          {section === "editor" ? (
            <div>
              <EditorPage />
            </div>
          ) : null}
          {section === "keybindings" ? (
            <div>
              <KeybindingsPage />
            </div>
          ) : null}
          {section === "providers" ? (
            <div>
              <ProvidersPage />
            </div>
          ) : null}
          {section === "orchestration" ? (
            <div>
              <OrchestrationPage />
            </div>
          ) : null}
          {section === "build" ? (
            <div>
              <BuildPage />
            </div>
          ) : null}
          {section === "reviews" ? (
            <div>
              <ReviewsPage />
            </div>
          ) : null}
          {section === "appshots" ? (
            <div>
              <AppshotsPage />
            </div>
          ) : null}
          {section === "remote" ? (
            <div>
              <RemoteSettings onOpenSession={onOpenSession} />
              {/* Until A16 merges the two, Hosts shows both; /ui sees one environment and cannot add another. */}
              {isWebMode() ? null : <EnvironmentsSettings />}
            </div>
          ) : null}
          {section === "archive" ? (
            <div>
              <ArchivePage
                onOpenSession={onOpenSession}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
                onRestoreProject={onRestoreProject}
                onDeleteProject={onDeleteProject}
              />
            </div>
          ) : null}
        </Page>
      </div>
    </div>
  );
}
