import type { PointerEvent as ReactPointerEvent } from "react";
import { lazy, memo, Suspense } from "react";
import { SurfaceTabs } from "../chrome/SurfaceTabs";
import {
  isReleaseNotesTab,
  isTerminalTab,
  type EditorPane,
} from "../lib/layout";
import type { TerminalMetaPatch } from "../lib/terminalTab";
import type { EditorNavigationTarget, OpenFileFn } from "../lib/search";
import { editorPathsEqual } from "../lib/search";
import { FileEditor } from "./FileEditor";
import { ReleaseNotesSurface } from "./ReleaseNotesSurface";
import { TerminalView } from "./TerminalView";
import { MatrixSpinner } from "./threads/bits";

// Monaco, shiki, and the LSP client live behind this boundary; the first
// Monaco tab pulls the chunk in, never app start.
const MonacoPane = lazy(() => import("./monaco/MonacoPane"));

function ChunkSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <MatrixSpinner />
    </div>
  );
}

type Props = {
  pane: EditorPane;
  focused: boolean;
  dirtyFileIds: Set<string>;
  fileErrorCounts: Map<string, number>;
  onFocus: (paneId: string) => void;
  onSelectFile: (paneId: string, fileId: string) => void;
  onCloseFile: (paneId: string, fileId: string) => void;
  onDirtyChange: (fileId: string, dirty: boolean) => void;
  onErrorCountChange: (fileId: string, count: number) => void;
  onReorderFiles: (paneId: string, ids: string[]) => void;
  onOpenFile: OpenFileFn;
  editorNavigation?: EditorNavigationTarget | null;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onTerminalMetaChange?: (fileId: string, patch: TerminalMetaPatch) => void;
};

function FilePaneComponent({
  pane,
  focused,
  dirtyFileIds,
  fileErrorCounts,
  onFocus,
  onSelectFile,
  onCloseFile,
  onDirtyChange,
  onErrorCountChange,
  onReorderFiles,
  onOpenFile,
  editorNavigation,
  onPaneDragStart,
  onTerminalMetaChange,
}: Props) {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onMouseDown={() => onFocus(pane.id)}
    >
      <SurfaceTabs
        files={pane.files}
        activeFileId={pane.activeFileId}
        dirtyFileIds={dirtyFileIds}
        fileErrorCounts={fileErrorCounts}
        onSelectFile={(fileId) => onSelectFile(pane.id, fileId)}
        onCloseFile={(fileId) => onCloseFile(pane.id, fileId)}
        onReorder={(ids) => onReorderFiles(pane.id, ids)}
        onPaneDragStart={onPaneDragStart}
      />
      <div className="relative min-h-0 flex-1">
        {pane.files.map((file) => (
          <div
            key={file.id}
            aria-hidden={file.id !== pane.activeFileId}
            className={
              file.id === pane.activeFileId
                ? "absolute inset-0 h-full"
                : "hidden"
            }
          >
            {isReleaseNotesTab(file) ? (
              <ReleaseNotesSurface source={file.releaseNotes} />
            ) : isTerminalTab(file) ? (
              <TerminalView
                id={file.id}
                cwd={file.cwd}
                active={focused && file.id === pane.activeFileId}
                onMetaChange={(patch) => onTerminalMetaChange?.(file.id, patch)}
              />
            ) : file.editor === "monaco" ? (
              <Suspense fallback={<ChunkSpinner />}>
                <MonacoPane
                  path={file.path}
                  cwd={file.cwd}
                  showDiff={!!file.review}
                  diffBase={file.diffBase}
                  active={focused && file.id === pane.activeFileId}
                  navigation={
                    editorNavigation &&
                    editorPathsEqual(file.path, editorNavigation.path)
                      ? editorNavigation
                      : null
                  }
                  onDirtyChange={(_path, dirty) => onDirtyChange(file.id, dirty)}
                  onErrorCountChange={(_path, count) =>
                    onErrorCountChange(file.id, count)
                  }
                  onOpenFile={onOpenFile}
                />
              </Suspense>
            ) : (
              <FileEditor
                path={file.path}
                cwd={file.cwd}
                showDiff={!!file.review}
                active={focused && file.id === pane.activeFileId}
                navigation={
                  editorNavigation &&
                  editorPathsEqual(file.path, editorNavigation.path)
                    ? editorNavigation
                    : null
                }
                onDirtyChange={(_path, dirty) => onDirtyChange(file.id, dirty)}
                onErrorCountChange={(_path, count) =>
                  onErrorCountChange(file.id, count)
                }
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export const FilePane = memo(FilePaneComponent, (previous, next) => {
  if (
    previous.pane !== next.pane ||
    previous.focused !== next.focused ||
    previous.dirtyFileIds !== next.dirtyFileIds ||
    previous.fileErrorCounts !== next.fileErrorCounts ||
    previous.onFocus !== next.onFocus ||
    previous.onSelectFile !== next.onSelectFile ||
    previous.onCloseFile !== next.onCloseFile ||
    previous.onDirtyChange !== next.onDirtyChange ||
    previous.onErrorCountChange !== next.onErrorCountChange ||
    previous.onReorderFiles !== next.onReorderFiles ||
    previous.onOpenFile !== next.onOpenFile ||
    previous.editorNavigation !== next.editorNavigation ||
    Boolean(previous.onPaneDragStart) !== Boolean(next.onPaneDragStart) ||
    previous.onTerminalMetaChange !== next.onTerminalMetaChange
  ) {
    return false;
  }

  return true;
});

