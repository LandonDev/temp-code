import type { ThreadType } from "../lib/tcserver/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { THREAD_GLYPHS, THREAD_HINTS, THREAD_LABELS, THREAD_TYPES } from "../surfaces/threads/threadTypes";

type Props = {
  value: ThreadType;
  onChange: (type: ThreadType) => void;
  onClose?: () => void;
};

const ITEMS = THREAD_TYPES.map((type) => ({ value: type, label: THREAD_LABELS[type] }));

/** What kind of thread this is, in the composer's top row: a select of
 *  the thread types, each with its hint under its name. Closing hands the
 *  focus back to the composer through `onClose`. */
export function ThreadTypeChip({ value, onChange, onClose }: Props) {
  const Glyph = THREAD_GLYPHS[value];
  return (
    <Select
      items={ITEMS}
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as ThreadType);
      }}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Thread type"
        data-thread-type-picker
        className="shrink-0 border-transparent px-1.5 text-xs text-muted-foreground hover:bg-foreground/7 hover:text-foreground data-popup-open:text-foreground [&>svg]:size-3"
      >
        <SelectValue>
          <Glyph className="size-3.5" strokeWidth={1.5} />
          {THREAD_LABELS[value]}
        </SelectValue>
      </SelectTrigger>
      {/* The composer takes the focus back itself, so the trigger must not. */}
      <SelectContent
        align="start"
        data-thread-type-picker
        finalFocus={onClose ? false : undefined}
        className="w-72 p-1"
      >
        {THREAD_TYPES.map((type) => {
          const Icon = THREAD_GLYPHS[type];
          return (
            <SelectItem key={type} value={type} label={THREAD_LABELS[type]} className="items-start py-1.5">
              <Icon className="mt-0.5 size-3.5 text-muted-foreground" strokeWidth={1.5} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{THREAD_LABELS[type]}</span>
                <span className="whitespace-normal text-xs text-muted-foreground">{THREAD_HINTS[type]}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
