import { useRef } from "react";
import { Lock, LockOpen, Pencil, Sparkles } from "./icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { RUNTIME_MODE_HINT, RUNTIME_MODE_LABEL, RUNTIME_MODES, type RuntimeMode } from "../lib/session";

type Props = {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  onClose?: () => void;
};

const ICONS: Record<RuntimeMode, typeof Lock> = {
  supervised: Lock,
  "auto-accept-edits": Pencil,
  auto: Sparkles,
  "full-access": LockOpen,
};

const ITEMS = RUNTIME_MODES.map((mode) => ({ value: mode, label: RUNTIME_MODE_LABEL[mode] }));

/** The permission mode, at the right end of the composer's bar: a quiet
 *  select whose rows carry each mode's hint under its name. A pick hands
 *  the focus back to the composer through `onClose`; Escape and an outside
 *  press return it to the trigger. In a narrow bar the label gives way to
 *  the icon; the name and tooltip still say the mode. */
export function AccessPicker({ value, onChange, onClose }: Props) {
  const Icon = ICONS[value];
  const toField = useRef(false);
  return (
    <Select
      items={ITEMS}
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as RuntimeMode);
      }}
      onOpenChange={(open, details) => {
        toField.current = !open && details.reason === "item-press" && !!onClose;
        if (toField.current) onClose?.();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              size="sm"
              aria-label={`Permission mode: ${RUNTIME_MODE_LABEL[value]}`}
              className="shrink-0 border-transparent text-muted-foreground hover:bg-foreground/7 hover:text-foreground data-popup-open:bg-foreground/7 data-popup-open:text-foreground [&>svg]:size-3"
            />
          }
        >
          <SelectValue>
            <Icon className="size-3.5" strokeWidth={1.5} />
            <span className="@max-[21rem]/composer-bar:hidden">{RUNTIME_MODE_LABEL[value]}</span>
          </SelectValue>
        </TooltipTrigger>
        <TooltipContent>Permission mode: {RUNTIME_MODE_LABEL[value]}</TooltipContent>
      </Tooltip>
      {/* After a pick the composer takes the focus back itself, so the trigger must not. */}
      <SelectContent
        side="top"
        align="end"
        alignItemWithTrigger={false}
        data-access-picker
        finalFocus={() => !toField.current}
        className="w-72 p-1"
      >
        {RUNTIME_MODES.map((mode) => {
          const ModeIcon = ICONS[mode];
          return (
            <SelectItem key={mode} value={mode} label={RUNTIME_MODE_LABEL[mode]} className="items-start py-1.5">
              <ModeIcon className="mt-0.5 size-3.5 text-muted-foreground" strokeWidth={1.5} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{RUNTIME_MODE_LABEL[mode]}</span>
                <span className="whitespace-normal text-xs text-muted-foreground">{RUNTIME_MODE_HINT[mode]}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
