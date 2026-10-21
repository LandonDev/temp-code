import type { HarnessId } from "../lib/session";
import { GitChangesPanel } from "./GitChangesPanel";
import type { OpenFileFn } from "../lib/search";

type Props = {
  cwd: string;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  onOpenFile: OpenFileFn;
};

export function SourceControl({
  cwd,
  enabled,
  textHarness,
  selectedPath,
  onOpenFile,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <GitChangesPanel
        cwd={cwd}
        enabled={enabled}
        textHarness={textHarness}
        selectedPath={selectedPath}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}
