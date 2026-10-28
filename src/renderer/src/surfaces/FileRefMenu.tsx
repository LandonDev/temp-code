import type { ReactNode } from "react";
import { Copy, ExternalLink, FileText, FolderOpen } from "../chrome/icons";
import { RowsContextMenu, type MenuRow } from "../chrome/menuRows";
import { copyText } from "../lib/clipboard";
import { useEditorConfig } from "../lib/editorConfig";
import { fileRefTarget } from "../lib/fileRef";
import { revealPath } from "../lib/fs";
import { editorLabelFor, openInEditor } from "../lib/openInEditor";
import type { OpenFileFn } from "../lib/search";
import { useTranscriptHost } from "./transcriptSession";
import { isWebMode } from "../lib/nativeWeb";

/**
 * Right-click on any file link in the transcript: Open in <editor> (Open
 * on the Mac for a thread on another host), Reveal in Finder, Copy path,
 * Copy file name. Left-click stays with the wrapped child. Relative
 * targets resolve against the transcript's cwd; without one, Reveal hides
 * and Copy path copies the path as written.
 */
export function FileRefMenu({
  target,
  cwd,
  onOpenFile,
  children,
}: {
  /** the path as rendered — may be relative and carry a :line(:col) tail */
  target: string;
  cwd?: string;
  /** Where the host's version lands when the editor cannot take the file. */
  onOpenFile?: OpenFileFn;
  children: ReactNode;
}) {
  const editorConfig = useEditorConfig();
  // The thread's host: a path outside every catalog root is on it (lib/pathHost.ts).
  const threadHost = useTranscriptHost();
  if (!target) return <>{children}</>;
  const ref = fileRefTarget(target, cwd);
  const editorLabel = editorLabelFor(ref.abs, editorConfig, threadHost);
  const items: MenuRow[] = [
    ...(editorLabel ? [{ kind: "item", id: "editor", label: editorLabel, icon: ExternalLink } as const] : []),
    ...(ref.abs && !isWebMode() ? [{ kind: "item", id: "reveal", label: "Reveal in Finder", icon: FolderOpen } as const] : []),
    { kind: "item", id: "path", label: "Copy path", icon: Copy },
    { kind: "item", id: "name", label: "Copy file name", icon: FileText },
  ];
  const pick = (id: string) => {
    if (id === "editor" && ref.abs) {
      const tail = /:(\d+)(?::(\d+))?\s*$/.exec(target);
      void openInEditor(
        {
          path: ref.abs,
          cwd,
          threadHost,
          line: tail ? Number(tail[1]) : undefined,
          column: tail?.[2] ? Number(tail[2]) : undefined,
        },
        onOpenFile ?? (() => {}),
      );
    } else if (id === "reveal" && ref.abs) void revealPath(ref.abs);
    else if (id === "path") void copyText(ref.abs ?? ref.clean);
    else if (id === "name") void copyText(ref.name);
  };
  return (
    <RowsContextMenu label="File link actions" lazyMount rowsFor={() => items} onPick={pick}>
      <span className="contents">{children}</span>
    </RowsContextMenu>
  );
}
