import { Check, ChevronRight } from "@renderer/chrome/icons";
import { createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn";

/**
 * The one menu opened from a trigger. Rows are 28px (`default`) or 24px
 * (`sm`); the highlighted row is a muted fill, never a left colour bar.
 */
type DropdownMenuSize = "sm" | "default";

const SIZES = {
  sm: {
    panel: "min-w-36 rounded-lg p-1",
    row: "gap-1.5 rounded-md px-1.5 py-1 text-[13px]",
    check: "gap-1.5 rounded-md py-1 ps-1.5 pe-7 text-[13px]",
    mark: "end-1.5",
    inset: "data-inset:ps-6",
    icon: "[&_svg:not([class*='size-'])]:size-3.5",
    label: "px-1.5 py-1 text-[11px]",
    separator: "-mx-1 my-1",
    shortcut: "text-[11px]",
  },
  default: {
    panel: "min-w-44 rounded-xl p-1.5",
    row: "gap-2 rounded-lg px-2 py-1.5 text-[13px]",
    check: "gap-2 rounded-lg py-1.5 ps-2 pe-8 text-[13px]",
    mark: "end-2",
    inset: "data-inset:ps-8",
    icon: "[&_svg:not([class*='size-'])]:size-4",
    label: "px-2 py-1 text-[11px]",
    separator: "-mx-1.5 my-1.5",
    shortcut: "text-xs",
  },
} as const;

const SizeContext = createContext<DropdownMenuSize>("default");

function useSize() {
  return SIZES[useContext(SizeContext)];
}

const ROW =
  "flex cursor-default select-none items-center outline-hidden focus:bg-muted focus:text-foreground data-highlighted:bg-muted [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ className, onPointerDown, ...props }: MenuPrimitive.Trigger.Props) {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (!pressed) return;
    const release = () => setPressed(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [pressed]);
  return (
    <MenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      data-pressed={pressed || undefined}
      className={cn("select-none", className)}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.button === 0) setPressed(true);
      }}
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  size,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & { size?: DropdownMenuSize }) {
  const inherited = useContext(SizeContext);
  const resolved = size ?? inherited;
  return (
    <SizeContext.Provider value={resolved}>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner className="isolate z-(--layer-popover) outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
          <MenuPrimitive.Popup
            data-slot="dropdown-menu-content"
            data-size={resolved}
            className={cn(
              "max-h-(--available-height) origin-(--transform-origin) overflow-x-hidden overflow-y-auto bg-popover text-popover-foreground shadow-overlay ring-1 ring-border outline-none duration-(--dur-base) ease-(--ease-out) data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-98 data-closed:duration-(--dur-fast) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:data-open:zoom-in-100 motion-reduce:data-closed:zoom-out-100",
              SIZES[resolved].panel,
              className,
            )}
            {...props}
          />
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </SizeContext.Provider>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({ className, inset, ...props }: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  const size = useSize();
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" data-inset={inset} className={cn("font-medium text-muted-foreground", size.label, size.inset, className)} {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }) {
  const size = useSize();
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        ROW,
        size.row,
        size.inset,
        size.icon,
        "group/dropdown-menu-item relative data-disabled:pointer-events-none data-disabled:opacity-50 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({ className, inset, children, ...props }: MenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  const size = useSize();
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(ROW, size.row, size.inset, size.icon, "data-popup-open:bg-muted", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ms-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({ className, align = "start", alignOffset = -5, side = "right", sideOffset = 1, ...props }: ComponentProps<typeof DropdownMenuContent>) {
  return <DropdownMenuContent data-slot="dropdown-menu-sub-content" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} className={cn("w-auto min-w-40", className)} {...props} />;
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & { inset?: boolean }) {
  const size = useSize();
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(ROW, size.check, size.inset, size.icon, "relative data-disabled:pointer-events-none data-disabled:opacity-50", className)}
      checked={checked}
      {...props}
    >
      <span className={cn("pointer-events-none absolute", size.mark)}>
        <MenuPrimitive.CheckboxItemIndicator>
          <Check />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({ className, children, inset, ...props }: MenuPrimitive.RadioItem.Props & { inset?: boolean }) {
  const size = useSize();
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(ROW, size.check, size.inset, size.icon, "relative data-disabled:pointer-events-none data-disabled:opacity-50", className)}
      {...props}
    >
      <span className={cn("pointer-events-none absolute", size.mark)}>
        <MenuPrimitive.RadioItemIndicator>
          <Check />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  const size = useSize();
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("h-px bg-border", size.separator, className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  const size = useSize();
  return <span data-slot="dropdown-menu-shortcut" className={cn("ms-auto ps-4 tracking-wide text-muted-foreground", size.shortcut, className)} {...props} />;
}

export type { DropdownMenuSize };
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
