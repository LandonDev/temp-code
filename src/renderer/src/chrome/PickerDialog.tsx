import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { GroupInput, InputGroup } from "../components/ui/input";
import { MENU_ROW } from "../components/ui/menu-row";
import { Separator } from "../components/ui/separator";
import { cn } from "../lib/cn";
import { Search } from "./icons";

/**
 * The frame of a go-to picker (Go to File, Go to Symbol): a Dialog near the
 * top of the window with the search field on top and the list under it.
 * Escape and a press outside close it.
 */
export function PickerDialog({
  open = true,
  label,
  search,
  query,
  onQuery,
  onSearchKey,
  onClose,
  children,
  ...data
}: {
  open?: boolean;
  label: string;
  search: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onClose: () => void;
  children: ReactNode;
} & Record<`data-${string}`, boolean>) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        instant
        initialFocus={search}
        className="top-[12%] translate-y-0 starting:translate-y-0 gap-0 p-1 sm:max-w-[560px]"
        {...data}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <InputGroup leading={<Search className="size-3.5" />} className="h-9 border-transparent">
          <GroupInput
            ref={search}
            value={query}
            placeholder={label}
            aria-label={label}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </InputGroup>
        {/* Across the frame's 4px inset to both edges: a full-width
            separator shifted by -mx-1 stopped 8px short of the right. */}
        <Separator data-picker-rule className="-mx-1 mb-1 data-[orientation=horizontal]:w-auto" />
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** A picker's empty or waiting line: one muted row in a row's box, never
 *  an empty state (docs/DESIGN.md "Loading and empty states"). */
export function PickerNote({ children }: { children: ReactNode }) {
  return <p data-picker-note className="flex h-7 items-center px-3 text-[13px] text-muted-foreground">{children}</p>;
}

/** One row of a picker list, in a menu row's box (`MENU_ROW`: 28px, 12px
 *  in, 8px from glyph to label) with the frame's radius less its 4px inset
 *  (16 − 4 = 12px); the highlighted row is a muted fill. */
export function pickerRowClass(highlighted: boolean): string {
  return cn(
    "flex w-full cursor-default items-center rounded-xl text-left",
    MENU_ROW,
    highlighted && "bg-muted",
  );
}
