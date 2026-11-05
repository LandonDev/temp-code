import { useEffect } from "react";
import { ColdSelectTrigger, usePendingOpen, useSelectBody, warmSelects } from "./lazy-select";
import type { ChoiceSelect as Body } from "./choice-select-body";

export type { Choice } from "./choice-select-body";

/** The Base UI select rides its own chunk (dialogs and settings open it on a
 *  click, never in the first paint); until it lands the field is its own
 *  trigger, still (`ColdSelectTrigger`): the caller's size and width and the
 *  chosen option's label, so the swap moves nothing. A click on the cold
 *  trigger opens the select as soon as it has landed. A ChoiceSelect is
 *  never in the first paint (a dialog or a page), so it asks for the chunk
 *  as it mounts; the composer's pickers wait for a gesture instead. */
export function ChoiceSelect<T extends string>(props: Parameters<typeof Body<T>>[0]) {
  const B = useSelectBody();
  const [pending, open] = usePendingOpen();
  useEffect(() => {
    if (!B) warmSelects();
  }, [B]);
  if (B) return <B.ChoiceSelect {...props} defaultOpen={pending} />;
  return (
    <ColdSelectTrigger
      size={props.size}
      aria-label={props.label}
      disabled={props.disabled}
      className={props.className}
      onOpen={open}
    >
      {props.options.find((option) => option.value === props.value)?.label ?? props.value}
    </ColdSelectTrigger>
  );
}
