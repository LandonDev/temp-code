import { useEnvironments } from "../lib/connection";
import { hostOfCwd } from "../lib/tcserver/projects";
import { openUrl } from "../lib/native";
import {
  CircleDot,
  ExternalLink,
  GitCompare,
  GitPullRequest,
  Inbox,
  ListFilter,
  RefreshCw,
  Search,
} from "../chrome/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  InboxFiltersMenu,
  INBOX_FILTER_MENU_WIDTH,
} from "../chrome/InboxFiltersMenu";
import { HostGlyph } from "../chrome/HostGlyph";
import { InboxProviderMark } from "../chrome/InboxProviderMark";
import { ProjectLogoIcon } from "../chrome/ProjectLogoIcon";
import { ProjectMascot } from "../chrome/ProjectMascot";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Item } from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { StatusMark } from "../components/ui/status";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { checksFailed, inboxItemSource, inboxRowModel, inboxStateWords } from "../lib/inboxRow";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  githubPrDiff,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  inboxItemKey,
  inboxItemRef,
  peekGithubPrDiff,
  peekGithubWorkItemDetails,
  peekGithubWorkItemThread,
  formatRelativeTime,
  inboxPersonAvatarUrl,
  type GithubLabel,
  type GithubPrDiff,
  type GithubWorkItemDetails,
  type GithubWorkItemThread,
  type InboxItem,
  sortInboxItems,
} from "../lib/githubTasks";
import {
  githubInboxLoading,
  githubWorkspaces,
  inboxItemsFromSnapshot,
  inboxStore,
  useInboxAll,
  mergeInboxStates,
  workspaceIdForCwd,
  type InboxScope,
  type LinearInboxQuery,
} from "../lib/inboxStore";
import { useWorkspaceCatalog, useWorkspaceIcon } from "../lib/tcserver/workspaces";
import type { WorkspaceMeta } from "../lib/tcserver/types";
import {
  applyInboxFilters,
  hasActiveInboxFilters,
  inboxFetchState,
  loadInboxFilters,
  loadInboxSource,
  pruneInboxFilters,
  saveInboxFilters,
  saveInboxSource,
  type InboxFilters,
  type InboxSource,
} from "../lib/inboxFilters";
import { projectName } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { sameProjectPath } from "../lib/recents";
import { setInboxSelection, useInboxSelection } from "../lib/inboxSelection";
import {
  isInboxEntryUnseen,
  markInboxItemSeen,
  useInboxSeenTick,
} from "../lib/inboxSeen";
import {
  LINEAR_CHANGE_EVENT,
  linearIssueComment,
  linearIssueDetails,
  linearIssueThread,
  loadHiddenLinearTeamIds,
  peekLinearIssueDetails,
  peekLinearIssueThread,
  type LinearIssueThread,
} from "../lib/linear";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../lib/tabGroups";
import { AgentMarkdown } from "./AgentMarkdown";
import {
  InboxComments,
  InboxCommentForm,
  type InboxReplyTarget,
} from "./InboxComments";
import { InboxPrDiff } from "./InboxPrDiff";

const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 280;
/** A stored snapshot older than this is refreshed when the inbox opens. */
const OPEN_REFRESH_AGE_MS = 60_000;
/** While the inbox is open and the window visible, GitHub is asked again this often. */
const INTERVAL_REFRESH_MS = 3 * 60_000;

let rememberedWidth = DEFAULT_WIDTH;

type InboxProjectOption = {
  /** workspace id */
  id: string;
  path: string;
  name: string;
  logoPath: string | null;
  mascotName: string | null;
  mascotColor: string;
};

function inboxProjectOptions(
  workspaces: readonly WorkspaceMeta[],
  logos: ReturnType<typeof useTabGroupLogos>,
): InboxProjectOption[] {
  const mascots = loadTabGroupMascots();
  const colors = loadTabGroupColors();
  const custom = loadTabGroupCustomColors();
  return [...workspaces]
    .map((workspace) => {
      const key = projectName(workspace.path);
      return {
        id: workspace.id,
        path: workspace.path,
        name: key,
        logoPath: resolveTabGroupLogo(key, logos),
        mascotName: resolveTabGroupMascot(key, mascots),
        mascotColor: resolveTabGroupColor(key, colors, custom, key),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The workspace's mark, the same image the rail shows: the logo override,
 *  else the server's repo icon unless a mascot was chosen, else the mascot. */
function InboxProjectMark({
  project,
}: {
  project: Pick<
    InboxProjectOption,
    "id" | "name" | "logoPath" | "mascotName" | "mascotColor"
  >;
}) {
  const serverIcon = useWorkspaceIcon(project.id);
  const showLogo =
    !!project.logoPath ||
    (!project.mascotName && !!(serverIcon?.dataUrl || serverIcon?.host));
  if (showLogo) {
    return (
      <ProjectLogoIcon
        path={project.logoPath}
        workspaceId={project.id}
        className="size-3.5 shrink-0 rounded-md"
        imageClassName="size-3.5"
      />
    );
  }
  return (
    <ProjectMascot
      project={project.name}
      color={project.mascotColor}
      name={project.mascotName}
      className="size-3 shrink-0"
    />
  );
}

type Props = {
  cwd: string;
  besideRail?: boolean;
  variant?: "overlay" | "sidebar";
  onClose?: () => void;
  onToggleSidebar?: () => void;
  onStart?: (item: InboxItem, body?: string) => void | Promise<void>;
};

export function InboxView({
  cwd,
  besideRail = false,
  variant = "overlay",
  onClose,
  onToggleSidebar,
  onStart,
}: Props) {
  const sidebar = variant === "sidebar";
  const listLock = useLockOverscroll<HTMLDivElement>();
  const detailLock = useLockOverscroll<HTMLDivElement>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const logos = useTabGroupLogos();

  const [searchInput, setSearchInput] = useState("");
  // Every paired host's inbox, merged; rows name the host when there is more than one.
  const environments = useEnvironments();
  const environmentIds = useMemo(() => environments.map((e) => e.id), [environments]);
  const inboxStates = useInboxAll();
  const { githubLoaded, refreshing, githubAuthMessage, linear } = useMemo(
    () => mergeInboxStates(inboxStates, environmentIds),
    [environmentIds, inboxStates],
  );
  const catalog = useWorkspaceCatalog();
  const [refresh, setRefresh] = useState(0);
  // What the list shows: this workspace until the user asks for the rest.
  // Every refresh covers every GitHub workspace, so the toggle is instant.
  const [scope, setScope] = useState<InboxScope>("current");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filters, setFilters] = useState(loadInboxFilters);
  const [source, setSource] = useState(loadInboxSource);
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [linearHiddenTeamIds, setLinearHiddenTeamIds] = useState(
    loadHiddenLinearTeamIds,
  );
  const prevRefresh = useRef(refresh);

  const ghWorkspaces = useMemo(
    () => githubWorkspaces(catalog.workspaces),
    [catalog.workspaces],
  );
  // The workspace of the folder the user is looking at, when it is on GitHub.
  const currentWorkspaceId = useMemo(() => {
    const id = workspaceIdForCwd(catalog, cwd);
    return id && ghWorkspaces.some((w) => w.id === id) ? id : null;
  }, [catalog, cwd, ghWorkspaces]);
  const effectiveScope: InboxScope = currentWorkspaceId ? scope : "all";
  // Each host's snapshot against that host's own workspaces: a repo checked
  // out on two machines lists once per machine, and each row says which.
  const githubItems = useMemo(
    () =>
      sortInboxItems(
        environmentIds.flatMap((id) =>
          inboxItemsFromSnapshot(
            inboxStates.get(id)?.github ?? null,
            catalog.workspaces.filter((w) => w.environmentId === id),
            catalog.projects.filter((p) => p.environmentId === id),
            cwd,
          ),
        ),
      ),
    [catalog.projects, catalog.workspaces, cwd, environmentIds, inboxStates],
  );
  const items = useMemo(
    () =>
      source === "linear"
        ? linear.items
        : effectiveScope === "current"
          ? githubItems.filter((item) => item.workspaceId === currentWorkspaceId)
          : githubItems,
    [currentWorkspaceId, effectiveScope, githubItems, linear.items, source],
  );
  const projectOptions = useMemo(
    () => inboxProjectOptions(catalog.workspaces, logos),
    [catalog.workspaces, logos],
  );
  const workspaceOptions = useMemo(
    () => projectOptions.filter((option) => ghWorkspaces.some((w) => w.id === option.id)),
    [ghWorkspaces, projectOptions],
  );
  const activeFilters = useMemo(
    () =>
      pruneInboxFilters(
        filters,
        ghWorkspaces.map((w) => w.id),
      ),
    [filters, ghWorkspaces],
  );
  const filtersActive = hasActiveInboxFilters(activeFilters, source);
  const fetchState = inboxFetchState(activeFilters);
  const linearQuery = useMemo<LinearInboxQuery>(
    () => ({
      assignedToMe: activeFilters.mine.assigned,
      state: fetchState,
      hiddenTeamIds: linearHiddenTeamIds,
    }),
    [activeFilters.mine.assigned, fetchState, linearHiddenTeamIds],
  );
  // The open view always asks for a refresh once the stored snapshot is in;
  // until then that refresh is pending, and a never-fetched list is not a list.
  const [opened, setOpened] = useState(false);
  const scopedRepos = useMemo(
    () =>
      ghWorkspaces
        .filter((w) => effectiveScope === "all" || w.id === currentWorkspaceId)
        .map((w) => w.githubRepo as string),
    [currentWorkspaceId, effectiveScope, ghWorkspaces],
  );
  const loading =
    source === "github"
      ? environmentIds.some((id) => {
          const state = inboxStates.get(id);
          const repos = scopedRepos.filter((repo) =>
            ghWorkspaces.some((w) => w.environmentId === id && w.githubRepo === repo),
          );
          return state ? githubInboxLoading(state, repos, !opened) : repos.length > 0;
        })
      : linear.fetchedAt === null && linear.error === null;
  const revalidating = source === "github" ? refreshing : linear.loading;
  const authMessage = source === "github" ? githubAuthMessage : null;
  const sourceError = source === "linear" ? linear.error : authMessage;
  const repoErrors = useMemo(
    () =>
      source === "github"
        ? environmentIds.flatMap((id) => (inboxStates.get(id)?.github?.repos ?? []).filter((repo) => repo.error))
        : [],
    [environmentIds, inboxStates, source],
  );
  const newestSnapshotAt = useMemo(
    () => Math.max(0, ...environmentIds.map((id) => inboxStates.get(id)?.github?.fetchedAt ?? 0)),
    [environmentIds, inboxStates],
  );

  const resize = useDragResize({
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth,
    onCommit: (width) => {
      rememberedWidth = width;
    },
  });

  useEffect(() => {
    if (sidebar) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (filterMenu) {
        setFilterMenu(null);
        return;
      }
      onCloseRef.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filterMenu, sidebar]);

  useEffect(() => {
    const onChange = () => {
      setLinearHiddenTeamIds(loadHiddenLinearTeamIds());
      setRefresh((value) => value + 1);
    };
    window.addEventListener(LINEAR_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LINEAR_CHANGE_EVENT, onChange);
  }, []);

  // GitHub: the list shows the stored snapshot at once; the view asks the
  // server for a fresh one when it opens on a snapshot older than a minute.
  // Nothing fetches while the inbox is closed.
  useEffect(() => {
    if (!githubLoaded || opened) return;
    setOpened(true);
    const age = newestSnapshotAt ? Date.now() - newestSnapshotAt : Number.POSITIVE_INFINITY;
    if (age > OPEN_REFRESH_AGE_MS) void inboxStore.refreshGithubAll("open");
  }, [githubLoaded, newestSnapshotAt, opened]);

  // ...and again every three minutes while this view is mounted and the
  // window is visible. The timer dies with the view.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void inboxStore.refreshGithubAll("interval");
    }, INTERVAL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Linear: only while its tab is open, for the current query.
  useEffect(() => {
    if (source !== "linear") return;
    void inboxStore.refreshLinearAll(linearQuery);
  }, [environmentIds, linearQuery, source]);

  // The refresh button and a Linear change: fetch the open tab again now.
  useEffect(() => {
    if (refresh === prevRefresh.current) return;
    prevRefresh.current = refresh;
    if (source === "linear") void inboxStore.refreshLinearAll(linearQuery, { force: true });
    else void inboxStore.refreshGithubAll("manual");
  }, [linearQuery, refresh, source]);

  const visibleItems = useMemo(
    () =>
      applyInboxFilters(items, activeFilters, searchInput, Date.now(), source),
    [activeFilters, items, searchInput, source],
  );

  const narrowedByUser = searchInput.trim().length > 0 || filtersActive;
  // The repo or team on each row only when the list holds more than one.
  const showSource = source === "linear" || (effectiveScope === "all" && ghWorkspaces.length > 1);

  const selected =
    visibleItems.find((item) => inboxItemKey(item) === selectedKey) ??
    visibleItems[0] ??
    null;

  useEffect(() => {
    if (!selected) {
      setSelectedKey(null);
      return;
    }
    const key = inboxItemKey(selected);
    if (key !== selectedKey) setSelectedKey(key);
  }, [selected, selectedKey]);

  useEffect(() => {
    setInboxSelection(selected);
  }, [selected]);

  const onFiltersChange = (next: InboxFilters) => {
    const pruned = pruneInboxFilters(
      next,
      ghWorkspaces.map((w) => w.id),
    );
    setFilters(pruned);
    saveInboxFilters(pruned);
  };

  const onSourceChange = (next: InboxSource) => {
    setSource(next);
    saveInboxSource(next);
  };

  const onFilterButtonClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (filterMenu) {
      setFilterMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setFilterMenu({
      x: rect.right - INBOX_FILTER_MENU_WIDTH,
      y: rect.bottom + 4,
    });
  };

  const list = (
    <div
      ref={sidebar ? undefined : resize.setPaneRef}
      className={
        sidebar
          ? "flex min-h-0 min-w-0 flex-1 flex-col"
          : "relative flex h-full min-h-0 shrink-0 flex-col border-r border-border"
      }
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2">
        <Tabs value={source} onValueChange={(next) => onSourceChange(next as InboxSource)}>
          <TabsList aria-label="Inbox source" className="w-full">
            <TabsTrigger value="github">
              <InboxProviderMark provider="github" className="size-3.5" />
              GitHub
            </TabsTrigger>
            <TabsTrigger value="linear">
              <InboxProviderMark provider="linear" className="size-3.5" />
              Linear
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Filter inbox"
              aria-label="Filter inbox"
              spellCheck={false}
              autoComplete="off"
              className="ps-8"
            />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Filters"
                  aria-expanded={!!filterMenu}
                  aria-haspopup="menu"
                  onClick={onFilterButtonClick}
                  className={filtersActive || filterMenu ? "text-foreground" : "text-muted-foreground"}
                />
              }
            >
              <ListFilter />
            </TooltipTrigger>
            <TooltipContent>Filters</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Refresh"
                  onClick={() => setRefresh((value) => value + 1)}
                  className="text-muted-foreground"
                />
              }
            >
              {loading || revalidating ? <Spinner className="size-3" /> : <RefreshCw />}
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div
        ref={listLock}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none"
      >
        {sourceError && visibleItems.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-destructive">{sourceError}</p>
        ) : loading && items.length === 0 ? (
          <InboxRowsSkeleton />
        ) : visibleItems.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {narrowedByUser
                  ? "No matching issues"
                  : source === "linear"
                    ? "No Linear issues"
                    : ghWorkspaces.length === 0
                      ? "No GitHub workspaces"
                      : "No issues or pull requests"}
              </EmptyTitle>
              {!narrowedByUser && source === "github" && ghWorkspaces.length === 0 ? (
                <EmptyDescription>Add a GitHub repository as a workspace.</EmptyDescription>
              ) : null}
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5">
            {visibleItems.map((item) => {
              const key = inboxItemKey(item);
              return (
                <li key={key}>
                  <InboxRow
                    item={item}
                    active={selected != null && key === inboxItemKey(selected)}
                    environmentId={item.environmentId ?? null}
                    showSource={showSource}
                    onSelect={() => {
                      markInboxItemSeen({
                        key,
                        updatedAt: item.updatedAt,
                      });
                      setSelectedKey(key);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {authMessage && visibleItems.length > 0 ? (
          <p className="px-3 py-2 text-[12px] text-destructive">{authMessage}</p>
        ) : null}
        {repoErrors.length > 0 && !(sourceError && visibleItems.length === 0)
          ? repoErrors.map((repo) => (
              <p key={repo.repo} className="px-3 py-1 text-[12px] text-muted-foreground">
                {repo.repo}: {repo.error}
              </p>
            ))
          : null}
        {source === "github" && currentWorkspaceId && ghWorkspaces.length > 1 && !loading ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setScope((value) => (value === "all" ? "current" : "all"))}
            className="mx-1.5 mb-1.5 justify-start self-start text-muted-foreground"
          >
            {scope === "all" ? "This workspace only" : "Show all workspaces"}
          </Button>
        ) : null}
      </div>
      {sidebar ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inbox list"
          className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
            resize.dragging ? "bg-foreground/10" : "hover:bg-foreground/10"
          }`}
          onPointerDown={resize.onPointerDown}
          onDoubleClick={resize.onDoubleClick}
        />
      )}
    </div>
  );

  const filtersPortal = filterMenu ? (
    <InboxFiltersMenu
      x={filterMenu.x}
      y={filterMenu.y}
      workspaces={effectiveScope === "all" ? workspaceOptions : []}
      source={source}
      filters={activeFilters}
      onChange={onFiltersChange}
      onClose={() => setFilterMenu(null)}
    />
  ) : null;

  if (sidebar) {
    return (
      <div
        role="region"
        aria-label="Inbox"
        className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
      >
        {list}
        {filtersPortal}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Inbox"
      data-app-inbox
      className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-border"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">Inbox</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        {list}
        <div
          ref={detailLock}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
        >
          <InboxDetailBody
            item={selected}
            cwd={cwd}
            projects={projectOptions}
            activeWorkspaceId={workspaceIdForCwd(catalog, cwd)}
            revision={refresh}
            onStart={onStart}
          />
        </div>
      </div>
      {filtersPortal}
    </div>
  );
}

export function InboxDetailPane({
  cwd,
  onStart,
}: {
  cwd: string;
  onStart?: (item: InboxItem, body?: string) => void | Promise<void>;
}) {
  const item = useInboxSelection();
  const logos = useTabGroupLogos();
  const catalog = useWorkspaceCatalog();
  const projectOptions = useMemo(
    () => inboxProjectOptions(catalog.workspaces, logos),
    [catalog.workspaces, logos],
  );
  return (
    <div
      role="region"
      aria-label="Inbox"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-none text-foreground"
    >
      <InboxDetailBody
        item={item}
        cwd={cwd}
        projects={projectOptions}
        activeWorkspaceId={workspaceIdForCwd(catalog, cwd)}
        onStart={onStart}
      />
    </div>
  );
}

function InboxDetailBody({
  item,
  cwd,
  projects,
  activeWorkspaceId,
  revision = 0,
  onStart,
}: {
  item: InboxItem | null;
  cwd: string;
  projects: InboxProjectOption[];
  activeWorkspaceId: string | null;
  revision?: number;
  onStart?: (item: InboxItem, body?: string) => void | Promise<void>;
}) {
  // Nothing selected draws nothing: the list's Empty already says why.
  if (!item) return null;
  return (
    <InboxDetail
      key={inboxItemKey(item)}
      item={item}
      cwd={cwd}
      projects={projects}
      activeWorkspaceId={activeWorkspaceId}
      revision={revision}
      onStart={onStart}
    />
  );
}

/** One inbox row, two lines: the kind glyph, the title (medium while
 *  unseen, the rail's unread rule) and the time; then the ref, the source
 *  when shown, the author, the host's glyph, and failed checks at the end.
 *  Labels, avatars and the provider mark are the detail pane's. */
export function InboxRow({
  item,
  active,
  environmentId,
  showSource,
  onSelect,
}: {
  item: InboxItem;
  active: boolean;
  /** The host the row came from; its glyph shows when more than one is paired. */
  environmentId?: string | null;
  showSource: boolean;
  onSelect: () => void;
}) {
  useInboxSeenTick();
  const unseen = isInboxEntryUnseen({ key: inboxItemKey(item), updatedAt: item.updatedAt });
  const row = inboxRowModel(item, { unseen, showSource });
  const KindIcon = row.kind === "pr" ? GitPullRequest : CircleDot;
  return (
    <Item
      size="sm"
      className={cn(
        "flex-col flex-nowrap items-stretch gap-0.5 rounded-md px-2.5 py-2 text-left transition-none",
        active ? "bg-muted" : "hover:bg-foreground/5",
      )}
      render={
        <button
          type="button"
          aria-current={active ? "true" : undefined}
          aria-label={unseen ? `${item.title}, new` : undefined}
          onClick={onSelect}
        />
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          data-row-title
          className={cn("min-w-0 flex-1 truncate text-[13px] text-foreground", unseen ? "font-medium" : "font-normal")}
        >
          {row.title}
        </span>
        {row.time ? (
          <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{row.time}</span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-3 ps-[22px] text-[12px] text-muted-foreground">
        {row.line.map((fact, index) => (
          <span key={index} className={index === 0 ? "shrink-0 tabular-nums" : "min-w-0 truncate"}>
            {fact}
          </span>
        ))}
        <HostGlyph environmentId={environmentId} />
        {row.status ? (
          // StatusMark has no detail slot yet; "checks" sits beside it in its tone.
          <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs font-medium text-destructive">
            <StatusMark state={row.status.state} />
            <span>{row.status.detail}</span>
          </span>
        ) : null}
      </span>
    </Item>
  );
}

/** Five rows in the row's shape while the first list loads. */
function InboxRowsSkeleton() {
  return (
    <div aria-label="Loading inbox" className="flex flex-col gap-0.5 p-1.5">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex flex-col gap-1.5 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Skeleton className="size-3.5 rounded-sm" />
            <Skeleton className="h-3.5 flex-1" />
          </div>
          <Skeleton className="ms-[22px] h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function InboxDetail({
  item,
  cwd,
  projects,
  activeWorkspaceId,
  revision,
  onStart,
}: {
  item: InboxItem;
  cwd: string;
  projects: InboxProjectOption[];
  activeWorkspaceId: string | null;
  revision: number;
  onStart?: (item: InboxItem, body?: string) => void | Promise<void>;
}) {
  const environmentId = item.environmentId ?? hostOfCwd(item.projectPath);
  const linear = item.provider === "linear";
  const isPr = !linear && item.kind === "pr";
  const githubKind =
    item.kind === "issue" || item.kind === "pr" ? item.kind : null;
  const cached = linear
    ? peekLinearIssueDetails(environmentId, item.id ?? "")
    : githubKind
      ? peekGithubWorkItemDetails(item.projectPath, githubKind, item.number)
      : null;
  const cachedDiff = isPr
    ? peekGithubPrDiff(item.projectPath, item.number)
    : null;
  const cachedThread = linear
    ? peekLinearIssueThread(environmentId, item.id ?? "")
    : githubKind
      ? peekGithubWorkItemThread(item.projectPath, githubKind, item.number)
      : null;
  const [details, setDetails] = useState<GithubWorkItemDetails | null>(cached);
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [prDiff, setPrDiff] = useState<GithubPrDiff | null>(cachedDiff);
  const [diffLoading, setDiffLoading] = useState(isPr && cachedDiff == null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [thread, setThread] = useState<
    GithubWorkItemThread | LinearIssueThread | null
  >(cachedThread);
  const [threadLoading, setThreadLoading] = useState(cachedThread == null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<InboxReplyTarget | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const defaultProject =
    projects.find((project) => project.id === activeWorkspaceId)?.path ??
    projects[0]?.path ??
    cwd;
  const [startProject, setStartProject] = useState(defaultProject);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const source = inboxItemSource(item);
  const markdownCwd = linear ? startProject || cwd : item.projectPath || cwd;
  // The snapshot already knows the author, refs and decision; gh fills the rest.
  const authorName = item.author?.login?.trim() || details?.author?.trim() || "";
  const authorAvatar = item.author?.avatarUrl?.trim() || details?.authorAvatarUrl;
  const extraAssignees = item.assignees.filter(
    (person) =>
      !authorName ||
      person.login.trim().toLowerCase() !== authorName.toLowerCase(),
  );
  const showAssignment =
    extraAssignees.length > 0 || item.assignees.length === 0;
  const reviewDecision =
    item.reviewDecision?.trim() ||
    details?.reviewDecision?.trim() ||
    thread?.reviewDecision?.trim() ||
    "";
  const stateWords = inboxStateWords(item, reviewDecision);
  const baseRef =
    item.baseRefName?.trim() || details?.baseRefName?.trim() || thread?.baseRefName?.trim() || "";
  const headRef =
    item.headRefName?.trim() || details?.headRefName?.trim() || thread?.headRefName?.trim() || "";

  useEffect(() => {
    let cancelled = false;
    const cachedDetails = linear
      ? peekLinearIssueDetails(environmentId, item.id ?? "")
      : githubKind
        ? peekGithubWorkItemDetails(item.projectPath, githubKind, item.number)
        : null;
    if (cachedDetails) {
      setDetails(cachedDetails);
      setLoading(false);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
      setDetails(null);
    }
    const pending = linear
      ? item.id
        ? linearIssueDetails(environmentId, item.id)
        : Promise.reject(new Error("Missing Linear issue"))
      : githubKind
        ? githubWorkItemDetails(environmentId, item.projectPath, githubKind, item.number, item.repo)
        : Promise.reject(new Error("Unknown inbox item"));
    void pending
      .then((next) => {
        if (cancelled) return;
        setDetails(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cachedDetails) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, githubKind, item.id, item.number, item.projectPath, linear, revision]);

  useEffect(() => {
    let cancelled = false;
    if (linear) {
      const id = item.id ?? "";
      const cachedThread = peekLinearIssueThread(environmentId, id);
      if (cachedThread) {
        setThread(cachedThread);
        setThreadLoading(false);
        setThreadError(null);
      } else {
        setThreadLoading(true);
        setThreadError(null);
        setThread(null);
      }
      void linearIssueThread(environmentId, id)
        .then((next) => {
          if (cancelled) return;
          setThread(next);
          setThreadError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (cachedThread) return;
          setThreadError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setThreadLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!githubKind) return;
    const cachedThread = peekGithubWorkItemThread(
      item.projectPath,
      githubKind,
      item.number,
    );
    if (cachedThread) {
      setThread(cachedThread);
      setThreadLoading(false);
      setThreadError(null);
    } else {
      setThreadLoading(true);
      setThreadError(null);
      setThread(null);
    }
    void githubWorkItemThread(environmentId, item.projectPath, githubKind, item.number, { repo: item.repo })
      .then((next) => {
        if (cancelled) return;
        setThread(next);
        setThreadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cachedThread) return;
        setThreadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, githubKind, item.id, item.number, item.projectPath, linear, revision]);

  useEffect(() => {
    if (!isPr) return;
    let cancelled = false;
    const cachedDiff = peekGithubPrDiff(item.projectPath, item.number);
    if (cachedDiff) {
      setPrDiff(cachedDiff);
      setDiffLoading(false);
      setDiffError(null);
    } else {
      setDiffLoading(true);
      setDiffError(null);
      setPrDiff(null);
    }
    void githubPrDiff(environmentId, item.projectPath, item.number)
      .then((next) => {
        if (cancelled) return;
        setPrDiff(next);
        setDiffError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cachedDiff) return;
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, isPr, item.number, item.projectPath, revision]);

  const postComment = async (body: string) => {
    setPosting(true);
    setPostError(null);
    try {
      if (linear) {
        const id = item.id ?? "";
        await linearIssueComment(environmentId, id, body, { parentId: replyTo?.id });
        setReplyTo(null);
        try {
          setThread(await linearIssueThread(environmentId, id, { force: true }));
        } catch (err: unknown) {
          setPostError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (!githubKind) throw new Error("Unknown inbox item");
      await githubWorkItemComment(
        environmentId,
        item.projectPath,
        githubKind,
        item.number,
        body,
        { inReplyTo: replyTo?.threadId },
      );
      setReplyTo(null);
      try {
        setThread(
          await githubWorkItemThread(
            environmentId,
            item.projectPath,
            githubKind,
            item.number,
            { force: true, repo: item.repo },
          ),
        );
      } catch (err: unknown) {
        setPostError(err instanceof Error ? err.message : String(err));
      }
    } catch (err: unknown) {
      setPostError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
      <header className="flex flex-col">
        <div className="flex min-w-0 items-center gap-3 text-[12px] text-muted-foreground">
          <span className="flex shrink-0 items-center gap-2">
            <InboxProviderMark provider={item.provider} className="size-3.5" />
            <span className="tabular-nums">{inboxItemRef(item)}</span>
          </span>
          {stateWords.map((word) => (
            <span key={word} className="shrink-0">
              {word}
            </span>
          ))}
          {source ? <span className="min-w-0 truncate">{source}</span> : null}
          {checksFailed(item) ? (
            // StatusMark has no detail slot yet; "checks" sits beside it in its tone.
            <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs font-medium text-destructive">
              <StatusMark state="failed" />
              <span>checks</span>
            </span>
          ) : null}
        </div>
        <h1 className="mt-2 text-[16px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
          {item.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {authorName ? (
            <InboxPerson
              name={authorName}
              avatarUrl={inboxPersonAvatarUrl(item.provider, authorName, authorAvatar)}
              size={16}
            />
          ) : null}
          {showAssignment ? (
            extraAssignees.length > 0 ? (
              extraAssignees.map((person) => (
                <InboxPerson
                  key={person.login}
                  name={person.login}
                  avatarUrl={inboxPersonAvatarUrl(item.provider, person.login, person.avatarUrl)}
                  size={16}
                />
              ))
            ) : (
              <span>Unassigned</span>
            )
          ) : null}
          {formatRelativeTime(item.updatedAt) ? (
            <span className="tabular-nums">Updated {formatRelativeTime(item.updatedAt)}</span>
          ) : null}
          {baseRef && headRef ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitCompare className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {baseRef} ← {headRef}
              </span>
            </span>
          ) : null}
        </div>
        {item.labels.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {item.labels.map((label) => (
              <InboxLabel key={label.name} label={label} />
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {onStart && item.kind !== "pr" ? (
            <>
              <Button
                size="sm"
                disabled={starting || (linear && (!startProject || loading || !!error))}
                onClick={() => {
                  if (starting) return;
                  setStarting(true);
                  setStartError(null);
                  const next = linear ? { ...item, projectPath: startProject } : item;
                  void Promise.resolve(onStart(next, linear ? (details?.body ?? "") : undefined))
                    .catch((err: unknown) => {
                      setStartError(err instanceof Error ? err.message : String(err));
                    })
                    .finally(() => setStarting(false));
                }}
              >
                {starting ? <Spinner className="size-3" /> : null}
                Send to agent
              </Button>
              {linear ? (
                <InboxProjectPicker projects={projects} value={startProject} onChange={setStartProject} />
              ) : null}
            </>
          ) : null}
          <Button
            size="sm"
            variant={item.kind === "pr" ? "default" : "ghost"}
            onClick={() => void openUrl(item.url)}
          >
            <ExternalLink />
            {item.kind === "pr" ? "Review on GitHub" : linear ? "Open in Linear" : "Open on GitHub"}
          </Button>
        </div>
        {startError ? <p className="mt-2 text-[12px] text-destructive">{startError}</p> : null}
      </header>
      {isPr ? (
        <Tabs value={tab} onValueChange={(next) => setTab(next as "summary" | "code")}>
          <TabsList
            variant="line"
            aria-label="Pull request sections"
            className="h-9 w-full justify-start gap-4 border-b border-border"
          >
            <TabsTrigger value="summary" className="flex-none">
              Summary
            </TabsTrigger>
            <TabsTrigger value="code" className="flex-none">
              Code
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {isPr && tab === "code" ? (
        diffLoading ? (
          <ParagraphSkeleton />
        ) : diffError ? (
          <p className="text-[12px] text-destructive">{diffError}</p>
        ) : prDiff ? (
          <InboxPrDiff key={`${item.projectPath}:${item.number}:${revision}`} diff={prDiff} />
        ) : (
          <p className="text-[13px] text-muted-foreground">No file changes</p>
        )
      ) : loading ? (
        <ParagraphSkeleton />
      ) : error ? (
        <p className="text-[12px] text-destructive">{error}</p>
      ) : (
        <>
          {details?.body.trim() ? (
            <AgentMarkdown text={details.body} cwd={markdownCwd} />
          ) : (
            <p className="text-[13px] text-muted-foreground">No description</p>
          )}
          <InboxComments
            thread={thread}
            loading={threadLoading}
            error={threadError}
            cwd={markdownCwd}
            provider={item.provider}
            replyMode={linear ? "parent" : "thread"}
            onReply={setReplyTo}
          />
          <InboxCommentForm
            replyTo={replyTo}
            posting={posting}
            error={postError}
            onCancelReply={() => {
              setReplyTo(null);
              setPostError(null);
            }}
            onSubmit={postComment}
          />
        </>
      )}
    </div>
  );
}

/** Three lines of text on their way, the last one shorter. */
function ParagraphSkeleton() {
  return (
    <div aria-label="Loading" className="flex flex-col gap-2">
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-2/3" />
    </div>
  );
}

function InboxPerson({
  name,
  avatarUrl,
  size = 20,
  className = "",
}: {
  name: string;
  avatarUrl?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(!avatarUrl);
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  useEffect(() => {
    setFailed(!avatarUrl);
  }, [avatarUrl]);

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="shrink-0 rounded-full bg-muted object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          aria-hidden
          className="grid shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground"
          style={{
            width: size,
            height: size,
            fontSize: Math.max(9, Math.round(size * 0.45)),
          }}
        >
          {initial}
        </span>
      )}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

function InboxProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: InboxProjectOption[];
  value: string;
  onChange: (path: string) => void;
}) {
  const selected =
    projects.find((project) => sameProjectPath(project.path, value)) ??
    projects[0] ??
    null;
  return (
    <Select
      value={selected?.path ?? null}
      onValueChange={(next) => {
        if (next) onChange(String(next));
      }}
      disabled={projects.length === 0}
    >
      <SelectTrigger size="sm" aria-label="Project" className="max-w-48">
        <SelectValue>
          {() =>
            selected ? (
              <>
                <InboxProjectMark project={selected} />
                <span className="min-w-0 truncate">{selected.name}</span>
              </>
            ) : (
              "Choose project"
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="w-64">
        {projects.map((project) => (
          <SelectItem key={project.path} value={project.path}>
            <InboxProjectMark project={project} />
            <span className="min-w-0 truncate">{project.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InboxLabel({ label }: { label: GithubLabel }) {
  const color = labelColor(label.color);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-muted px-1.5 text-[11px] text-muted-foreground">
      {color ? (
        // The label's own colour is data, not decoration.
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      ) : null}
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  );
}

function labelColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex}`;
}
