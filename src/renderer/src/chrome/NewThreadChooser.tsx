import { registry } from "../lib/connection";
import { useWorkspaces } from "../lib/tcserver/workspaces";
import { useEffect, useRef, useState } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import { ChevronLeft, Plus, SlidersHorizontal } from "./icons";
import { Button } from "../components/ui/button";
import { ItemButton, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { ThreadTune, normalizeTune } from "./ThreadTune";
import { THREAD_GLYPHS, THREAD_HINTS, THREAD_LABELS, THREAD_START_LABELS, THREAD_TYPES } from "../surfaces/threads/threadTypes";

const TUNABLE: ReadonlySet<ThreadType> = new Set(["orchestration", "research"]);

/**
 * The strip's Plus: a popover naming every thread type, and for the two
 * types that take per-run rules a tune view that swaps in with Back.
 */
export function NewThreadChooser({
  workspaceId,
  empty,
  onStart,
}: {
  workspaceId: string | null;
  /** No chips yet: the button says so in words. */
  empty: boolean;
  onStart: (threadType: ThreadType, tune: ThreadRules | null) => void;
}) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  // A new loose thread without a workspace belongs to this machine.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  const [open, setOpen] = useState(false);
  const [tuning, setTuning] = useState<ThreadType | null>(null);
  const [tune, setTune] = useState<ThreadRules>({});
  // The type whose options were last open: Back returns the focus to its button.
  const [returnTo, setReturnTo] = useState<ThreadType | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (tuning) back.current?.focus();
    else if (returnTo) popup.current?.querySelector<HTMLElement>(`[data-tune-type="${returnTo}"]`)?.focus();
  }, [open, tuning, returnTo]);

  const start = (type: ThreadType, rules: ThreadRules | null = null) => {
    setOpen(false);
    onStart(type, rules);
  };
  const openTune = (type: ThreadType) => {
    setReturnTo(type);
    setTuning(type);
  };

  if (!environmentId) return null;

  const button = (
    <Button
      variant="ghost"
      size={empty ? "sm" : "icon-sm"}
      aria-label={empty ? undefined : "New thread"}
      data-tauri-drag-region="false"
      className="text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
    />
  );
  const face = (
    <>
      <Plus strokeWidth={1.5} />
      {empty ? "New thread" : null}
    </>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        // Reset only once the exit has played, so the popover leaves as it was.
        if (isOpen) return;
        setTuning(null);
        setTune({});
        setReturnTo(null);
      }}
    >
      {empty ? (
        <PopoverTrigger render={button}>{face}</PopoverTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<PopoverTrigger render={button} />}>{face}</TooltipTrigger>
          <TooltipContent side="bottom">New thread</TooltipContent>
        </Tooltip>
      )}
      <PopoverContent ref={popup} align="start" className={cn("gap-0 p-1", tuning ? "w-90" : "w-68")}>
        {tuning ? (
          <>
            <div className="flex items-center gap-1 px-1 pt-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      ref={back}
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Back"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setTuning(null)}
                    />
                  }
                >
                  <ChevronLeft strokeWidth={1.5} />
                </TooltipTrigger>
                <TooltipContent>Back</TooltipContent>
              </Tooltip>
              <span className="text-[13px] font-medium text-foreground">{THREAD_LABELS[tuning]} options</span>
            </div>
            <ThreadTune environmentId={environmentId} tune={tune} onChange={setTune} workspaceId={workspaceId} />
            <div className="flex justify-end px-4 pb-3">
              <Button size="sm" onClick={() => start(tuning, normalizeTune(tune))}>
                Start {THREAD_LABELS[tuning].toLowerCase()}
              </Button>
            </div>
          </>
        ) : (
          THREAD_TYPES.map((type) => {
            const Glyph = THREAD_GLYPHS[type];
            const tunable = TUNABLE.has(type);
            return (
              <div key={type} className="group/row flex items-center rounded-lg hover:bg-muted">
                <ItemButton
                  size="xs"
                  className="min-w-0 flex-1 text-start"
                  onClick={() => start(type)}
                >
                  <ItemMedia>
                    <Glyph className="size-3.5" strokeWidth={1.5} />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{THREAD_START_LABELS[type] ?? THREAD_LABELS[type]}</ItemTitle>
                    <ItemDescription className="mt-0.5">{THREAD_HINTS[type]}</ItemDescription>
                  </ItemContent>
                </ItemButton>
                {tunable ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${THREAD_LABELS[type]} options`}
                          data-tune-type={type}
                          className="me-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
                          onClick={() => openTune(type)}
                        />
                      }
                    >
                      <SlidersHorizontal strokeWidth={1.5} />
                    </TooltipTrigger>
                    <TooltipContent>{THREAD_LABELS[type]} options</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}
