import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";

/** `group` names the heading an option sits under (a provider); options
 *  without one come first, ungrouped. */
export type Choice<T extends string> = { value: T; label: string; group?: string };

/**
 * The one adapter from an options array to `Select`: every options list in
 * the app goes through it, so nothing maps `SelectItem`s by hand. An empty
 * string is an ordinary value (Auto, Provider default) and round-trips.
 * Imported through choice-select.tsx, which loads this and the Base UI
 * select off the first paint.
 */
export function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  size = "default",
  className,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as T);
      }}
    >
      <SelectTrigger aria-label={label} size={size} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {groupsOf(options).map(({ group, items }) =>
          group ? (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {items.map(item)}
            </SelectGroup>
          ) : (
            items.map(item)
          ),
        )}
      </SelectContent>
    </Select>
  );
}

function item<T extends string>(option: Choice<T>) {
  return (
    <SelectItem key={option.value} value={option.value}>
      {option.label}
    </SelectItem>
  );
}

/** Options in runs by group, in the order each group first appears; the
 *  ungrouped run first. */
function groupsOf<T extends string>(options: readonly Choice<T>[]): { group?: string; items: Choice<T>[] }[] {
  const runs: { group?: string; items: Choice<T>[] }[] = [];
  for (const option of options) {
    const run = runs.find((r) => r.group === option.group);
    if (run) run.items.push(option);
    else runs.push({ group: option.group, items: [option] });
  }
  return runs.sort((a, b) => Number(a.group !== undefined) - Number(b.group !== undefined));
}

