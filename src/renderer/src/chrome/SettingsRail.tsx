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
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  workspaceSettingsSection,
  type SettingsSectionId,
  type StaticSettingsSectionId,
} from "../lib/settings";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { registry, useEnvironments } from "../lib/connection";

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

  return (
    <>
      <div
        ref={lockOverscroll}
        aria-label="Settings"
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-none px-2 pb-2"
      >
        {SETTINGS_GROUPS.map((group, index) => (
          <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} className="flex flex-col gap-px">
            <GroupHeading id={`settings-group-${group.id}`} first={index === 0}>
              {group.label}
            </GroupHeading>
            {SETTINGS_SECTIONS.filter((item) => item.group === group.id).map((item) => (
              <NavRow
                key={item.id}
                label={item.label}
                icon={SECTION_ICONS[item.id]}
                active={item.id === section}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        ))}
        {workspaces.length ? <GroupHeading>Workspaces</GroupHeading> : null}
        {workspaces.map((workspace) => {
          const id = workspaceSettingsSection(workspace.id);
          return (
            <NavRow
              key={id}
              label={workspace.name}
              detail={hostOf(workspace.environmentId)}
              icon={Folder}
              active={id === section}
              onClick={() => onSelect(id)}
            />
          );
        })}
      </div>
      <div className="flex shrink-0 flex-col gap-px p-2">
        <NavRow label="Back" icon={ArrowLeft} onClick={onClose} />
      </div>
    </>
  );
}

/** A group's name over its pages: 12px medium muted, never uppercase. */
function GroupHeading({ id, first = false, children }: { id?: string; first?: boolean; children: string }) {
  return (
    <div id={id} className={`px-2 pb-1 text-xs font-medium text-muted-foreground ${first ? "pt-1" : "pt-4"}`}>
      {children}
    </div>
  );
}

function NavRow({
  label,
  detail,
  icon: Icon,
  active = false,
  onClick,
}: {
  label: string;
  /** A muted word after the label: the host a workspace lives on. */
  detail?: string | null;
  icon: IconComponent;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "h-9 w-full justify-start gap-2 px-2 text-[13px] font-normal",
        active ? "bg-muted text-foreground hover:bg-muted" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">
        {label}
        {detail ? <span className="ml-2 text-muted-foreground">{detail}</span> : null}
      </span>
    </Button>
  );
}
