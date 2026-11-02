import { cn } from "../lib/cn";
import { ROW_CONTROL } from "./composerRow";
import { Lock, LockOpen, Pencil } from "./icons";
import { ColdSelectTrigger, usePendingOpen, useSelectBody } from "../components/lazy-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { RUNTIME_MODE_LABEL, shownRuntimeMode, type RuntimeMode } from "../lib/session";

export type AccessPickerProps = {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  onClose?: () => void;
  /** The composer's row under the box: 24px, 12px muted (`ROW_CONTROL`). */
  quiet?: boolean;
};

export const ACCESS_ICONS: Record<RuntimeMode, typeof Lock> = {
  supervised: Lock,
  "auto-accept-edits": Pencil,
  auto: Pencil,
  "full-access": LockOpen,
};

/** The trigger's classes, cold or real. */
export function accessTriggerClass(quiet: boolean): string {
  return cn(
    "shrink-0 border-transparent text-muted-foreground hover:bg-foreground/7 hover:text-foreground data-popup-open:bg-foreground/7 data-popup-open:text-foreground [&>svg]:size-3",
    quiet && `${ROW_CONTROL} gap-1 py-0 ps-2 pe-1.5 data-[size=sm]:h-6`,
  );
}

/** What the trigger shows: the mode's icon and, while the bar has room, its name. */
export function AccessValue({ value }: { value: RuntimeMode }) {
  const Icon = ACCESS_ICONS[value];
  return (
    <>
      <Icon className="size-3.5" />
      <span className="@max-[20rem]/composer-bar:hidden">{RUNTIME_MODE_LABEL[value]}</span>
    </>
  );
}

/** The permission mode, at the right end of the composer's row: a quiet
 *  select whose rows carry each mode's hint under its name. A pick hands
 *  the focus back to the composer through `onClose`; Escape and an outside
 *  press return it to the trigger. In a narrow bar the label gives way to
 *  the icon; the name and tooltip still say the mode. The select itself is
 *  `AccessPickerSelect` in the select chunk (chrome/composerSelects.tsx);
 *  until it lands this is its trigger alone (components/lazy-select.tsx). */
export function AccessPicker(props: AccessPickerProps) {
  const B = useSelectBody();
  const [pending, open] = usePendingOpen();
  if (B) return <B.AccessPickerSelect {...props} defaultOpen={pending} />;
  const value = shownRuntimeMode(props.value);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ColdSelectTrigger
            size="sm"
            aria-label={`Permission mode: ${RUNTIME_MODE_LABEL[value]}`}
            className={accessTriggerClass(props.quiet ?? false)}
            onOpen={open}
          />
        }
      >
        <AccessValue value={value} />
      </TooltipTrigger>
      <TooltipContent>Permission mode: {RUNTIME_MODE_LABEL[value]}</TooltipContent>
    </Tooltip>
  );
}
