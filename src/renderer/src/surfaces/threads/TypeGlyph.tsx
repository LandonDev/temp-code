import { cn } from "../../lib/cn";
import type { ThreadType } from "../../lib/tcserver/types";
import { THREAD_GLYPHS, typeTint } from "./threadTypes";

/** A thread type's glyph in its type's tint (docs/DESIGN.md "Type tints"):
 *  the one coloured glyph besides `StatusMark`. The caller sets the size; a
 *  row's own dimming dims it with the row. An absent type draws chat. */
export function TypeGlyph({ type, className }: { type: ThreadType | null | undefined; className?: string }) {
  const t = type && Object.hasOwn(THREAD_GLYPHS, type) ? type : "chat";
  const Glyph = THREAD_GLYPHS[t];
  return <Glyph aria-hidden data-type-glyph={t} className={cn("shrink-0", typeTint(t), className)} strokeWidth={1.5} />;
}
