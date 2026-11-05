import { registry } from "../lib/connection";
import { environmentOfCwd } from "../lib/tcserver/projects";
import { ChevronDown, GitBranch, Search } from "./icons";
import { ROW_CONTROL } from "./composerRow";
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
} from "../lib/fs";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { TruncateTip } from "../components/tip";
import { Button } from "../components/ui/button";
import { GroupInput, InputGroup } from "../components/ui/input";
import { cn } from "../lib/cn";
import { LazyPopover } from "./menuRows";
import type { BranchRow as Row, BranchRows } from "./BranchRows";
import { dialogsChunk, menuChunk } from "../surfaces/chunks";

// Mounted only while a switch is blocked, through the dialogs chunk.
const SwitchBranchDialog = dialogsChunk.surface("SwitchBranchDialog");

type Props = {
  cwd: string;
  branch?: string;
  enabled?: boolean;
  /** `composer`: the draft row's chip. `head`: the Changes section's branch
   *  name, in its 13px medium type, the list opening below it. */
  variant?: "composer" | "head";
  /** A label on hover (the head's Tracks / Not published / No remote). */
  tip?: string;
  onChange?: () => void;
  onClose?: () => void;
};


type PendingSwitch =
  | { kind: "create"; name: string }
  | { kind: "checkout"; name: string; remote: string | null };

export function BranchPicker({
  cwd,
  branch,
  enabled = true,
  variant = "composer",
  tip,
  onChange,
  onClose,
}: Props) {
  const head = variant === "head";
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
        head
          ? "h-7 min-w-0 max-w-full justify-start px-1.5 text-[13px] font-medium text-foreground"
          : cn("min-w-0", ROW_CONTROL),
        missingGit && "disabled:opacity-100",
      )}
    >
      {head ? null : <GitBranch className="size-3.5 shrink-0" />}
      {head && !awaitingBranch ? (
        <span className="truncate">{label}</span>
      ) : awaitingBranch ? (
        <span className="relative truncate font-mono text-xs">
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
          <span className="truncate font-mono text-xs">{label}</span>
        </TruncateTip>
      )}
      {/* A menu trigger's still chevron, as every picker in the draft row has. */}
      {head || missingGit ? null : <ChevronDown aria-hidden className="size-3 shrink-0" />}
    </Button>
  );

  return (
    <div className={head ? "flex min-w-0 flex-1 items-center" : "flex max-w-[45%] shrink-0 items-center gap-2.5"}>
      <div className="relative min-w-0">
        <LazyPopover
          trigger={trigger}
          tip={tip ? { label: tip } : undefined}
          open={open}
          onOpenChange={(next) => {
            if (next) setOpen(true);
            else dismiss(true);
          }}
          side={head ? "bottom" : "top"}
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
          {/* The popover's children mount only once the menu chunk has landed, and the list rides it. */}
          <ListOf
            rows={rows}
            active={active}
            busy={busy}
            emptyLabel={query.trim() ? "No matching branches" : "No branches"}
            onActive={setActive}
            onPick={pick}
          />
          {error ? (
            <p className="mt-1 max-h-16 shrink-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap px-2 py-1.5 text-xs text-destructive">
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

/** The list, from the menu chunk the open popover already loaded. */
function ListOf(props: Parameters<typeof BranchRows>[0]) {
  const Body = menuChunk.loaded();
  return Body ? <Body.BranchRows {...props} /> : null;
}
