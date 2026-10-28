import { Check, ChevronRight } from "@renderer/chrome/icons";
import type { ComponentProps } from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@renderer/lib/cn";
import { KbdGroup } from "./kbd";
import { MENU_ROW } from "./menu-row";

/** The right-click menu: the dropdown's one row (28px, 12px padding, 8px
 *  glyph gap), opened at the pointer with a plain fade (nothing to scale
 *  from). A disabled row's reason is its tooltip; only a row with a
 *  description line (a folder's path) grows past 28px. */
const ROW = `${MENU_ROW} flex cursor-default select-none items-center rounded-lg outline-hidden focus:bg-muted data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:ps-8.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5`;

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" className={cn("select-none", className)} {...props} />;
}

function ContextMenuContent({
  className,
  align = "start",
  alignOffset = 4,
  side = "right",
  sideOffset = 0,
  ...props
}: ContextMenuPrimitive.Popup.Props & Pick<ContextMenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-(--layer-popover) outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "max-h-(--available-height) min-w-44 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-1.5 text-popover-foreground shadow-overlay ring-1 ring-border outline-none duration-(--dur-fast) ease-(--ease-out) data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 motion-reduce:duration-0",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuLabel({ className, inset, ...props }: ContextMenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return <ContextMenuPrimitive.GroupLabel data-slot="context-menu-label" data-inset={inset} className={cn("px-3 py-1 text-[11px] font-medium text-muted-foreground data-inset:ps-8.5", className)} {...props} />;
}

function ContextMenuItem({ className, inset, variant = "default", ...props }: ContextMenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(ROW, "group/context-menu-item relative data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:*:[svg]:text-destructive", className)}
      {...props}
    />
  );
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;
}

function ContextMenuSubTrigger({ className, inset, children, ...props }: ContextMenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger data-slot="context-menu-sub-trigger" data-inset={inset} className={cn(ROW, "data-popup-open:bg-muted", className)} {...props}>
      {children}
      <ChevronRight className="ms-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

function ContextMenuSubContent({ ...props }: ComponentProps<typeof ContextMenuContent>) {
  return <ContextMenuContent data-slot="context-menu-sub-content" {...props} />;
}

function ContextMenuCheckboxItem({ className, children, checked, inset, ...props }: ContextMenuPrimitive.CheckboxItem.Props & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.CheckboxItem data-slot="context-menu-checkbox-item" data-inset={inset} className={cn(ROW, "relative pe-8", className)} checked={checked} {...props}>
      <span className="pointer-events-none absolute end-3">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <Check />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuRadioGroup({ ...props }: ContextMenuPrimitive.RadioGroup.Props) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

function ContextMenuRadioItem({ className, children, inset, ...props }: ContextMenuPrimitive.RadioItem.Props & { inset?: boolean }) {
  return (
    <ContextMenuPrimitive.RadioItem data-slot="context-menu-radio-item" data-inset={inset} className={cn(ROW, "relative pe-8", className)} {...props}>
      <span className="pointer-events-none absolute end-3">
        <ContextMenuPrimitive.RadioItemIndicator>
          <Check />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn("-mx-1.5 my-1.5 h-px bg-border", className)} {...props} />;
}

function ContextMenuShortcut({ className, ...props }: ComponentProps<typeof KbdGroup>) {
  return <KbdGroup data-slot="context-menu-shortcut" className={cn("ms-auto gap-0.5 ps-4", className)} {...props} />;
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};
