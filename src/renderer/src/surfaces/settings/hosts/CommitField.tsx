import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/cn";

/**
 * The one settings field: commits on blur or Enter, snaps back to the value
 * when the text is not one it takes, and Escape restores it. A number field
 * takes a whole number (`int`) or a decimal in `min`..`max`; with
 * `allowEmpty` an empty field commits null (follow the default). A text
 * field commits its trimmed text when it changed.
 */
type Shared = Omit<ComponentProps<"input">, "value" | "onChange" | "type" | "min" | "max"> & { "aria-label": string };
type NumberField = Shared & {
  kind: "int" | "decimal";
  value: number | null;
  min?: number;
  max?: number;
  allowEmpty?: boolean;
  onCommit: (value: number | null) => void;
};
type TextField = Shared & { kind?: "text"; value: string; onCommit: (value: string) => void };

const shown = (props: NumberField | TextField): string => (props.value === null ? "" : String(props.value));

export function CommitField(props: NumberField | TextField) {
  // One shape for both kinds: a text field simply has no min, max or allowEmpty.
  const { kind = "text", value, onCommit, min, max, allowEmpty, className, onFocus, onBlur, onKeyDown, ...input } = props as NumberField;
  const [text, setText] = useState(shown(props));
  const editing = useRef(false);
  const committed = shown(props);
  useEffect(() => {
    if (!editing.current) setText(committed);
  }, [committed]);

  const commit = (): void => {
    const raw = text.trim();
    if (kind === "text") {
      const field = props as TextField;
      if (raw !== field.value) field.onCommit(raw);
      return;
    }
    if (raw === "") {
      if (allowEmpty && value !== null) onCommit(null);
      else setText(committed);
      return;
    }
    const n = Number(raw);
    const fits = Number.isFinite(n) && (kind === "decimal" || Number.isInteger(n)) && n >= (min ?? -Infinity) && n <= (max ?? Infinity);
    if (fits && n !== value) onCommit(n);
    else setText(committed);
  };

  return (
    <Input
      {...input}
      inputMode={kind === "int" ? "numeric" : kind === "decimal" ? "decimal" : undefined}
      spellCheck={kind === "text" ? false : undefined}
      autoComplete="off"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        editing.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        editing.current = false;
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setText(committed);
          editing.current = false;
          // Blur without committing: the restored text equals the value.
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
        onKeyDown?.(e);
      }}
      className={cn(kind === "text" ? null : "w-20 text-right tabular-nums", className)}
    />
  );
}
