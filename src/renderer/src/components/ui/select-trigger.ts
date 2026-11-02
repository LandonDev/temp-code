/** The select trigger's box and its chevron, shared by `SelectTrigger`
 *  (select.tsx, in the select chunk) and the still trigger a picker draws
 *  until that chunk lands (components/lazy-select.tsx), so the swap from
 *  one to the other moves nothing. */
export const SELECT_TRIGGER =
  "focus-field flex w-fit select-none items-center justify-between gap-1.5 whitespace-nowrap rounded-lg border border-input bg-transparent py-1.5 ps-2.5 pe-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-md *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 hover:bg-muted/60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export const SELECT_CHEVRON = "pointer-events-none size-4 text-muted-foreground";

/** `SelectValue`'s own classes. */
export const SELECT_VALUE = "flex flex-1 text-start";
