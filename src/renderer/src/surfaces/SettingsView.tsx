import { WindowControls } from "../chrome/WindowControls";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { usePageEscape } from "../lib/pageEscape";
import { prettyCwd } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { settingsSectionDescription, settingsSectionLabel } from "../lib/settings";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { workspaceOfSection } from "../lib/settings";
import { AppshotsPage } from "./AppshotsSettings";
import { ReviewsPage } from "./ReviewSettings";
import { HostsPage } from "./settings/hosts/HostsPage";
import { shell, useShell } from "../stores/shell";
import { PAGE_SCROLLER, Page } from "../components/page";
import { cn } from "../lib/cn";
import { DESKTOP_ONLY_LINE, isWebMode } from "../lib/nativeWeb";
import { Empty, EmptyTitle } from "../components/ui/empty";
import { GeneralPage } from "./settings/General";
import { ThreadDefaultsPage } from "./settings/ThreadDefaults";
import { AppearancePage } from "./settings/Appearance";
import { EditorPage } from "./settings/Editor";
import { KeybindingsPage } from "./settings/Keybindings";
import { ProvidersPage } from "./settings/Providers";
import { WorkspacePage } from "./settings/Workspace";
import { OrchestrationPage } from "./settings/Orchestration";
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
  const workspaceId = workspaceOfSection(section);
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const title = workspace?.name ?? settingsSectionLabel(section);

  usePageEscape(() => shell.closeSettings(), { fields: "undo" });

  return (
    <div
      role="region"
      aria-label="Settings"
      data-app-settings
      className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-border"
        data-tauri-drag-region="deep"
      >
        <div className="flex-1" />
        {IS_MAC ? null : <WindowControls />}
      </div>

      {/* Keyed by the section (a workspace's carries its id), so each page
          opens at its top; the stable gutter keeps the column still when a
          page gains a scrollbar. */}
      <div
        key={section}
        ref={lockOverscroll}
        className={cn(PAGE_SCROLLER, "overscroll-none")}
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
          {workspace ? <WorkspacePage key={workspace.id} workspaceId={workspace.id} /> : null}
          {section === "appearance" ? <AppearancePage /> : null}
          {section === "editor" ? <EditorPage /> : null}
          {section === "keybindings" ? <KeybindingsPage /> : null}
          {section === "providers" ? <ProvidersPage /> : null}
          {section === "orchestration" ? <OrchestrationPage /> : null}
          {section === "reviews" ? <ReviewsPage /> : null}
          {section === "appshots" ? (
            isWebMode() ? (
              <Empty>
                <EmptyTitle>{DESKTOP_ONLY_LINE}</EmptyTitle>
              </Empty>
            ) : (
              <AppshotsPage />
            )
          ) : null}
          {section === "remote" ? <HostsPage onOpenSession={onOpenSession} /> : null}
          {section === "archive" ? (
            <ArchivePage
              onOpenSession={onOpenSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
              onRestoreProject={onRestoreProject}
              onDeleteProject={onDeleteProject}
            />
          ) : null}
        </Page>
      </div>
    </div>
  );
}
