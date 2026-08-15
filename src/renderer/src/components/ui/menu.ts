/**
 * Zeron floating-menu language (popover.rs `frosted_menu` + `menu_row`,
 * values verbatim) — shared by select, dropdown-menu, context-menu and
 * popover so every floating card in the app opens, sits and rows the
 * same way.
 *
 * Card: 12px-radius glass with a 4px inset; light mode is a white card on
 * hairline ring + soft float shadow, dark mode gets the translucent
 * blur recipe from main.css (`[data-slot=…-content]`).
 * Motion: MENU_IN 140ms fade + 2px drop toward the trigger, MENU_OUT
 * 100ms reverse (radix keeps the node mounted while it plays). Menus
 * opening upward rise instead of drop.
 * Row: `gap-2.5 rounded-lg px-2 py-1.5 text-[13px]`, highlight = accent
 * wash, disabled fades.
 */

export const MENU_CARD =
  'z-50 rounded-xl bg-popover p-1 text-popover-foreground shadow-[0_8px_32px_rgb(0_0_0/0.12)] ring-1 ring-foreground/10'

export const MENU_MOTION =
  'data-[state=open]:animate-[z-menu-in_140ms_cubic-bezier(0.16,1,0.3,1)] data-[state=closed]:animate-[z-menu-out_100ms_ease] data-[side=top]:data-[state=open]:animate-[z-menu-in-up_140ms_cubic-bezier(0.16,1,0.3,1)] data-[side=top]:data-[state=closed]:animate-[z-menu-out-up_100ms_ease]'

export const MENU_ROW =
  "relative flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-foreground/90 outline-hidden select-none focus:bg-accent focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/** Small uppercase section heading inside a floating menu (Zeron MenuHeading). */
export const MENU_HEADING =
  'px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/60'

/** Hairline divider, full-bleed across the card's 4px inset. */
export const MENU_SEPARATOR = '-mx-1 my-1 h-px bg-hairline'

/**
 * Ghost-pill trigger (Zeron composer `pill`): no border, no box — a quiet
 * label that washes on hover and stays washed while its menu is open.
 */
export const GHOST_TRIGGER =
  'flex items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none select-none transition-colors duration-150 hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50'
