import { Folder, MessageSquare, Search, StickyNote } from "../chrome/icons";
import { MatrixSpinner } from "./threads/bits";
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
import { ProjectLogoIcon } from "../chrome/ProjectLogoIcon";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import {
  SEARCH_KINDS,
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
 * Search over every connected host at once. The box takes the words and
 * three filters typed beside them (`host:`, `type:`, `project:`; the hint
 * line under the box names them). Each host answers in parallel and its
 * rows land as they come; the footer says how long each took, or that it
 * was skipped. Rows carry the host's mark when more than one host is
 * paired. Enter opens a row where it lives; ⌘↩ opens it in a new pane.
 * The list never animates: it is read tens of times a day.
 */

type Props = {
  open: boolean;
  cwd: string;
  recents: RecentProject[];
  focusToken?: number;
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
  recents,
  focusToken = 0,
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
    () => hostsMatching(parsed.host, environments, IS_MAC),
    [environments, parsed.host],
  );
  const workspaces = useWorkspaces();
  const pairs = useMemo(() => pairWorkspaces(workspaces), [workspaces]);
  const currentHost = hostOfCwd(cwd);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setSnapshot(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, focusToken]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
    if (hit.kind === "file") (beside ? onOpenFileBeside ?? onOpenFile : onOpenFile)(hit.path);
    else if (hit.kind === "content") {
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
  const failed = progress.length > 0 && progress.every((row) => row.state === "failed" || row.state === "skipped");
  const noResults = !empty && hits.length === 0 && !searching && snapshot !== null;

  return (
    <div
      role="search"
      aria-label="Search"
      data-app-search
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-content/10"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <label className="flex min-w-0 flex-1 items-center gap-2 px-3.5 text-content/50">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
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
            className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none select-text placeholder:text-content/40"
          />
          {searching ? <MatrixSpinner cell={1.5} /> : null}
        </label>
        {!IS_MAC ? <WindowControls /> : null}
      </div>

      <FilterHint parsed={parsed} multiHost={multiHost} askedHosts={askedHosts} />

      <div
        ref={lockOverscroll}
        className={
          empty
            ? "flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-none"
            : "min-h-0 flex-1 overflow-y-auto overscroll-none px-1.5 py-1.5"
        }
      >
        {empty ? (
          <EmptyState multiHost={multiHost} />
        ) : failed && hits.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-danger">
            {progress.find((row) => row.state === "failed")?.detail ?? "No host could be searched"}
          </p>
        ) : noResults ? (
          <p className="px-2 py-1.5 text-[12px] text-content/50">No results</p>
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

      {!empty && progress.length > 0 ? <HostFooter progress={progress} /> : null}
    </div>
  );
}

function isOnline(env: Environment, status: EnvironmentStatus | undefined): boolean {
  // This machine's own server answers on the loopback socket whatever the
  // registry says about it; a saved host is online while its socket is open.
  if (env.id === registry.primaryEnvironmentId) return true;
  return status?.transport === "open";
}

/** The one line of filter chrome: the tokens the box understands, the
 *  active ones in the foreground color. */
export function FilterHint({
  parsed,
  multiHost,
  askedHosts,
}: {
  parsed: ReturnType<typeof parseSearchQuery>;
  multiHost: boolean;
  askedHosts: Environment[];
}) {
  const token = (label: string, value: string | null, placeholder: string) => (
    <span className={value ? "text-content/70" : undefined}>
      {label}:{value ?? placeholder}
    </span>
  );
  const hostValue = parsed.host ? (askedHosts.length > 0 ? askedHosts.map((h) => h.name).join(", ") : `${parsed.host} (no such host)`) : null;
  return (
    <div
      aria-label="Filters"
      className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-b border-content/10 px-3.5 font-mono text-[11px] whitespace-nowrap text-content/40"
    >
      {multiHost ? token("host", hostValue, "mac, box") : null}
      {token("type", parsed.types?.join(",") ?? null, SEARCH_KINDS.join(","))}
      {token("project", parsed.project, "name")}
    </div>
  );
}

/** How long each host took, muted, at the foot; a skipped or failed host says why. */
export function HostFooter({ progress }: { progress: HostProgress[] }) {
  return (
    <div
      aria-label="Hosts searched"
      className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-content/10 px-3.5 font-mono text-[11px] whitespace-nowrap text-content/40 tabular-nums"
    >
      {progress.map((row) => (
        <span key={row.environmentId} data-host-state={row.state}>
          {hostTimingLabel(row)}
        </span>
      ))}
    </div>
  );
}

function EmptyState({ multiHost }: { multiHost: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 pb-24 text-center">
      <Search className="mb-3 size-6 text-content/30" strokeWidth={1.75} />
      <p className="text-[13px] text-content/40">
        {multiHost ? "Find files, chats, notes and projects on every host" : "Find files, chats, notes and projects"}
      </p>
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
          <button
            key={hit.id}
            id={`app-search-hit-${index}`}
            ref={highlighted ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={highlighted}
            data-kind={hit.kind}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onRowEnter(index)}
            onClick={(event) => onOpen(hit, event.metaKey || event.ctrlKey)}
            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none ${
              highlighted ? "bg-content/10 text-content" : "text-content"
            }`}
          >
            <span className="grid size-4 shrink-0 place-items-center">
              {row.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
            {row.meta ? (
              <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-content/40">
                {row.meta}
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
          </button>
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
  const also = alsoOn && alsoOn.length > 0 ? `also on ${alsoOn.join(", ")}` : undefined;
  return (
    <span data-host-mark className="flex shrink-0 items-center gap-1.5 pl-1 text-[11px] text-content/40">
      <HostGlyph environmentId={environmentId} title={also ? `${name} · ${also}` : undefined} />
      {newer ? <span className="text-content/50">newer</span> : null}
    </span>
  );
}

function rowCopy(
  hit: AppSearchHit,
  query: string,
): { icon: ReactNode; title: ReactNode; meta: string } {
  if (hit.kind === "conversation") {
    return {
      icon: <HarnessIcon harness={hit.harness} className="size-3.5" />,
      title: <MatchText text={hit.title} positions={hit.positions} active />,
      meta: projectName(hit.cwd),
    };
  }
  if (hit.kind === "message") {
    const notes = hit.role === "notes";
    return {
      icon: notes ? (
        <StickyNote className="size-3.5 text-content/50" strokeWidth={1.75} />
      ) : (
        <MessageSquare
          className="size-3.5 text-content/50"
          strokeWidth={1.75}
        />
      ),
      title: <MatchText text={hit.preview || hit.title} query={query} />,
      meta: notes ? `Notes · ${hit.title}` : hit.title,
    };
  }
  if (hit.kind === "file") {
    return {
      icon: <FileTypeIcon name={hit.name} isDir={false} size={16} />,
      title: (
        <MatchText text={hit.name} positions={namePositions(hit)} active />
      ),
      meta: hit.relative,
    };
  }
  if (hit.kind === "content") {
    return {
      icon: <FileTypeIcon name={hit.name} isDir={false} size={16} />,
      title: <MatchText text={hit.preview} query={query} />,
      meta: `${hit.relative}:${hit.line}`,
    };
  }
  if (hit.kind === "note") {
    return {
      icon: <StickyNote className="size-3.5 text-content/50" strokeWidth={1.75} />,
      title: <MatchText text={hit.preview || hit.title} query={query} />,
      meta: hit.title,
    };
  }
  return {
    icon: (
      <ProjectLogoIcon
        path={hit.path}
        className="size-3.5 rounded-md"
        fallback={Folder}
      />
    ),
    title: <MatchText text={hit.name} positions={hit.positions} active />,
    meta: prettyCwd(hit.path),
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
