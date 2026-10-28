import {
  Globe,
  Archive,
  ArrowLeft,
  Bot,
  Camera,
  FileCode,
  Folder,
  GitCompare,
  Keyboard,
  Palette,
  MessageSquarePlus,
  SlidersHorizontal,
  Users,
  type IconComponent,
} from "./icons";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  workspaceSettingsSection,
  type SettingsSectionId,
  type StaticSettingsSectionId,
} from "../lib/settings";
import type { WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { registry, useEnvironments } from "../lib/connection";
import { RailHeading, RailRow } from "./RailRow";

const SECTION_ICONS: Record<StaticSettingsSectionId, IconComponent> = {
  general: SlidersHorizontal,
  defaults: MessageSquarePlus,
  appearance: Palette,
  editor: FileCode,
  keybindings: Keyboard,
  providers: Bot,
  orchestration: Users,
  reviews: GitCompare,
  appshots: Camera,
  remote: Globe,
  archive: Archive,
};

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  onClose: () => void;
};

/** Body of the project rail while settings are open. */
export function SettingsNav({ section, onSelect, onClose }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const workspaces = useWorkspaces();
  // With another host paired, a workspace on it says so: two hosts can hold a folder of the same name.
  const environments = useEnvironments();
  const hostOf = (environmentId: string): string | null =>
    environments.length > 1 && environmentId !== registry.primaryEnvironmentId
      ? (environments.find((e) => e.id === environmentId)?.name ?? environmentId)
      : null;
  // Two workspaces of one name on one host: each says where it sits.
  const folderOf = (workspace: WorkspaceMeta): string | null =>
    workspaceHint(
      workspace,
      workspaces.filter((w) => w.id !== workspace.id && w.environmentId === workspace.environmentId && w.name === workspace.name),
    );

  return (
    <>
      <div
        ref={lockOverscroll}
        aria-label="Settings"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none px-2 pb-2"
      >
        {SETTINGS_GROUPS.map((group, index) => (
          <div
            key={group.id}
            role="group"
            aria-labelledby={`settings-group-${group.id}`}
            className={`flex flex-col ${index === 0 ? "" : "pt-4"}`}
          >
            <RailHeading id={`settings-group-${group.id}`}>{group.label}</RailHeading>
            {SETTINGS_SECTIONS.filter((item) => item.group === group.id).map((item) => (
              <RailRow
                key={item.id}
                label={item.label}
                icon={SECTION_ICONS[item.id]}
                selected={item.id === section}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        ))}
        {workspaces.length ? (
          <div role="group" aria-labelledby="settings-group-workspaces" className="flex flex-col pt-4">
            <RailHeading id="settings-group-workspaces">Workspaces</RailHeading>
            {workspaces.map((workspace) => {
              const id = workspaceSettingsSection(workspace.id);
              return (
                <RailRow
                  key={id}
                  label={workspace.name}
                  trailing={hostOf(workspace.environmentId) ?? folderOf(workspace)}
                  icon={Folder}
                  selected={id === section}
                  onClick={() => onSelect(id)}
                />
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col border-t border-border p-2">
        <RailRow label="Back" icon={ArrowLeft} onClick={onClose} />
      </div>
    </>
  );
}

/**
 * What tells a workspace apart from its same-named twins on one host: the
 * shortest end of its parent folder's path that no twin shares ("work", or
 * "me/work" when two parents are both called work), else its whole path.
 * Null without a twin.
 */
export function workspaceHint(workspace: WorkspaceMeta, twins: readonly WorkspaceMeta[]): string | null {
  if (twins.length === 0) return null;
  const parentParts = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).filter(Boolean);
  const own = parentParts(workspace.path);
  const others = twins.map((twin) => parentParts(twin.path));
  for (let n = 1; n <= own.length; n++) {
    const tail = own.slice(-n).join("/");
    if (others.every((parts) => parts.slice(-n).join("/") !== tail)) return tail;
  }
  return workspace.path;
}
