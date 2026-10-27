import type { ComponentProps, ReactNode } from "react";
import { PageRow } from "../components/page";
import { Button } from "../components/ui/button";
import { INPUT_FIELD_CLASS, Input as FieldInput } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/cn";
import { playCue } from "../lib/sounds";

/**
 * Retired (docs/DESIGN.md): the old settings kit, kept as a shim over the
 * components so every importer takes the new look at once. Build nothing new
 * on it: use `Page`, `PageSection`, `PageRow`, `Switch`, `ChoiceSelect`,
 * `Input` and `Button`. A14 deletes this file once A11's dialogs have left it.
 */

/** A section heading in the page style: 12px medium muted, 24px above it. */
export function Heading({ title, first = false }: { title: string; first?: boolean }) {
  return <h2 className={cn("pb-2 text-xs font-medium text-muted-foreground", first ? null : "pt-6")}>{title}</h2>;
}

export function Row({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <PageRow title={label} description={description}>
      {children}
    </PageRow>
  );
}

/** One of a few, as a joined bar; the radio roles stay. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg border border-input p-0.5">
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <Button
            key={option.value}
            variant="ghost"
            size="xs"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={cn("px-2.5", checked ? "bg-muted text-foreground hover:bg-muted" : "text-muted-foreground hover:text-foreground")}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

export function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch
      aria-label={label}
      checked={on}
      onCheckedChange={(next) => {
        playCue("switch");
        onChange(next);
      }}
    />
  );
}

/** A native select drawn like `SelectTrigger`: the dialogs' tests drive it with change events. */
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "focus-field h-8 rounded-lg border border-input bg-transparent ps-2.5 pe-2 text-[13px] text-foreground hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50",
        className ?? "max-w-52",
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function SecondaryButton({
  onClick,
  disabled = false,
  danger = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Button variant={danger ? "destructive" : "secondary"} size="sm" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

export const INPUT_CLASS = INPUT_FIELD_CLASS;

/** The field at its natural width unless the caller sizes it. */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <FieldInput {...props} className={cn("w-auto", className)} />;
}
