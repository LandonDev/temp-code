import { useState, type MouseEvent, type ReactNode } from "react";
import { ExplorerMenu, type ExplorerMenuItem } from "../chrome/ExplorerMenu";
import { copyText } from "../lib/clipboard";
import { useEditorConfig } from "../lib/editorConfig";
import { fileRefTarget } from "../lib/fileRef";
import { revealPath } from "../lib/fs";
import { editorLabelFor, openInEditor } from "../lib/openInEditor";
import type { OpenFileFn } from "../lib/search";

/**
 * Right-click on any file link in the transcript: Open in <editor> (Open
 * on the Mac for a thread on another host), Reveal in Finder, Copy Path,
 * Copy File Name. Left-click stays with the wrapped child. Relative
 * targets resolve against the transcript's cwd; without one, Reveal hides
 * and Copy Path copies the path as written.
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
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const editorConfig = useEditorConfig();
  if (!target) return <>{children}</>;
  const ref = fileRefTarget(target, cwd);
  const editorLabel = editorLabelFor(ref.abs, editorConfig);
  const items: ExplorerMenuItem[] = [
    ...(editorLabel ? [{ kind: "item", id: "editor", label: editorLabel } as const] : []),
    ...(ref.abs ? [{ kind: "item", id: "reveal", label: "Reveal in Finder" } as const] : []),
    { kind: "item", id: "path", label: "Copy Path" },
    { kind: "item", id: "name", label: "Copy File Name" },
  ];
  const pick = (id: string) => {
    setAt(null);
    if (id === "editor" && ref.abs) {
      const tail = /:(\d+)(?::(\d+))?\s*$/.exec(target);
      void openInEditor(
        {
          path: ref.abs,
          cwd,
          line: tail ? Number(tail[1]) : undefined,
          column: tail?.[2] ? Number(tail[2]) : undefined,
        },
        onOpenFile ?? (() => {}),
      );
    } else if (id === "reveal" && ref.abs) void revealPath(ref.abs);
    else if (id === "path") void copyText(ref.abs ?? ref.clean);
    else if (id === "name") void copyText(ref.name);
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAt({ x: e.clientX, y: e.clientY });
  };
  return (
    <span className="contents" onContextMenu={onContextMenu}>
      {children}
      {at && (
        <ExplorerMenu
          x={at.x}
          y={at.y}
          items={items}
          ariaLabel="File link actions"
          onPick={pick}
          onClose={() => setAt(null)}
        />
      )}
    </span>
  );
}
