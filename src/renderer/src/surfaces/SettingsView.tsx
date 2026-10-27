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
          {section === "defaults" ? <ThreadDefaultsPage /> : null}
          {workspace ? <WorkspacePage key={workspace.id} workspaceId={workspace.id} /> : null}
          {section === "appearance" ? (
            <AppearancePage appearance={appearance} />
          ) : null}
          {section === "editor" ? <EditorPage /> : null}
          {section === "keybindings" ? <KeybindingsPage /> : null}
          {section === "providers" ? <ProvidersPage /> : null}
          {section === "orchestration" ? <OrchestrationPage /> : null}
          {section === "build" ? <BuildPage /> : null}
          {section === "reviews" ? <ReviewsPage /> : null}
          {section === "appshots" ? <AppshotsPage /> : null}
          {section === "remote" ? <RemoteSettings onOpenSession={onOpenSession} /> : null}
          {section === "environments" ? <EnvironmentsSettings /> : null}
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

function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="pb-4">
      <h1 className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-content">
        {title}
      </h1>
      {description ? (
        <p className="mt-1 max-w-xl text-[13px] text-content/40">
          {description}
        </p>
      ) : null}
    </header>
  );
}
