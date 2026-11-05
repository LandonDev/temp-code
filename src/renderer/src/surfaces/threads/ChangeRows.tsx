import { FilePreview } from "../../chrome/FilePreview";
import { ChevronRight } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Counts } from "../../chrome/rail/changeRows";
import { Spinner } from "../../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import type { OpenFileFn } from "../../lib/search";
import { diskBlock, wholeChange } from "../../lib/threads/rounds";
import type { ChangeGroup, ChangeRow } from "./implementationBoard";
import { cn } from "../../lib/cn";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";

/** The files each task changed, grouped under the task's name; a row
 *  opens its diff in place, with the door to the full diff under it. */
export function ChangeRows({
  groups,
  cwd,
  onOpenFile,
  onOpenDiff,
}: {
  groups: ChangeGroup[];
  cwd: string;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.task ?? "Changes"}>
          {g.task ? <h4 className="mb-1 truncate text-xs text-muted-foreground">{g.task}</h4> : null}
          <div className="-mx-2 flex flex-col gap-0.5">
            {g.files.map((f) => (
              <ChangeFile key={f.path} file={f} cwd={cwd} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChangeFile({
  file,
  cwd,
  onOpenFile,
  onOpenDiff,
}: {
  file: ChangeRow;
  cwd: string;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
}) {
  const block = file.disk ? diskBlock(file.disk) : file.edits.length ? wholeChange(file.path, file.edits) : null;
  const preview = block?.tool?.preview;
  return (
    <Collapsible data-change-row={file.path}>
      <CollapsibleTrigger render={<ItemButton size="xs" className={cn("group/change h-7 py-0", ROW_PRESS)} />}>
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate text-[13px] text-foreground" />}>
            {file.name}
          </TooltipTrigger>
          <TooltipContent>{file.path}</TooltipContent>
        </Tooltip>
        {file.disk ? <span className="text-xs text-muted-foreground">shell</span> : null}
        {file.editing ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        {/* The tally on the board's recipe (Counts: 4px between values), the chevron 8px after it. */}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
          <Counts additions={file.adds} deletions={file.dels} />
          <ChevronRight className={cn("size-3.5 text-muted-foreground group-data-[panel-open]/change:rotate-90", DISCLOSURE_CHEVRON)} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col items-start gap-1 px-2 pt-1 pb-2">
          {preview ? (
            <div className="w-full">
              <FilePreview preview={preview} status="accepted" cwd={cwd} onOpenFile={onOpenFile} />
            </div>
          ) : null}
          <Button variant="link" size="xs" className="px-0" onClick={() => onOpenDiff(file.path)}>
            Open diff
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
