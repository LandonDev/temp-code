import type { MouseEvent, ReactNode } from "react";
import type { MarkdownViewMode } from "../chrome/MarkdownModeToggle";
import { ChevronDown, ChevronUp, Plus, Undo2 } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { displayPath } from "../lib/paths";

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
  /** Revert the change the caret is in. */
  onRevert?(): void;
  /** Stage the change the caret is in; absent when the review is not against HEAD. */
  onStage?(): void;
  /** The change at the caret has nothing left to stage. */
  staged?: boolean;
  /** A revert or stage is running. */
  busy?: boolean;
};

type FileHeaderProps = {
  /** The file's folder as displayPath shows it; null at the project root. */
  folder: string | null;
  diff?: FileHeaderDiff;
  markdown?: { mode: MarkdownViewMode; onModeChange(mode: MarkdownViewMode): void };
  /** Absent for a tab that never saves (a media file): idle. */
  save?: SaveState;
  /** Trailing controls and facts of the tab's own kind, before the stepper. */
  children?: ReactNode;
};

/** The folder the header shows: displayPath cut at its last slash; null at the project root. */
export function fileFolder(path: string, cwd: string): string | null {
  const shown = displayPath(path, cwd);
  const slash = shown.lastIndexOf("/");
  return slash > 0 ? shown.slice(0, slash) : null;
}

const IDLE: SaveState = { status: "idle" };

/** The buttons keep the editor's focus: a click never takes the caret. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The one row above a file tab's body. The tab already names the file, so
 * the row holds what the tab cannot: the folder, the diff's counts, Revert
 * and Stage for the change the caret is in and the stepper, the Markdown
 * view, and a save that is still running or failed (a finished save is the
 * tab's dirty mark clearing).
 */
export function FileHeader({ folder, diff, markdown, save = IDLE, children }: FileHeaderProps) {
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
        {children}
        {diff?.onRevert || diff?.onStage ? <ChangeActions diff={diff} /> : null}
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

function ChangeActions({ diff }: { diff: FileHeaderDiff }) {
  // Act on the change the caret is in: none above the first change.
  const none = diff.index < 0 || diff.total === 0;
  const busy = !!diff.busy;
  return (
    <div role="toolbar" aria-label="Change actions" aria-busy={busy || undefined} className="flex shrink-0 items-center">
      {diff.onRevert ? (
        <StepButton label="Revert change" disabled={none || busy} onClick={diff.onRevert}>
          <Undo2 />
        </StepButton>
      ) : null}
      {diff.onStage ? (
        <StepButton label="Stage change" disabled={none || busy || !!diff.staged} onClick={diff.onStage}>
          {busy ? <Spinner /> : <Plus />}
        </StepButton>
      ) : null}
    </div>
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
