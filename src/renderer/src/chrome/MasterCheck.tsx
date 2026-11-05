import { CHECKBOX_BOX, CHECKBOX_INDICATOR, CHECKBOX_SHAPES, CheckMark } from "../components/ui/checkbox-box";
import { useSelectBody, warmSelects } from "../components/lazy-select";
import { cn } from "../lib/cn";
import { ROW_CONTROL } from "./composerRow";
import { selectChunk } from "../surfaces/chunks";

/** The box at the row's 14px glyph size, its hit area the label's. */
const BOX = "size-3.5 after:hidden [&_svg]:size-2.5";

/**
 * An unsent chat draft's "Master thread" pick in the composer's draft row,
 * beside the type it applies to: the first send creates the thread pinned
 * as a master. The label is the hit area, a row control (`ROW_CONTROL`)
 * like every picker in the row; the box alone says ticked. The box is
 * `Checkbox` from the select chunk (components/select-body.ts), Base UI
 * staying out of the first paint; until it lands it is the same box drawn
 * still, which a click still ticks, and the pointer entering it swaps it
 * as the cold pickers swap (components/lazy-select.tsx).
 */
export function MasterCheck({ checked, onChange }: { checked: boolean; onChange: (master: boolean) => void }) {
  const B = useSelectBody();
  return (
    <label
      data-composer-master
      className={cn("flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded-md px-1.5 select-none", ROW_CONTROL)}
    >
      {B ? (
        <B.Checkbox checked={checked} onCheckedChange={(next) => onChange(next)} className={BOX} />
      ) : (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          data-slot="checkbox"
          data-shape="square"
          {...(checked ? { "data-checked": "" } : { "data-unchecked": "" })}
          className={cn(CHECKBOX_BOX, CHECKBOX_SHAPES.square, BOX)}
          onPointerEnter={warmSelects}
          onFocus={() => selectChunk.preload()}
          onClick={() => onChange(!checked)}
        >
          <span data-slot="checkbox-indicator" className={CHECKBOX_INDICATOR}>
            <CheckMark />
          </span>
        </button>
      )}
      Master thread
    </label>
  );
}
