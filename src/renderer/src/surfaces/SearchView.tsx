import { Folder, MessageSquare, Search, StickyNote } from "../chrome/icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { HostGlyph } from "../chrome/HostGlyph";
import { FileTypeIcon } from "../chrome/FileTypeIcon";
import { HarnessIcon } from "../chrome/HarnessIcon";
import { MatchText } from "../chrome/MatchText";
import { SearchFiltersMenu } from "../chrome/SearchFiltersMenu";
import { ProjectLogoIcon } from "../chrome/ProjectLogoIcon";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { GroupInput, InputGroup } from "../components/ui/input";
import { ItemButton } from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import {
  flattenGrouped,
  groupHits,
  hitsFromContentMatches,
  hitsFromFileRanks,
  searchConversationTitles,
  searchRecentProjects,
  searchSessionMessages,
  type AppSearchHit,
} from "../lib/appSearch";
import { registry, useEnvironmentStatuses, useEnvironments } from "../lib/connection";
import type { Environment, EnvironmentStatus } from "../lib/connection/types";
import {
  hostTimingLabel,
  hostsMatching,
  mergeCrossHost,
  noteHits,
  parseSearchQuery,
  runCrossHostSearch,
  setQueryToken,
  transcriptHits,
  type HostProgress,
  type SearchHost,
  type SearchSnapshot,
  type ThreadMeta,
} from "../lib/crossHostSearch";
import {
  loadProjectFiles,
  peekProjectFiles,
  rankProjectFiles,
  recentOpenedFiles,
} from "../lib/fileIndex";
import { listProjectFiles, type ProjectFile } from "../lib/fs";
import { invokeOn } from "../lib/native";
import { prettyCwd, projectName } from "../lib/paths";
import { IS_MAC } from "../lib/platform";
import { pairWorkspaces, partnersOf } from "../lib/projectPairs";
import { looksLikeProject, type RecentProject } from "../lib/recents";
import { searchProject, type OpenFileFn } from "../lib/search";
import { sessionDisplayTitle, type HarnessId } from "../lib/session";
import { loadNotesEnabled } from "../lib/settings";
import { environmentOfCwd, hostOfCwd } from "../lib/tcserver/projects";
import { sessionStore, useServerSessions, useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaces } from "../lib/tcserver/workspaces";

/**
 * Search over every connected host at once. The field takes the words and
 * three filters beside them (`host:`, `type:`, `project:`), typed, or ticked
 * in the field's filter menu, which writes the same tokens. Each host answers in parallel and its
 * rows land as they come; with two or more hosts paired the footer says how
 * long each took, or that it was skipped. Rows carry the host's mark when more than one host is
 * paired. Enter opens a row where it lives; ⌘↩ opens it in a new pane.
 * The list never animates: it is read tens of times a day.
 */

type Props = {
  open: boolean;
  cwd: string;
  /** What the field holds when search opens, e.g. `type:note` from the
   *  Notes command or `type:file` from Find in project. */
  initialQuery?: string;
  recents: RecentProject[];
  focusToken?: number;
  /** The query to open with (Find in project seeds `type:file `). */
  seed?: string | null;
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
  onOpenFile: OpenFileFn;
  /** The same file, in a new editor pane beside the focused one (⌘↩). */
  onOpenFileBeside?: OpenFileFn;
  onOpenSession: (sessionId: string, seq?: number) => void;
  /** The same thread, split beside the focused pane (⌘↩). */
  onOpenSessionBeside?: (sessionId: string, seq?: number) => void;
  onOpenProject: (path: string) => void;
  onOpenNote?: (environmentId: string, noteId: string) => void;
};

const TRANSCRIPT_LIMIT = 200;
const NOTE_LIMIT = 50;
const PARTNER_FILES_TTL_MS = 60_000;

/** A partner host's file list, kept a minute so each keystroke does not re-list. */
const partnerFiles = new Map<string, { at: number; files: Promise<ProjectFile[]> }>();
function partnerFileList(host: string, cwd: string): Promise<ProjectFile[]> {
  const key = `${host}\n${cwd}`;
  const cached = partnerFiles.get(key);
  if (cached && Date.now() - cached.at < PARTNER_FILES_TTL_MS) return cached.files;
  const files = listProjectFiles(host, cwd).catch(() => [] as ProjectFile[]);
  partnerFiles.set(key, { at: Date.now(), files });
  return files;
}

export function SearchView({
  open,
  cwd,
  initialQuery,
  recents,
  focusToken = 0,
  seed = null,
  besideRail = false,
  onClose,
  onToggleSidebar,
  onOpenFile,
  onOpenFileBeside,
  onOpenSession,
  onOpenSessionBeside,
  onOpenProject,
  onOpenNote,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState(() => peekProjectFiles(cwd) ?? []);
  const [snapshot, setSnapshot] = useState<SearchSnapshot | null>(null);

  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const text = parsed.text;

  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const multiHost = environments.length > 1;
  const askedHosts = useMemo(
    () => hostsMatching(parsed.hosts, environments, IS_MAC),
    [environments, parsed.hosts],
  );
  const workspaces = useWorkspaces();
  const pairs = useMemo(() => pairWorkspaces(workspaces), [workspaces]);
  const currentHost = hostOfCwd(cwd);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery?.trim() ? `${initialQuery.trim()} ` : "");
    setActive(0);
    setSnapshot(null);
  }, [initialQuery, open]);

  useEffect(() => {
    if (!open) return;
    if (seed) setQuery(seed);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, focusToken, seed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open menu (the filters) takes its own Escape first.
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!looksLikeProject(cwd)) {
      setFiles([]);
      return;
    }
    const cached = peekProjectFiles(cwd);
    if (cached) setFiles(cached);
    let cancelled = false;
    void loadProjectFiles(cwd).then((next) => {
      if (!cancelled) setFiles(next);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, open]);

  const sessions = useServerSessions();
  const metas = useSessionMetas();

  /** The folder to search for files on each asked host: this project here,
   *  its paired copy there. */
  const fileCwdOf = useCallback(
    (host: string): string | null => {
      if (!looksLikeProject(cwd)) return null;
      if (host === currentHost) return cwd;
      return partnersOf(pairs, currentHost, cwd).find((m) => m.environmentId === host)?.cwd ?? null;
    },
    [cwd, currentHost, pairs],
  );

  // What this window already holds, searched in memory per host: thread
  // titles, the loaded transcripts' blocks, this project's file names and
  // the recent projects. Nothing here waits on a host.
  const memoryHits = useMemo(() => {
    const out = new Map<string, AppSearchHit[]>();
    if (!text) return out;
    for (const env of askedHosts) {
      const host = env.id;
      const rows = metas
        .filter((meta) => meta.environmentId === host && !meta.parentId && !meta.archived)
        .map((meta) => ({ id: meta.id, cwd: meta.cwd, harness: meta.provider as HarnessId, title: meta.title, updatedAt: meta.updatedAt }));
      const hits: AppSearchHit[] = [
        ...searchConversationTitles(rows, text).map((hit) => ({ ...hit, host })),
        ...searchSessionMessages(
          sessions
            .filter((session) => session.environmentId === host)
            .map((session) => ({
              id: session.id,
              cwd: session.cwd,
              harness: session.harness,
              title: session.title,
              updatedAt: Date.now(),
              blocks: session.blocks,
            })),
          text,
        ).map((hit) => ({ ...hit, host })),
      ];
      if (host === currentHost && looksLikeProject(cwd)) {
        hits.push(
          ...hitsFromFileRanks(rankProjectFiles(files, text, recentOpenedFiles(cwd), 40)).map((hit) => ({
            ...hit,
            id: `file:${host}:${hit.path}`,
            host,
          })),
        );
      }
      hits.push(
        ...searchRecentProjects(recents, text)
          .map((hit) => ({ ...hit, host: environmentOfCwd(hit.path) ?? registry.primaryEnvironmentId }))
          .filter((hit) => hit.host === host),
      );
      out.set(host, hits);
    }
    return out;
  }, [askedHosts, currentHost, cwd, files, metas, recents, sessions, text]);

  // Every asked host, in parallel: its transcripts (FTS), its copy of the
  // project (contents, and names when it is not this host's), its notes.
  useEffect(() => {
    if (!open || !text) {
      setSnapshot(null);
      return;
    }
    let cancel: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      const notesOn = loadNotesEnabled();
      const hosts: SearchHost[] = askedHosts.map((env) => ({
        environmentId: env.id,
        name: env.name,
        online: isOnline(env, statuses.get(env.id)),
      }));
      cancel = runCrossHostSearch({
        hosts,
        onUpdate: setSnapshot,
        sources: (host) => {
          const id = host.environmentId;
          const metasById = new Map<string, ThreadMeta>(
            metas
              .filter((meta) => meta.environmentId === id && !meta.parentId)
              .map((meta) => [meta.id, { id: meta.id, cwd: meta.cwd, harness: meta.provider as HarnessId, title: meta.title, updatedAt: meta.updatedAt }]),
          );
          const sources: Promise<AppSearchHit[]>[] = [
            invokeOn<{ hits: Parameters<typeof transcriptHits>[1] }>(id, "search_sessions", { query: text, limit: TRANSCRIPT_LIMIT }).then(
              (result) =>
                transcriptHits(
                  id,
                  result.hits,
                  metasById,
                  (sessionId) => (sessionStore.get(sessionId)?.blocks.length ?? 0) > 0,
                  sessionDisplayTitle,
                ),
            ),
          ];
          const fileCwd = fileCwdOf(id);
          if (fileCwd) {
            sources.push(
              searchProject(id, { cwd: fileCwd, query: text }).then((result) =>
                hitsFromContentMatches(result.matches).map((hit) => ({ ...hit, id: `content:${id}:${hit.path}:${hit.line}:${hit.column}`, host: id })),
              ),
            );
            if (id !== currentHost) {
              sources.push(
                partnerFileList(id, fileCwd).then((list) =>
                  hitsFromFileRanks(rankProjectFiles(list, text, [], 40)).map((hit) => ({ ...hit, id: `file:${id}:${hit.path}`, host: id })),
                ),
              );
            }
          }
          if (notesOn) {
            sources.push(
              invokeOn<{ hits: Parameters<typeof noteHits>[1] }>(id, "notes_search", { query: text, limit: NOTE_LIMIT }).then((result) =>
                noteHits(id, result.hits),
              ),
            );
          }
          return sources;
        },
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      cancel?.();
    };
    // `statuses` changes on every heartbeat; a host's online state is read
    // when the search starts, which the query's debounce already delays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedHosts, currentHost, fileCwdOf, metas, open, text]);

  const hits = useMemo(() => {
    if (!text) return [];
    const combined = new Map<string, AppSearchHit[]>();
    for (const env of askedHosts) {
      combined.set(env.id, [...(memoryHits.get(env.id) ?? []), ...(snapshot?.hits.get(env.id) ?? [])]);
    }
    const merged = mergeCrossHost(combined, {
      pairs,
      hostOrder: environments.map((env) => env.id),
      types: parsed.types,
      project: parsed.project,
    });
    return flattenGrouped(groupHits(merged, parsed.types));
  }, [askedHosts, environments, memoryHits, pairs, parsed.project, parsed.types, snapshot, text]);

  const activeHit = hits[active] ?? null;
  const searching = !!text && snapshot !== null && !snapshot.settled;
  const progress = snapshot?.progress ?? [];

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (active >= hits.length) setActive(0);
  }, [active, hits.length]);

  const openHit = (hit: AppSearchHit | null, beside = false) => {
    if (!hit) return;
    if (hit.kind === "file") {
      const openFile = beside ? onOpenFileBeside ?? onOpenFile : onOpenFile;
      if (hit.line !== undefined) openFile(hit.path, { line: hit.line, column: hit.column ?? 1 });
      else openFile(hit.path);
    } else if (hit.kind === "content") {
      (beside ? onOpenFileBeside ?? onOpenFile : onOpenFile)(hit.path, { line: hit.line, column: hit.column });
    } else if (hit.kind === "message") {
      (beside ? onOpenSessionBeside ?? onOpenSession : onOpenSession)(hit.sessionId, hit.seq);
    } else if (hit.kind === "conversation") {
      (beside ? onOpenSessionBeside ?? onOpenSession : onOpenSession)(hit.sessionId);
    } else if (hit.kind === "note") {
      onOpenNote?.(hit.host ?? registry.primaryEnvironmentId, hit.noteId);
    } else onOpenProject(hit.path);
    onClose();
  };

  const onQueryKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (hits.length === 0) return;
      setActive((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (hits.length === 0) return;
      setActive((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openHit(activeHit, event.metaKey || event.ctrlKey);
    }
  };

  if (!open) return null;

  const empty = !text;
  const noHost = parsed.hosts !== null && askedHosts.length === 0;
  const failed = progress.length > 0 && progress.every((row) => row.state === "failed" || row.state === "skipped");
  const noResults = !empty && hits.length === 0 && !searching && snapshot !== null;
  const filtered = parsed.hosts !== null || parsed.types !== null || parsed.project !== null;
  const focusField = () => inputRef.current?.focus();
  const clearFilters = () => {
    setQuery(setQueryToken(setQueryToken(setQueryToken(query, "host", null), "type", null), "project", null));
    focusField();
  };

  return (
    <div
      role="search"
      aria-label="Search"
      data-app-search
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
          <InputGroup
            className="flex-1"
            leading={<Search />}
            trailing={
              searching ? (
                <Spinner aria-label="Searching" className="me-1.5 size-3.5 text-muted-foreground" />
              ) : null
            }
          >
            <GroupInput
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onQueryKeyDown}
              placeholder={multiHost ? "Search every host…" : "Search everything…"}
              aria-label="Search"
              aria-controls="app-search-results"
              aria-activedescendant={activeHit ? `app-search-hit-${active}` : undefined}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              data-tauri-drag-region="false"
              className="select-text"
            />
          </InputGroup>
          <SearchFiltersMenu
            query={query}
            onQueryChange={setQuery}
            environments={environments}
            cwd={cwd}
            onClosed={focusField}
          />
        </div>
        {!IS_MAC ? <WindowControls /> : null}
      </div>

      <div
        ref={lockOverscroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none px-1.5 py-1.5"
      >
        {empty ? null : noHost ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No host named {parsed.hosts?.join(",")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : failed && hits.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing could be searched</EmptyTitle>
              <EmptyDescription>
                {progress.find((row) => row.state === "failed" || row.state === "skipped")?.detail}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : noResults ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No results</EmptyTitle>
              {filtered ? <EmptyDescription>Filters are narrowing this search</EmptyDescription> : null}
            </EmptyHeader>
            {filtered ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </Empty>
        ) : (
          <ResultList
            hits={hits}
            active={active}
            query={text}
            showHost={multiHost}
            environments={environments}
            onActive={setActive}
            onOpen={openHit}
          />
        )}
      </div>

      {multiHost && !empty && progress.length > 0 ? <HostFooter progress={progress} /> : null}
    </div>
  );
}

function isOnline(env: Environment, status: EnvironmentStatus | undefined): boolean {
  // This machine's own server answers on the loopback socket whatever the
  // registry says about it; a saved host is online while its socket is open.
  if (env.id === registry.primaryEnvironmentId) return true;
  return status?.transport === "open";
}

/** How long each host took, muted, at the foot; a skipped or failed host says why. */
export function HostFooter({ progress }: { progress: HostProgress[] }) {
  return (
    <div
      aria-label="Hosts searched"
      className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border px-3 text-[12px] whitespace-nowrap text-muted-foreground tabular-nums"
    >
      {progress.map((row) => (
        <span
          key={row.environmentId}
          data-host-state={row.state}
          className={row.state === "failed" ? "text-destructive" : undefined}
        >
          {hostTimingLabel(row)}
        </span>
      ))}
    </div>
  );
}

function ResultList({
  hits,
  active,
  query,
  showHost,
  environments,
  onActive,
  onOpen,
}: {
  hits: AppSearchHit[];
  active: number;
  query: string;
  showHost: boolean;
  environments: Environment[];
  onActive: (index: number) => void;
  onOpen: (hit: AppSearchHit, beside?: boolean) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    pointer.current.allow = false;
  }, [hits]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onListMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      event.clientX === pointer.current.x &&
      event.clientY === pointer.current.y
    ) {
      return;
    }
    pointer.current = { x: event.clientX, y: event.clientY, allow: true };
  };

  const onRowEnter = (index: number) => {
    if (!pointer.current.allow) return;
    fromPointer.current = true;
    onActive(index);
  };

  const nameOf = (id: string): string => environments.find((env) => env.id === id)?.name ?? id;

  return (
    <div
      id="app-search-results"
      role="listbox"
      aria-label="Search results"
      onMouseMove={onListMouseMove}
    >
      {hits.map((hit, index) => {
        const highlighted = index === active;
        const row = rowCopy(hit, query);
        return (
          <ItemButton
            key={hit.id}
            ref={highlighted ? activeRef : undefined}
            role="option"
            aria-selected={highlighted}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onRowEnter(index)}
            onClick={(event) => onOpen(hit, event.metaKey || event.ctrlKey)}
            size="xs"
            id={`app-search-hit-${index}`}
            data-kind={hit.kind}
            className={`h-8 flex-nowrap gap-2 rounded-md px-3 py-0 text-left transition-none ${highlighted ? "bg-muted" : ""}`}
          >
            <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
              {row.icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{row.title}</span>
            {row.meta ? (
              <span
                className={`min-w-0 max-w-[45%] truncate text-[12px] text-muted-foreground ${row.mono ? "font-mono" : ""}`}
              >
                {row.meta}
              </span>
            ) : null}
            {(hit.kind === "file" || hit.kind === "content") && hit.more ? (
              <span data-more className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                +{hit.more} more
              </span>
            ) : null}
            {showHost && hit.host ? (
              <HostMark
                environmentId={hit.host}
                name={nameOf(hit.host)}
                newer={hit.kind === "file" || hit.kind === "content" ? hit.newer : undefined}
                alsoOn={hit.kind === "file" || hit.kind === "content" ? hit.alsoOn?.map(nameOf) : undefined}
              />
            ) : null}
          </ItemButton>
        );
      })}
    </div>
  );
}

/** The host's glyph (chrome/HostGlyph.tsx), its name on hover. A file that
 *  two hosts hold says it is the newer copy and names the other on hover. */
export function HostMark({
  environmentId,
  name,
  newer,
  alsoOn,
}: {
  environmentId: string;
  name: string;
  newer?: boolean;
  alsoOn?: string[];
}) {
  const also = alsoOn && alsoOn.length > 0 ? `${name}, also on ${alsoOn.join(", ")}` : undefined;
  return (
    <span data-host-mark className="flex shrink-0 items-center gap-1.5 ps-1 text-[12px] text-muted-foreground">
      <HostGlyph environmentId={environmentId} title={also} />
      {newer ? <span>newer</span> : null}
    </span>
  );
}

type RowCopy = { icon: ReactNode; title: ReactNode; meta: string; mono: boolean };

function rowCopy(hit: AppSearchHit, query: string): RowCopy {
  if (hit.kind === "conversation") {
    return {
      icon: <HarnessIcon harness={hit.harness} className="size-3.5" />,
      title: <MatchText text={hit.title} positions={hit.positions} />,
      meta: projectName(hit.cwd),
      mono: false,
    };
  }
  if (hit.kind === "message") {
    const notes = hit.role === "notes";
    return {
      icon: notes ? <StickyNote className="size-3.5" /> : <MessageSquare className="size-3.5" />,
      title: <MatchText text={hit.preview || hit.title} query={query} />,
      meta: hit.title,
      mono: false,
    };
  }
  if (hit.kind === "file") {
    const slash = hit.relative.lastIndexOf("/");
    const folder = slash > 0 ? hit.relative.slice(0, slash) : "";
    const meta = hit.line === undefined ? folder : folder ? `${folder}:${hit.line}` : `line ${hit.line}`;
    return {
      icon: <FileTypeIcon name={hit.name} isDir={false} size={16} />,
      title: <MatchText text={hit.name} positions={namePositions(hit)} />,
      meta,
      mono: true,
    };
  }
  if (hit.kind === "content") {
    return {
      icon: <FileTypeIcon name={hit.name} isDir={false} size={16} />,
      title: <MatchText text={hit.preview} query={query} />,
      meta: `${hit.relative}:${hit.line}`,
      mono: true,
    };
  }
  if (hit.kind === "note") {
    return {
      icon: <StickyNote className="size-3.5" />,
      title: <MatchText text={hit.preview || hit.title} query={query} />,
      meta: hit.title,
      mono: false,
    };
  }
  return {
    icon: <ProjectLogoIcon path={hit.path} className="size-3.5 rounded-md" fallback={Folder} />,
    title: <MatchText text={hit.name} positions={hit.positions} />,
    meta: prettyCwd(hit.path),
    mono: true,
  };
}

function namePositions(hit: {
  name: string;
  relative: string;
  positions: number[];
}) {
  const offset = Math.max(0, hit.relative.length - hit.name.length);
  return hit.positions
    .map((index) => index - offset)
    .filter((index) => index >= 0 && index < hit.name.length);
}
