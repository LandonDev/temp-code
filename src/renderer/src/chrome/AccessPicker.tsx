import { Lock, LockOpen, Pencil, Sparkles } from "./icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
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
 *  select whose rows carry each mode's hint under its name. Closing hands
 *  the focus back to the composer through `onClose`. */
export function AccessPicker({ value, onChange, onClose }: Props) {
  const Icon = ICONS[value];
  return (
    <Select
      items={ITEMS}
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as RuntimeMode);
      }}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Permission mode"
        className="shrink-0 border-transparent text-muted-foreground hover:bg-foreground/7 hover:text-foreground data-popup-open:bg-foreground/7 data-popup-open:text-foreground [&>svg]:size-3"
      >
        <SelectValue>
          <Icon className="size-3.5" strokeWidth={1.5} />
          {RUNTIME_MODE_LABEL[value]}
        </SelectValue>
      </SelectTrigger>
      {/* The composer takes the focus back itself, so the trigger must not. */}
      <SelectContent
        side="top"
        align="end"
        alignItemWithTrigger={false}
        data-access-picker
        finalFocus={onClose ? false : undefined}
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
