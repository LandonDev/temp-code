import type { MouseEvent, ReactNode } from "react";
import type { MarkdownViewMode } from "../chrome/MarkdownModeToggle";
import { ChevronDown, ChevronUp } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";

export type SaveState =
  | { status: "idle" | "saving" | "saved" }
  | { status: "error"; message: string };

export type FileHeaderDiff = {
  additions: number;
  deletions: number;
  index: number;
  total: number;
  onPrev(): void;
  onNext(): void;
};

type FileHeaderProps = {
  /** The file's folder as displayPath shows it; null at the project root. */
  folder: string | null;
  diff?: FileHeaderDiff;
  markdown?: { mode: MarkdownViewMode; onModeChange(mode: MarkdownViewMode): void };
  save: SaveState;
};

/** The buttons keep the editor's focus: a click never takes the caret. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The one row above a file tab's body. The tab already names the file, so
 * the row holds what the tab cannot: the folder, the diff's counts and its
 * stepper, the Markdown view, and a save that is still running or failed
 * (a finished save is the tab's dirty mark clearing).
 */
export function FileHeader({ folder, diff, markdown, save }: FileHeaderProps) {
  return (
    <TooltipProvider>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-background px-3 text-[12px]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {folder ? (
            <span className="min-w-0 truncate text-left font-mono text-muted-foreground [direction:rtl]">
              <span dir="ltr">{folder}</span>
            </span>
          ) : null}
          {diff && (diff.additions > 0 || diff.deletions > 0) ? (
            <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
              {diff.additions > 0 ? <span className="text-success">+{diff.additions}</span> : null}
              {diff.deletions > 0 ? <span className="text-destructive">−{diff.deletions}</span> : null}
            </span>
          ) : null}
        </div>
        <SaveWord save={save} />
        {markdown ? (
          <ToggleGroup
            size="sm"
            spacing={0}
            aria-label="Markdown view"
            value={[markdown.mode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "preview" || next === "source") markdown.onModeChange(next);
            }}
          >
            <ToggleGroupItem value="preview" className="text-[12px]">Preview</ToggleGroupItem>
            <ToggleGroupItem value="source" className="text-[12px]">Source</ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {diff ? <Stepper diff={diff} /> : null}
      </header>
    </TooltipProvider>
  );
}

function SaveWord({ save }: { save: SaveState }) {
  if (save.status === "saving") return <span className="shrink-0 text-muted-foreground">Saving…</span>;
  if (save.status !== "error") return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="min-w-0 max-w-64 truncate text-destructive outline-none focus-visible:underline" />}>
        Save failed: {save.message}
      </TooltipTrigger>
      <TooltipContent>{save.message}</TooltipContent>
    </Tooltip>
  );
}

function Stepper({ diff }: { diff: FileHeaderDiff }) {
  const { index, total } = diff;
  return (
    <div role="toolbar" aria-label="Jump between changes" className="-me-1.5 flex shrink-0 items-center">
      <StepButton label="Previous change" disabled={total === 0 || index <= 0} onClick={diff.onPrev}>
        <ChevronUp />
      </StepButton>
      <span className="min-w-[4ch] select-none px-0.5 text-center font-mono tabular-nums text-muted-foreground">
        {total === 0 ? "0/0" : `${index + 1}/${total}`}
      </span>
      <StepButton label="Next change" disabled={total === 0 || index >= total - 1} onClick={diff.onNext}>
        <ChevronDown />
      </StepButton>
    </div>
  );
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onMouseDown={keepFocus} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
