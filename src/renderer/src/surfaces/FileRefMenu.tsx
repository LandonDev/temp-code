import { useState, type MouseEvent, type ReactNode } from "react";
import { ExplorerMenu, type ExplorerMenuItem } from "../chrome/ExplorerMenu";
import { copyText } from "../lib/clipboard";
import { fileRefTarget } from "../lib/fileRef";
import { revealPath } from "../lib/fs";

/**
 * Right-click on any file link in the transcript: Reveal in Finder, Copy
 * Path, Copy File Name. Left-click stays with the wrapped child. Relative
 * targets resolve against the transcript's cwd; without one, Reveal hides
 * and Copy Path copies the path as written.
 */
export function FileRefMenu({
  target,
  cwd,
  children,
}: {
  /** the path as rendered — may be relative and carry a :line(:col) tail */
  target: string;
  cwd?: string;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!target) return <>{children}</>;
  const ref = fileRefTarget(target, cwd);
  const items: ExplorerMenuItem[] = [
    ...(ref.abs ? [{ kind: "item", id: "reveal", label: "Reveal in Finder" } as const] : []),
    { kind: "item", id: "path", label: "Copy Path" },
    { kind: "item", id: "name", label: "Copy File Name" },
  ];
  const pick = (id: string) => {
    setAt(null);
    if (id === "reveal" && ref.abs) void revealPath(ref.abs);
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
