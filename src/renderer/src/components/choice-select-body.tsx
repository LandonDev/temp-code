import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type Choice<T extends string> = { value: T; label: string };

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
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

