import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { createContext, useContext, useEffect, useState, type ComponentType, type ReactElement, type ReactNode, type Ref } from "react";
import { openMenus, useMenuBody, warmMenus } from "@renderer/chrome/menuRows";
import { menuChunk } from "@renderer/surfaces/chunks";
import { cn } from "@renderer/lib/cn";
import type * as Dropdown from "./dropdown-menu";
import type * as Popover from "./popover";

/**
 * The dropdown menu and the popover by their parts, for the surfaces the
 * first paint draws (the composer's add menu and pickers, the rail's hosts
 * and meters, the strip's chooser). Base UI's menu, popover and their
 * floating stack ride `menuChunk` (chrome/menuBody.tsx), as `RowsMenu` and
 * `LazyPopover` do; until it lands a menu is its trigger alone, drawn as the
 * same element, and its content is nothing. The pointer entering a trigger
 * loads the body and swaps every menu on screen (chrome/menuRows.tsx
 * `warmMenus`: never while a field is typed in or a pointer is pressed); a
 * click on a cold trigger loads it, swaps, then opens. A menu given `open`
 * loads it at once.
 *
 * Use every part of one menu from here: a cold root has no Base UI context,
 * so a primitive part inside it would throw. Surfaces in a lazy chunk import
 * components/ui/dropdown-menu.tsx and popover.tsx directly.
 */

type Opener = { open: () => void; haspopup: "menu" | "dialog" };
/** Set by a cold root: what a click on its trigger does. */
const ColdRoot = createContext<Opener | null>(null);

type RootProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details?: never) => void;
  children?: ReactNode;
};

function useColdRoot(props: RootProps, haspopup: Opener["haspopup"]) {
  const B = useMenuBody();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!B && props.open) openMenus();
  }, [B, props.open]);
  const opener: Opener = {
    haspopup,
    open: () => {
      setPending(true);
      // Published first: an `open && <Content />` the caller draws on this
      // change mounts under the real root, never under the cold one.
      openMenus(() => props.onOpenChange?.(true));
    },
  };
  const onOpenChange = (open: boolean, details?: never) => {
    if (!open) setPending(false);
    props.onOpenChange?.(open, details);
  };
  return { B, opener, onOpenChange, defaultOpen: props.defaultOpen ?? (props.open === undefined ? pending : undefined) };
}

/** Base UI trigger props that are not the element's. */
type TriggerOnly = { openOnHover?: unknown; delay?: unknown; closeDelay?: unknown; nativeButton?: unknown; handle?: unknown; payload?: unknown };
type ColdTriggerProps = TriggerOnly & {
  render?: ReactElement | ((props: Record<string, unknown>, state: { open: boolean }) => ReactElement);
  className?: string;
  ref?: Ref<HTMLElement>;
  [key: string]: unknown;
};

/** The trigger before the body lands: the element the real trigger renders,
 *  closed, warming the body on the pointer and opening it on a click. */
function ColdTrigger({ props, slot }: { props: ColdTriggerProps; slot: string }) {
  const root = useContext(ColdRoot);
  const { render, className, ref, openOnHover: _h, delay: _d, closeDelay: _c, nativeButton: _n, handle: _x, payload: _p, ...rest } = props;
  return useRender({
    defaultTagName: "button",
    render: render as never,
    ref: ref as never,
    state: { open: false },
    props: mergeProps<"button">(
      {
        type: "button",
        ...{ "data-slot": slot },
        "aria-haspopup": root?.haspopup,
        "aria-expanded": false,
        onPointerEnter: warmMenus,
        onFocus: () => menuChunk.preload(),
        onClick: () => root?.open(),
      },
      (className === undefined ? rest : { ...rest, className }) as never,
    ),
  });
}

/** A part that only shows inside an open menu: the primitive once the body
 *  has landed, nothing before. */
function part<P>(pick: (B: NonNullable<ReturnType<typeof useMenuBody>>) => ComponentType<P>): ComponentType<P> {
  return function Part(props: P) {
    const B = useMenuBody();
    if (!B) return null;
    const Real = pick(B) as ComponentType<object>;
    return <Real {...(props as object)} />;
  };
}

type DropdownRootProps = Parameters<typeof Dropdown.DropdownMenu>[0];

function DropdownMenu(props: DropdownRootProps) {
  const { B, opener, onOpenChange, defaultOpen } = useColdRoot(props as RootProps, "menu");
  if (B) return <B.DropdownParts.DropdownMenu {...props} defaultOpen={defaultOpen} onOpenChange={onOpenChange as never} />;
  return <ColdRoot.Provider value={opener}>{props.children as ReactNode}</ColdRoot.Provider>;
}

function DropdownMenuTrigger(props: Parameters<typeof Dropdown.DropdownMenuTrigger>[0]) {
  const B = useMenuBody();
  if (B) return <B.DropdownParts.DropdownMenuTrigger {...props} />;
  return <ColdTrigger props={{ ...(props as ColdTriggerProps), className: cn("select-none", props.className as string) }} slot="dropdown-menu-trigger" />;
}

const DropdownMenuContent = part((B) => B.DropdownParts.DropdownMenuContent);
const DropdownMenuGroup = part((B) => B.DropdownParts.DropdownMenuGroup);
const DropdownMenuLabel = part((B) => B.DropdownParts.DropdownMenuLabel);
const DropdownMenuItem = part((B) => B.DropdownParts.DropdownMenuItem);
const DropdownMenuCheckboxItem = part((B) => B.DropdownParts.DropdownMenuCheckboxItem);
const DropdownMenuRadioGroup = part((B) => B.DropdownParts.DropdownMenuRadioGroup);
const DropdownMenuRadioItem = part((B) => B.DropdownParts.DropdownMenuRadioItem);
const DropdownMenuSeparator = part((B) => B.DropdownParts.DropdownMenuSeparator);
const DropdownMenuShortcut = part((B) => B.DropdownParts.DropdownMenuShortcut);
const DropdownMenuSub = part((B) => B.DropdownParts.DropdownMenuSub);
const DropdownMenuSubTrigger = part((B) => B.DropdownParts.DropdownMenuSubTrigger);
const DropdownMenuSubContent = part((B) => B.DropdownParts.DropdownMenuSubContent);

type PopoverRootProps = Parameters<typeof Popover.Popover>[0];

function PopoverRoot(props: PopoverRootProps) {
  const { B, opener, onOpenChange, defaultOpen } = useColdRoot(props as RootProps, "dialog");
  if (B) return <B.PopoverParts.Popover {...props} defaultOpen={defaultOpen} onOpenChange={onOpenChange as never} />;
  return <ColdRoot.Provider value={opener}>{props.children as ReactNode}</ColdRoot.Provider>;
}

function PopoverTrigger(props: Parameters<typeof Popover.PopoverTrigger>[0]) {
  const B = useMenuBody();
  if (B) return <B.PopoverParts.PopoverTrigger {...props} />;
  return <ColdTrigger props={props as ColdTriggerProps} slot="popover-trigger" />;
}

const PopoverContent = part((B) => B.PopoverParts.PopoverContent);

export {
  DropdownMenu,
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
  PopoverRoot as Popover,
  PopoverTrigger,
  PopoverContent,
};
