import { MessageMultiple, Replace, type IconComponent } from "./icons";
import { useMemo, useSyncExternalStore } from "react";
import {
  getHarnessAvailabilitySnapshot,
  hasProbedHarnessAvailability,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
} from "../lib/harness/availability";
import { refreshHarnessCatalogs } from "../lib/harness/registry";
import {
  getModelSnapshot,
  getPickerVisibilitySnapshot,
  isPickerProviderVisible,
  modelsFor,
  preferredModelId,
  subscribeModels,
  subscribePickerVisibility,
} from "../lib/models";
import { secondOpinionTargets } from "../lib/secondOpinion";
import { HARNESS_TITLE, type HarnessId } from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import { RowsMenu, type MenuIcon, type MenuRow } from "./menuRows";
import { IconAction } from "../surfaces/transcript/IconAction";

type Props = {
  from: HarnessId;
  onPick: (harness: HarnessId, model: string) => void;
  icon?: IconComponent;
  title?: string;
  disabledTitle?: string;
  description?: string;
  menuLabel?: string;
  /** False until the row's first hover: the trigger renders without its tooltip. */
  armed?: boolean;
};

const marks = new Map<HarnessId, MenuIcon>();
/** One stable glyph component per provider for the menu rows. */
function harnessMark(harness: HarnessId): MenuIcon {
  let mark = marks.get(harness);
  if (!mark) {
    mark = function HarnessMark() {
      return <HarnessIcon harness={harness} className="size-3.5" />;
    };
    marks.set(harness, mark);
  }
  return mark;
}

/** A pick's id: the provider, then the model after the first colon. */
const pickId = (harness: HarnessId, model: string): string => `${harness}:${model}`;

export function HandoffButton({ from, onPick, armed }: Pick<Props, "from" | "onPick" | "armed">) {
  return (
    <SecondOpinionButton
      from={from}
      onPick={onPick}
      armed={armed}
      icon={Replace}
      title="Hand off"
      disabledTitle="Install another provider to hand off"
      description="Hand this session to another agent to continue the work."
      menuLabel="Hand this session to another agent"
    />
  );
}

/**
 * A turn's handoff or second opinion: the other providers as a menu, each
 * provider's models in its submenu with the preferred one ticked. A
 * provider without a model list picks its preferred model at once.
 */
export function SecondOpinionButton({
  from,
  onPick,
  icon: Icon = MessageMultiple,
  title = "Second opinion",
  disabledTitle = "Install another provider for a second opinion",
  description = "Send this turn to another agent to review the work.",
  menuLabel = "Send this turn to another agent",
  armed = true,
}: Props) {
  const availabilityVersion = useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const visibilityVersion = useSyncExternalStore(
    subscribePickerVisibility,
    getPickerVisibilitySnapshot,
    getPickerVisibilitySnapshot,
  );
  // The rows read the catalog while open; a refresh re-renders them.
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);

  const probed = hasProbedHarnessAvailability();
  const targets = useMemo(() => {
    void availabilityVersion;
    void visibilityVersion;
    return secondOpinionTargets(from, {
      installed: isHarnessAvailable,
      visible: isPickerProviderVisible,
      probed,
    });
  }, [from, probed, availabilityVersion, visibilityVersion]);

  const disabled = targets.length === 0;
  const label = disabled ? disabledTitle : title;

  const rows = (): MenuRow[] => [
    { kind: "note", id: "description", content: <span className="text-balance">{description}</span> },
    { kind: "sep" },
    ...targets.map((harness): MenuRow => {
      const off = !isHarnessAvailable(harness) && probed;
      const models = modelsFor(harness);
      if (models.length === 0) {
        return { kind: "item", id: pickId(harness, preferredModelId(harness)), label: HARNESS_TITLE[harness], icon: harnessMark(harness), disabled: off };
      }
      const preferred = preferredModelId(harness);
      return {
        kind: "sub",
        id: harness,
        label: HARNESS_TITLE[harness],
        icon: harnessMark(harness),
        disabled: off,
        items: models.map((model): MenuRow => ({
          kind: "item",
          id: pickId(harness, model.id),
          label: model.name,
          checked: model.id === preferred,
        })),
      };
    }),
  ];

  const pick = (id: string) => {
    const at = id.indexOf(":");
    if (at > 0) onPick(id.slice(0, at) as HarnessId, id.slice(at + 1));
  };

  return (
    <RowsMenu
      trigger={
        <IconAction label={label} armed={false} disabled={disabled}>
          <Icon className="size-3.5" />
        </IconAction>
      }
      tip={armed ? { label } : undefined}
      label={menuLabel}
      rows={rows}
      onPick={pick}
      onOpenChange={(open) => {
        if (!open) return;
        void probeHarnessAvailability();
        if (targets.length) void refreshHarnessCatalogs(targets);
      }}
      side="top"
      align="center"
      className="w-60"
    />
  );
}
