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
import { HostsPage } from "./settings/hosts/HostsPage";
import { shell, useShell } from "../stores/shell";
import { Page } from "../components/page";
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

  useEffect(() => {
    // The value a field held when it took focus, so Escape can put it back.
    const entered = new WeakMap<Element, string>();
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (target && isTextField(target)) entered.set(target, target.value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as Element | null;
      // A dialog, or an open list or menu, owns its own Escape.
      if (target?.closest?.('[role="dialog"], [role="listbox"], [role="menu"], [data-slot=select-content]')) return;
      if (document.querySelector("[data-slot=select-content][data-open]")) return;
      event.preventDefault();
      event.stopPropagation();
      // A focused field takes Escape: its edit is undone and it lets go.
      if (target && isTextField(target)) {
        const before = entered.get(target);
        if (before !== undefined && before !== target.value) setFieldValue(target, before);
        target.blur();
        return;
      }
      if (target instanceof HTMLSelectElement) {
        target.blur();
        return;
      }
      shell.closeSettings();
    };
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKey, true);
    };
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
          {workspace ? <WorkspacePage key={workspace.id} workspaceId={workspace.id} /> : null}
          {section === "appearance" ? <AppearancePage /> : null}
          {section === "editor" ? <EditorPage /> : null}
          {section === "keybindings" ? <KeybindingsPage /> : null}
          {section === "providers" ? <ProvidersPage /> : null}
          {section === "orchestration" ? <OrchestrationPage /> : null}
          {section === "reviews" ? <ReviewsPage /> : null}
          {section === "appshots" ? <AppshotsPage /> : null}
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

type TextField = HTMLInputElement | HTMLTextAreaElement;

const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);

function isTextField(el: Element): el is TextField {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type));
}

/** Sets a field's value the way typing would, so React's onChange hears it. */
function setFieldValue(field: TextField, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
