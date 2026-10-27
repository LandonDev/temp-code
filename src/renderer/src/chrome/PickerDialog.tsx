import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { GroupInput, InputGroup } from "../components/ui/input";
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
        initialFocus={search}
        className="top-[12%] translate-y-0 gap-0 p-1 sm:max-w-[560px]"
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
        <Separator className="-mx-1 mb-1" />
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** A picker's empty or waiting line. */
export function PickerNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-2 text-xs text-muted-foreground">{children}</p>;
}

/** One 28px row of a picker list; the highlighted row is a muted fill. */
export function pickerRowClass(highlighted: boolean): string {
  return cn(
    "flex h-7 w-full cursor-default items-center gap-3 rounded-md px-2 text-left text-[13px] leading-none",
    highlighted && "bg-muted",
  );
}
