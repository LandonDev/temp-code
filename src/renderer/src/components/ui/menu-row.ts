/** Every menu row's box (DESIGN.md "Spacing"): 28px tall, 12px either side,
 *  8px between glyph and label; a row with a description grows. The
 *  dropdown menu (which exports it), the context menu and the select's items
 *  use it; a check row's end padding and an inset row's start padding refine
 *  it. Its own module, so the select does not import the menu primitive. */
export const MENU_ROW = "min-h-7 gap-2 px-3 py-1 text-[13px]";
