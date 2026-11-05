import { ROW_CONTROL } from "./composerRow";
import type { ThreadType } from "../lib/tcserver/types";
import { ColdSelectTrigger, usePendingOpen, useSelectBody } from "../components/lazy-select";
import { THREAD_LABELS } from "../surfaces/threads/threadTypes";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";

export type ThreadTypeChipProps = {
  value: ThreadType;
  onChange: (type: ThreadType) => void;
  onClose?: () => void;
};

/** The draft row's 24px box, as its other pickers: the select's `sm` 28px
 *  steps down to `h-6`, and the glyph sits 4px from its word (the trigger's
 *  own gap, and the value's inside the real select). */
export const THREAD_TYPE_TRIGGER = `${ROW_CONTROL} shrink-0 gap-1 border-transparent px-1.5 py-0 data-[size=sm]:h-6 *:data-[slot=select-value]:gap-1 [&>svg]:size-3`;

/** The trigger's value: the type's glyph and name. */
export function ThreadTypeValue({ value }: { value: ThreadType }) {
  return (
    <>
      <TypeGlyph type={value} className="size-3.5" />
      {THREAD_LABELS[value]}
    </>
  );
}

/** What kind of thread this is, in the composer's top row: a select of
 *  the thread types, each with its hint under its name. Closing hands the
 *  focus back to the composer through `onClose`. The select itself is
 *  `ThreadTypeSelect` in the select chunk (chrome/composerSelects.tsx);
 *  until it lands this is its trigger alone (components/lazy-select.tsx). */
export function ThreadTypeChip(props: ThreadTypeChipProps) {
  const B = useSelectBody();
  const [pending, open] = usePendingOpen();
  if (B) return <B.ThreadTypeSelect {...props} defaultOpen={pending} />;
  return (
    <ColdSelectTrigger size="sm" aria-label="Thread type" data-thread-type-picker className={THREAD_TYPE_TRIGGER} onOpen={open}>
      <ThreadTypeValue value={props.value} />
    </ColdSelectTrigger>
  );
}
