import { registry } from "../lib/connection";
import { environmentOfCwd } from "../lib/tcserver/projects";
import { Check, GitBranch, Plus, Search } from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitStageAll,
  gitStash,
  isCheckoutBlockedByChanges,
  notifyGitChanged,
  type GitBranchInfo,
} from "../lib/fs";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { TruncateTip } from "../components/tip";
import { Button } from "../components/ui/button";
import { GroupInput, InputGroup } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/cn";
import { LazyPopover } from "./menuRows";
import { SwitchBranchDialog } from "./SwitchBranchDialog";

type Props = {
  cwd: string;
  branch?: string;
  enabled?: boolean;
  onChange?: () => void;
  onClose?: () => void;
};

type Row =
  | { kind: "create"; name: string }
  | { kind: "branch"; branch: GitBranchInfo };

type PendingSwitch =
  | { kind: "create"; name: string }
  | { kind: "checkout"; name: string; remote: string | null };

export function BranchPicker({
  cwd,
  branch,
  enabled = true,
  onChange,
  onClose,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<PendingSwitch | null>(null);
  const [blockedError, setBlockedError] = useState<string | null>(null);
  const [blockedBusy, setBlockedBusy] = useState<"stash" | "commit" | null>(
    null,
  );
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const environmentId = environmentOfCwd(cwd) ?? registry.primary().environmentId;
  const inProject = Boolean(cwd) && cwd !== "~";
  // A hidden or busy composer keeps the branch it knows and asks git for
  // nothing; only the live one looks up the list.
  const { branches: projectBranches, settled: branchesSettled } =
    useProjectBranchesState(cwd, inProject && enabled);

  const current = branch || projectBranches?.current || null;
  const detached = !branch && !!projectBranches?.detached;

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setQuery("");
    setError(null);
    setBusy(false);
    setBlocked(null);
    setBlockedError(null);
    setBlockedBusy(null);
    if (restore) onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setQuery("");
    setError(null);
    setBusy(false);
    setBlocked(null);
    setBlockedError(null);
    setBlockedBusy(null);
  }, [enabled]);

  const rows = useMemo((): Row[] => {
    const branches = projectBranches?.branches ?? [];
    const name = query.trim();
    const needle = name.toLowerCase();
    const filtered = needle
      ? branches.filter((entry) => {
          const hay = entry.remote
            ? `${entry.name} ${entry.remote}`
            : entry.name;
          return hay.toLowerCase().includes(needle);
        })
      : branches;
    const taken = branches.some(
      (entry) => !entry.remote && entry.name === name,
    );
    const selected = branch || projectBranches?.current;
    const create: Row[] =
      name && !taken ? [{ kind: "create", name }] : [];
    return [
      ...create,
      ...filtered.map((entry) => ({
        kind: "branch" as const,
        branch: {
          ...entry,
          current: entry.name === selected && !entry.remote,
        },
      })),
    ];
  }, [branch, projectBranches, query]);

  useEffect(() => {
    setActive((i) => (rows.length === 0 ? 0 : Math.min(i, rows.length - 1)));
  }, [rows.length]);

  const applySwitch = (pending: PendingSwitch) =>
    pending.kind === "create"
      ? gitCreateBranch(environmentId, cwd, pending.name)
      : gitCheckout(environmentId, cwd, pending.name, pending.remote);

  const finishSwitch = () => {
    notifyGitChanged();
    onChangeRef.current?.();
    dismiss(true);
  };

  const failMessage = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

  const run = async (pending: PendingSwitch) => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await applySwitch(pending);
      finishSwitch();
    } catch (err) {
      const message = failMessage(err);
      if (isCheckoutBlockedByChanges(message)) {
        setOpen(false);
        setQuery("");
        setError(null);
        setBusy(false);
        setBlockedError(null);
        setBlockedBusy(null);
        setBlocked(pending);
        return;
      }
      setError(message);
      setBusy(false);
      search.current?.focus();
    }
  };

  const resolveBlocked = async (
    kind: "stash" | "commit",
    work: () => Promise<unknown>,
  ) => {
    if (!blocked || blockedBusy) return;
    setBlockedBusy(kind);
    setBlockedError(null);
    try {
      await work();
      await applySwitch(blocked);
      finishSwitch();
    } catch (err) {
      setBlockedError(failMessage(err));
      setBlockedBusy(null);
    }
  };

  const pick = (row: Row) => {
    if (row.kind === "create") {
      void run({ kind: "create", name: row.name });
      return;
    }
    if (row.branch.current) {
      dismiss(true);
      return;
    }
    void run({
      kind: "checkout",
      name: row.branch.name,
      remote: row.branch.remote,
    });
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length === 0) return;
      setActive((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  };

  // Always keep the control mounted so the composer's toolbar does not resize
  // when a folder isn't a git repo. The loading skeleton, "No repo" label, and
  // real branch all share the same icon + 12px mono line box.
  const awaitingBranch = inProject && !current && !branchesSettled;
  const missingGit = !current && !awaitingBranch;
  const label = current
    ? detached
      ? `detached ${current}`
      : current
    : "No repo";
  const interactive = enabled && !awaitingBranch && !missingGit;

  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      aria-label={
        awaitingBranch
          ? "Loading branch"
          : missingGit
            ? "No git repository"
            : `Branch ${label}`
      }
      disabled={!interactive || !!blocked}
      className={cn(
        "min-w-0 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground",
        missingGit && "disabled:opacity-100",
      )}
    >
      <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />
      {awaitingBranch ? (
        <span className="relative truncate font-mono text-[12px]">
          {/*
            A real text node, hidden rather than absent, so the pending
            line box is produced exactly the way the loaded one is — the
            toolbar's height cannot depend on which branch we are in.
            "main" also keeps the reserved width near a typical branch.
          */}
          <span className="invisible">main</span>
          <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-current opacity-50" />
        </span>
      ) : (
        <TruncateTip text={label}>
          <span className="truncate font-mono text-[12px]">{label}</span>
        </TruncateTip>
      )}
    </Button>
  );

  return (
    <div className="flex max-w-[45%] shrink-0 items-center gap-2.5">
      <div className="relative min-w-0">
        <LazyPopover
          trigger={trigger}
          open={open}
          onOpenChange={(next) => {
            if (next) setOpen(true);
            else dismiss(true);
          }}
          side="top"
          align="start"
          label="Branch picker"
          initialFocus={search}
          finalFocus={onClose ? false : undefined}
          className="max-h-70 min-h-45 w-70 gap-0 p-1"
        >
          <InputGroup leading={<Search className="size-3.5" />} className="mb-1 shrink-0">
            <GroupInput
              ref={search}
              value={query}
              placeholder="Search or create a branch"
              aria-label="Search or create a branch"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              disabled={busy}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                setError(null);
              }}
              onKeyDown={onSearchKey}
            />
          </InputGroup>
          <BranchList
            rows={rows}
            active={active}
            busy={busy}
            emptyLabel={query.trim() ? "No matching branches" : "No branches"}
            onActive={setActive}
            onPick={pick}
          />
          {error ? (
            <p className="mt-1 max-h-16 shrink-0 overflow-y-auto whitespace-pre-wrap px-2 py-1.5 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </LazyPopover>
        {blocked ? (
          <SwitchBranchDialog
            cwd={cwd}
            branch={blocked.name}
            creating={blocked.kind === "create"}
            busy={blockedBusy}
            error={blockedError}
            onStash={() => {
              void resolveBlocked("stash", () =>
                gitStash(environmentId, cwd, `WIP before switching to ${blocked.name}`),
              );
            }}
            onCommit={(message) => {
              void resolveBlocked("commit", async () => {
                await gitStageAll(environmentId, cwd);
                await gitCommit(environmentId, cwd, message);
              });
            }}
            onCancel={() => {
              if (blockedBusy) return;
              setBlocked(null);
              setBlockedError(null);
              onCloseRef.current?.();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function BranchList({
  rows,
  active,
  busy,
  emptyLabel,
  onActive,
  onPick,
}: {
  rows: Row[];
  active: number;
  busy: boolean;
  emptyLabel: string;
  onActive: (index: number) => void;
  onPick: (row: Row) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (rows.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div role="listbox" aria-label="Branches">
        {rows.map((row, index) => {
          const highlighted = index === active;
          const selected = row.kind === "branch" && row.branch.current;
          return (
            <div
              key={
                row.kind === "create"
                  ? `create:${row.name}`
                  : `${row.branch.remote ?? "local"}:${row.branch.name}`
              }
              ref={highlighted ? activeRef : undefined}
              role="option"
              aria-selected={selected}
              aria-disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onActive(index)}
              onClick={() => {
                if (!busy) onPick(row);
              }}
              className={cn(
                "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px]",
                busy ? "opacity-50" : highlighted && "bg-muted",
              )}
            >
              {row.kind === "create" ? (
                <>
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  <span className="min-w-0 truncate">Create and checkout {row.name}</span>
                </>
              ) : (
                <>
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{row.branch.name}</span>
                  {row.branch.remote ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{row.branch.remote}</span>
                  ) : null}
                  {selected ? <Check className="size-3.5 shrink-0" /> : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
