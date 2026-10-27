import { Check, ChevronRight } from "@renderer/chrome/icons";
import { useEffect, useState, type ComponentProps } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn";

/**
 * The one menu opened from a trigger, in one size (DESIGN.md "Spacing"):
 * rows 28px (more only for a description line) with 12px padding and 8px
 * from the 14px glyph to the label; the highlighted row is a muted fill,
 * never a left colour bar. The context menu (context-menu.tsx) shares the row.
 */
const PANEL = "min-w-44 rounded-xl p-1.5";
const SIZE = {
  row: "min-h-7 gap-2 rounded-lg px-3 py-1 text-[13px]",
  check: "min-h-7 gap-2 rounded-lg py-1 ps-3 pe-8 text-[13px]",
  mark: "end-3",
  inset: "data-inset:ps-8.5",
  icon: "[&_svg:not([class*='size-'])]:size-3.5",
  label: "px-3 py-1 text-[11px]",
  separator: "-mx-1.5 my-1.5",
  shortcut: "text-xs",
} as const;

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
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner className="isolate z-(--layer-popover) outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "max-h-(--available-height) origin-(--transform-origin) overflow-x-hidden overflow-y-auto bg-popover text-popover-foreground shadow-overlay ring-1 ring-border outline-none duration-(--dur-base) ease-(--ease-out) data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-98 data-closed:duration-(--dur-fast) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:data-open:zoom-in-100 motion-reduce:data-closed:zoom-out-100",
            PANEL,
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({ className, inset, ...props }: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" data-inset={inset} className={cn("font-medium text-muted-foreground", SIZE.label, SIZE.inset, className)} {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        ROW,
        SIZE.row,
        SIZE.inset,
        SIZE.icon,
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
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(ROW, SIZE.row, SIZE.inset, SIZE.icon, "data-popup-open:bg-muted", className)}
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
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(ROW, SIZE.check, SIZE.inset, SIZE.icon, "relative data-disabled:pointer-events-none data-disabled:opacity-50", className)}
      checked={checked}
      {...props}
    >
      <span className={cn("pointer-events-none absolute", SIZE.mark)}>
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
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(ROW, SIZE.check, SIZE.inset, SIZE.icon, "relative data-disabled:pointer-events-none data-disabled:opacity-50", className)}
      {...props}
    >
      <span className={cn("pointer-events-none absolute", SIZE.mark)}>
        <MenuPrimitive.RadioItemIndicator>
          <Check />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("h-px bg-border", SIZE.separator, className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="dropdown-menu-shortcut" className={cn("ms-auto ps-4 tracking-wide text-muted-foreground", SIZE.shortcut, className)} {...props} />;
}

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
