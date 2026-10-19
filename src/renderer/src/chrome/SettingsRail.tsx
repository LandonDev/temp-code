import {
  Globe,
  Laptop,
  Archive,
  ArrowLeft,
  Bot,
  Camera,
  FileCode,
  Folder,
  Keyboard,
  Palette,
  MessageSquarePlus,
  SlidersHorizontal,
  Users,
  Wrench,
  type IconComponent,
} from "./icons";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import {
  SETTINGS_SECTIONS,
  workspaceSettingsSection,
  type SettingsSectionId,
  type StaticSettingsSectionId,
} from "../lib/settings";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { isWebMode } from "../lib/nativeWeb";
import { registry, useEnvironments } from "../lib/connection";

/** The page at /ui sees one environment and cannot add another; the section would be dead there. */
const sections = () => SETTINGS_SECTIONS.filter((item) => item.id !== "environments" || !isWebMode());

const SECTION_ICONS: Record<StaticSettingsSectionId, IconComponent> = {
  general: SlidersHorizontal,
  defaults: MessageSquarePlus,
  appearance: Palette,
  editor: FileCode,
  keybindings: Keyboard,
  providers: Bot,
  orchestration: Users,
  build: Wrench,
  appshots: Camera,
  remote: Globe,
  environments: Laptop,
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
        {sections().map((item) => (
          <NavRow
            key={item.id}
            label={item.label}
            icon={SECTION_ICONS[item.id]}
            active={item.id === section}
            onClick={() => onSelect(item.id)}
          />
        ))}
        {workspaces.length ? (
          <div className="px-2 pb-1 pt-4 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
            Workspaces
          </div>
        ) : null}
        {workspaces.map((workspace) => {
          const id = workspaceSettingsSection(workspace.id);
          return (
            <NavRow
              key={id}
              label={hostOf(workspace.environmentId) ? `${workspace.name} · ${hostOf(workspace.environmentId)}` : workspace.name}
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

function NavRow({
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  label: string;
  icon: IconComponent;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${
        active
          ? "bg-content/10 text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content"
      }`}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
        {label}
      </span>
    </button>
  );
}
