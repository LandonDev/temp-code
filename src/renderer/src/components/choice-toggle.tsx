import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export type ToggleChoice<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  /** Why it is off, on a Tooltip over the choice. */
  note?: string;
};

/**
 * The one adapter from an options array to a single-choice `ToggleGroup`:
 * a bordered track with the chosen option filled, for the few choices a
 * dialog row shows at once (Type, Effort, Host). One option is always
 * chosen: pressing the chosen one again keeps it.
 */
function ChoiceToggle<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  "aria-labelledby": labelledBy,
}: {
  label: string;
  value: T;
  options: readonly ToggleChoice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  "aria-labelledby"?: string;
}) {
  return (
    <ToggleGroup
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange(picked);
      }}
      disabled={disabled}
      size="xs"
      spacing={0.5}
      className="rounded-lg border border-input p-0.5"
    >
      {options.map((option) => {
        const item = (
          <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled} className="px-2">
            {option.label}
          </ToggleGroupItem>
        );
        // A disabled button takes no pointer, so its note hangs on a wrapper.
        return option.note ? (
          <Tooltip key={option.value}>
            <TooltipTrigger render={<span data-choice-note className="inline-flex" />}>{item}</TooltipTrigger>
            <TooltipContent>{option.note}</TooltipContent>
          </Tooltip>
        ) : (
          item
        );
      })}
    </ToggleGroup>
  );
}

export { ChoiceToggle };
