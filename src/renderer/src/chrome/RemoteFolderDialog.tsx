import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@renderer/components/ui/item";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { DialogFooter, ErrorLine, errorText } from "./ConfirmDialog";
import { ChevronRight, Folder, FolderPlus } from "./icons";
import { Modal, useModalClose } from "./Modal";
import { cn } from "../lib/cn";
import { registry, useEnvironments } from "../lib/connection";
import { createPath, listDir, type FsEntry } from "../lib/fs";

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

type Props = {
  environmentId: string;
  onClose: () => void;
  /** The folder chosen; the caller makes the workspace. */
  onPick: (path: string) => void;
};

export function RemoteFolderDialog(props: Props) {
  const environment = useEnvironments().find((e) => e.id === props.environmentId);
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title={`Add a workspace on ${environment?.name ?? props.environmentId}`} size="md">
      <FolderPicker {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

/** Three rows in the shape of the folder list while it loads. */
function FolderSkeleton() {
  return (
    <div className="flex flex-col" aria-busy>
      {["w-32", "w-24", "w-40"].map((w) => (
        <div key={w} className="flex h-7 items-center gap-2 px-2">
          <Skeleton className="size-3.5 rounded-sm" />
          <Skeleton className={cn("h-3", w)} />
        </div>
      ))}
    </div>
  );
}

function FolderPicker({ environmentId, onClose, onPick, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  const [workRoot, setWorkRoot] = useState<WorkRoot | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [typed, setTyped] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (path: string) => {
    if (close) close(() => onPick(path));
    else onPick(path);
  };

  // Only the newest listing lands: a slow answer for a folder already left is dropped.
  const latest = useRef(0);
  const load = useCallback(
    async (path: string) => {
      const n = ++latest.current;
      setEntries(null);
      setError(null);
      try {
        const listed = await listDir(environmentId, path);
        if (n !== latest.current) return;
        setEntries(listed.filter((e) => e.isDir && !e.name.startsWith(".")));
        setDir(path);
        setTyped(path);
      } catch (err) {
        if (n !== latest.current) return;
        setEntries([]);
        setError(errorText(err));
      }
    },
    [environmentId],
  );

  useEffect(() => {
    let live = true;
    registry
      .linkOf(environmentId)
      .request<WorkRoot>("workspace.root")
      .then((root) => {
        if (!live) return;
        const start = root.exists ? root.root : root.home;
        setWorkRoot(root);
        setDir(start);
        setTyped(start);
        void load(start);
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [environmentId, load]);

  const crumbs = useMemo(() => (workRoot && dir ? crumbsFor(workRoot.root, dir) : []), [dir, workRoot]);
  const up = dir ? parentOf(dir) : null;
  const loading = !workRoot && !error;

  const makeFolder = async (e: FormEvent) => {
    e.preventDefault();
    const folder = newFolder?.trim();
    if (!folder || !dir) return;
    setPending(true);
    setError(null);
    try {
      const made = await createPath(environmentId, dir, folder, true);
      setPending(false);
      pick(made);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const choose = () => {
    const path = typed.trim();
    if (path) pick(path);
  };

  return (
    <>
      <div className="flex flex-col gap-3 px-4 py-4">
        {workRoot || loading ? (
          <>
            <nav aria-label="Folder" className="-mx-2 flex min-h-6 min-w-0 flex-wrap items-center gap-0.5">
              {loading ? <Skeleton className="mx-2 h-3 w-28" /> : null}
              {workRoot && up && crumbs.length === 1 && crumbs[0].path !== workRoot.root ? (
                <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => void load(up)}>
                  ..
                </Button>
              ) : null}
              {crumbs.map((crumb, i) => (
                <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
                  {i > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground" /> : null}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void load(crumb.path)}
                    aria-current={i === crumbs.length - 1 ? "location" : undefined}
                    className={cn("max-w-48 justify-start", i === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground")}
                  >
                    <span className="truncate">{crumb.label}</span>
                  </Button>
                </span>
              ))}
            </nav>
            <div className="rounded-lg border border-border" data-remote-folders>
              {loading || entries === null ? (
                <div className="p-1">
                  <FolderSkeleton />
                </div>
              ) : entries.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">No folders here.</p>
              ) : (
                <ScrollArea className="max-h-64 [&>[data-slot=scroll-area-viewport]]:max-h-64">
                  <div className="flex flex-col p-1">
                    {entries.map((entry) => (
                      <Item
                        key={entry.path}
                        size="xs"
                        render={<button type="button" />}
                        onClick={() => void load(entry.path)}
                        onDoubleClick={() => pick(entry.path)}
                        className="rounded-sm text-start hover:bg-foreground/5"
                      >
                        <ItemMedia>
                          <Folder className="size-3.5" />
                        </ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="max-w-full font-normal">
                            <span className="truncate">{entry.name}</span>
                          </ItemTitle>
                        </ItemContent>
                      </Item>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
            {newFolder === null ? (
              <div className="flex items-center gap-2">
                <Input
                  value={typed}
                  disabled={loading}
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
                  className="flex-1 font-mono text-xs"
                  data-remote-path
                />
                <Button variant="secondary" disabled={!dir} onClick={() => setNewFolder("")}>
                  <FolderPlus />
                  New folder
                </Button>
              </div>
            ) : (
              <form onSubmit={(e) => void makeFolder(e)} className="flex items-center gap-2">
                <Input
                  value={newFolder}
                  autoFocus
                  disabled={pending}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setNewFolder(null);
                    }
                  }}
                  placeholder="Folder name"
                  aria-label="New folder name"
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1"
                  data-remote-new-folder
                />
                <Button variant="ghost" disabled={pending} onClick={() => setNewFolder(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="secondary" disabled={!newFolder.trim() || pending}>
                  {pending ? <Spinner className="size-3.5" /> : null}
                  Create and use
                </Button>
              </form>
            )}
          </>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Use this folder" onConfirm={choose} disabled={!typed.trim() || pending} />
    </>
  );
}
