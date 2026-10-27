import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { DialogFooter, ErrorLine, errorText } from "./ConfirmDialog";
import { ChevronRight, Folder, FolderPlus } from "./icons";
import { Modal } from "./Modal";
import { registry, useEnvironments } from "../lib/connection";
import { createPath, listDir, type FsEntry } from "../lib/fs";
import { INPUT_CLASS, Input, SecondaryButton } from "../surfaces/settingsBits";
import { MatrixSpinner } from "../surfaces/threads/spinners";

/**
 * Pick a folder on another machine (thread K2). No native dialog can open
 * there, so this browses the host's work root over its link, makes a new
 * folder when asked, and takes a typed path when the folder is elsewhere.
 */

type WorkRoot = { root: string; home: string; hostname: string; platform: string; exists: boolean };

const parentOf = (path: string): string | null => {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at > 0 ? trimmed.slice(0, at) : at === 0 && trimmed.length > 1 ? "/" : null;
};

const joinPath = (dir: string, name: string): string => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

/** The crumbs from the work root down to `dir`; the root itself when `dir` is outside it. */
export function crumbsFor(root: string, dir: string): { label: string; path: string }[] {
  const base = root.replace(/\/+$/, "") || "/";
  const current = dir.replace(/\/+$/, "") || "/";
  if (current !== base && !current.startsWith(`${base}/`)) return [{ label: current, path: current }];
  const crumbs = [{ label: base.split("/").pop() || base, path: base }];
  if (current === base) return crumbs;
  let at = base;
  for (const part of current.slice(base.length + 1).split("/")) {
    at = joinPath(at, part);
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

export function RemoteFolderDialog({
  environmentId,
  onClose,
  onPick,
}: {
  environmentId: string;
  onClose: () => void;
  /** The folder chosen; the caller makes the workspace. */
  onPick: (path: string) => void;
}) {
  const environment = useEnvironments().find((e) => e.id === environmentId);
  const name = environment?.name ?? environmentId;
  const [workRoot, setWorkRoot] = useState<WorkRoot | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [typed, setTyped] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    registry
      .linkOf(environmentId)
      .request<WorkRoot>("workspace.root")
      .then((root) => {
        if (!live) return;
        setWorkRoot(root);
        setDir(root.exists ? root.root : root.home);
        setTyped(root.exists ? root.root : root.home);
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [environmentId]);

  const load = useCallback(
    async (path: string) => {
      setEntries(null);
      setError(null);
      try {
        const listed = await listDir(environmentId, path);
        setEntries(listed.filter((e) => e.isDir && !e.name.startsWith(".")));
        setDir(path);
        setTyped(path);
      } catch (err) {
        setEntries([]);
        setError(errorText(err));
      }
    },
    [environmentId],
  );
  useEffect(() => {
    if (dir !== null && entries === null) void load(dir);
  }, [dir, entries, load]);

  const crumbs = useMemo(() => (workRoot && dir ? crumbsFor(workRoot.root, dir) : []), [dir, workRoot]);
  const up = dir ? parentOf(dir) : null;

  const makeFolder = async (e: FormEvent) => {
    e.preventDefault();
    const folder = newFolder?.trim();
    if (!folder || !dir) return;
    setPending(true);
    setError(null);
    try {
      const made = await createPath(environmentId, dir, folder, true);
      setNewFolder(null);
      onPick(made);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const choose = () => {
    const path = typed.trim();
    if (path) onPick(path);
  };

  return (
    <Modal onClose={onClose} busy={pending} title={`Add a workspace on ${name}`} size="md">
      <div className="flex flex-col gap-3 px-4 py-3">
        {!workRoot && !error ? (
          <div className="flex justify-center py-6">
            <MatrixSpinner cell={2} />
          </div>
        ) : null}
        {workRoot ? (
          <>
            <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-0.5 text-[12px] text-content/60">
              {up && crumbs.length === 1 && crumbs[0].path !== workRoot.root ? (
                <button type="button" onClick={() => void load(up)} className="pressable rounded px-1 hover:bg-content/10 hover:text-content">
                  ..
                </button>
              ) : null}
              {crumbs.map((crumb, i) => (
                <span key={crumb.path} className="flex items-center gap-0.5">
                  {i > 0 ? <ChevronRight className="size-3 text-content/30" strokeWidth={2} /> : null}
                  <button
                    type="button"
                    onClick={() => void load(crumb.path)}
                    className={`pressable max-w-48 truncate rounded px-1 hover:bg-content/10 hover:text-content ${i === crumbs.length - 1 ? "text-content" : ""}`}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
            <div className="max-h-64 min-h-24 overflow-y-auto rounded-lg border border-content/10" data-remote-folders>
              {entries === null ? (
                <div className="flex justify-center py-6">
                  <MatrixSpinner cell={1.5} />
                </div>
              ) : entries.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-content/40">No folders here.</p>
              ) : (
                <ul className="flex flex-col p-1">
                  {entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => void load(entry.path)}
                        onDoubleClick={() => onPick(entry.path)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content/80 hover:bg-content/10 hover:text-content"
                      >
                        <Folder className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {newFolder === null ? (
              <div className="flex items-center gap-2">
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (typed.trim() !== dir) void load(typed.trim());
                    }
                  }}
                  aria-label="Folder path"
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1"
                  data-remote-path
                />
                <SecondaryButton onClick={() => setNewFolder("")}>
                  <FolderPlus className="size-3.5" strokeWidth={1.75} />
                  New folder
                </SecondaryButton>
              </div>
            ) : (
              <form onSubmit={(e) => void makeFolder(e)} className="flex items-center gap-2">
                <input
                  value={newFolder}
                  autoFocus
                  onChange={(e) => setNewFolder(e.target.value)}
                  placeholder="folder name"
                  aria-label="New folder name"
                  spellCheck={false}
                  autoComplete="off"
                  className={`${INPUT_CLASS} min-w-0 flex-1`}
                  data-remote-new-folder
                />
                <SecondaryButton onClick={() => setNewFolder(null)}>Cancel</SecondaryButton>
                <button type="submit" disabled={!newFolder.trim() || pending} className="pressable rounded-md bg-content/10 px-2.5 py-1 text-[12px] text-content hover:bg-content/15 disabled:opacity-40">
                  Create and use
                </button>
              </form>
            )}
          </>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Use this folder" onConfirm={choose} disabled={!typed.trim() || pending} />
    </Modal>
  );
}
