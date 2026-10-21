import { fuzzyMatch } from "./fuzzy";
import { projectName } from "./paths";
import { sameProjectPath, type RecentProject } from "./recents";
import {
  HARNESSES,
  sessionDisplayTitle,
  type Block,
  type HarnessId,
  type Session,
} from "./session";
import type {
  SessionSearchHit,
  SessionSummary,
} from "./sessionStore";
import type { RankedFile } from "./fileIndex";
import type { ProjectSearchMatch } from "./search";

export type SearchScope = "all" | "conversations" | "files" | "projects";

/** What a `type:` token names: threads (titles and transcript rows), files
 *  (names and contents), notes, projects. */
export type SearchKind = "thread" | "file" | "note" | "project";
export const SEARCH_KINDS: readonly SearchKind[] = ["thread", "file", "note", "project"];

/** What every hit carries about where it lives: the host (an environment
 *  id; absent when the search knows only this machine). */
type Located = {
  host?: string;
};

export type ConversationHit = Located & {
  id: string;
  kind: "conversation";
  sessionId: string;
  cwd: string;
  harness: HarnessId;
  title: string;
  updatedAt: number;
  score: number;
  positions: number[];
};

export type MessageHit = Located & {
  id: string;
  kind: "message";
  sessionId: string;
  cwd: string;
  harness: HarnessId;
  title: string;
  updatedAt: number;
  /** In-memory hits name the block; server hits name the event row. */
  blockId?: string;
  seq?: number;
  role: string;
  preview: string;
  score: number;
  /** The host's FTS rank (bm25, negative, lower is better) when it had one. */
  rank?: number;
};

/** A file that a paired project holds on more than one host folds into one
 *  row: the row opens on `host`, `alsoOn` names the other copies, and
 *  `newer` says the row's copy won by modification time. */
type Copies = {
  mtime?: number;
  alsoOn?: string[];
  newer?: boolean;
};

export type FileHit = Located &
  Copies & {
    id: string;
    kind: "file";
    path: string;
    relative: string;
    name: string;
    score: number;
    positions: number[];
  };

export type ContentHit = Located &
  Copies & {
    id: string;
    kind: "content";
    path: string;
    relative: string;
    name: string;
    line: number;
    column: number;
    preview: string;
  };

export type NoteHit = Located & {
  id: string;
  kind: "note";
  noteId: string;
  title: string;
  preview: string;
  updatedAt: number;
  cwd?: string;
  score: number;
};

export type ProjectHit = Located & {
  id: string;
  kind: "project";
  path: string;
  name: string;
  score: number;
  positions: number[];
};

export type AppSearchHit =
  | ConversationHit
  | MessageHit
  | FileHit
  | ContentHit
  | NoteHit
  | ProjectHit;

export type GroupedHits = {
  conversations: ConversationHit[];
  messages: MessageHit[];
  files: FileHit[];
  content: ContentHit[];
  notes: NoteHit[];
  projects: ProjectHit[];
};

const ALL_LIMITS: Record<keyof GroupedHits, number> = {
  conversations: 8,
  messages: 8,
  files: 10,
  content: 12,
  notes: 6,
  projects: 6,
};

const NONE: Record<keyof GroupedHits, number> = {
  conversations: 0,
  messages: 0,
  files: 0,
  content: 0,
  notes: 0,
  projects: 0,
};

/** The groups a kind fills, and how many rows each gets when the search is
 *  narrowed to that kind. */
const KIND_LIMITS: Record<SearchKind, Partial<Record<keyof GroupedHits, number>>> = {
  thread: { conversations: 24, messages: 24 },
  file: { files: 40, content: 48 },
  note: { notes: 24 },
  project: { projects: 24 },
};

const SCOPE_KINDS: Record<SearchScope, readonly SearchKind[] | null> = {
  all: null,
  conversations: ["thread"],
  files: ["file"],
  projects: ["project"],
};

/** Row caps per group for a narrowing: every group at its everyday cap
 *  when nothing is narrowed, else the named kinds' groups at their wider
 *  caps and every other group empty. */
export function limitsFor(kinds: readonly SearchKind[] | null): Record<keyof GroupedHits, number> {
  if (!kinds || kinds.length === 0) return ALL_LIMITS;
  const limits = { ...NONE };
  for (const kind of kinds) Object.assign(limits, KIND_LIMITS[kind]);
  return limits;
}

export function kindOf(hit: AppSearchHit): SearchKind {
  switch (hit.kind) {
    case "conversation":
    case "message":
      return "thread";
    case "file":
    case "content":
      return "file";
    case "note":
      return "note";
    default:
      return "project";
  }
}

export function asHarness(value: string): HarnessId {
  return (HARNESSES as string[]).includes(value)
    ? (value as HarnessId)
    : "cursor";
}

export function snippetAround(
  text: string,
  query: string,
  radius = 42,
): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const needle = query.trim().toLowerCase();
  if (!compact) return "";
  if (!needle) {
    return compact.length > radius * 2
      ? `${compact.slice(0, radius * 2)}…`
      : compact;
  }
  const index = compact.toLowerCase().indexOf(needle);
  if (index < 0) {
    return compact.length > radius * 2
      ? `${compact.slice(0, radius * 2)}…`
      : compact;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(compact.length, index + needle.length + radius);
  let snippet = compact.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < compact.length) snippet = `${snippet}…`;
  return snippet;
}

export function searchConversationTitles(
  rows: Array<{
    id: string;
    cwd: string;
    harness: HarnessId;
    title: string;
    updatedAt: number;
  }>,
  query: string,
): ConversationHit[] {
  const needle = query.trim();
  if (!needle) return [];
  const hits: ConversationHit[] = [];
  for (const row of rows) {
    const title = sessionDisplayTitle(row.title, row.harness);
    const displayHit = fuzzyMatch(needle, title);
    const rawHit = displayHit ? null : fuzzyMatch(needle, row.title);
    const match = displayHit ?? rawHit;
    if (!match) continue;
    hits.push({
      id: `conversation:${row.id}`,
      kind: "conversation",
      sessionId: row.id,
      cwd: row.cwd,
      harness: row.harness,
      title,
      updatedAt: row.updatedAt,
      score: match.score + recencyBonus(row.updatedAt),
      positions: displayHit ? match.positions : [],
    });
  }
  return hits.sort(byScoreThenRecency);
}

export function searchSessionMessages(
  sessions: Array<{
    id: string;
    cwd: string;
    harness: HarnessId;
    title: string;
    updatedAt: number;
    blocks: Block[];
  }>,
  query: string,
): MessageHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: MessageHit[] = [];
  for (const session of sessions) {
    const title = sessionDisplayTitle(session.title, session.harness);
    for (const block of session.blocks) {
      if (!isSearchableRole(block.role)) continue;
      const text = blockSearchText(block);
      if (!text.toLowerCase().includes(needle)) continue;
      hits.push({
        id: `message:${session.id}:${block.id}`,
        kind: "message",
        sessionId: session.id,
        cwd: session.cwd,
        harness: session.harness,
        title,
        updatedAt: session.updatedAt,
        blockId: block.id,
        seq: block.seq,
        role: block.role,
        preview: snippetAround(text, query),
        score: 20 + recencyBonus(session.updatedAt),
      });
    }
  }
  return hits.sort(byScoreThenRecency);
}

export function searchRecentProjects(
  recents: RecentProject[],
  query: string,
): ProjectHit[] {
  const needle = query.trim();
  if (!needle) return [];
  const hits: ProjectHit[] = [];
  for (const recent of recents) {
    const name = projectName(recent.path);
    const nameHit = fuzzyMatch(needle, name);
    const pathHit = nameHit ? null : fuzzyMatch(needle, recent.path);
    const match = nameHit ?? pathHit;
    if (!match) continue;
    hits.push({
      id: `project:${recent.path}`,
      kind: "project",
      path: recent.path,
      name,
      score: match.score + (nameHit ? 80 : 0),
      positions: nameHit ? match.positions : [],
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function hitsFromFileRanks(files: RankedFile[]): FileHit[] {
  return files.map((file) => ({
    id: `file:${file.path}`,
    kind: "file",
    path: file.path,
    relative: file.relative,
    name: file.name,
    score: file.score,
    positions: file.positions,
  }));
}

export function hitsFromContentMatches(
  matches: ProjectSearchMatch[],
): ContentHit[] {
  return matches.map((match) => ({
    id: `content:${match.path}:${match.line}:${match.column}`,
    kind: "content",
    path: match.path,
    relative: match.relative,
    name: match.relative.split("/").pop() ?? match.relative,
    line: match.line,
    column: match.column,
    preview: match.preview.trimEnd(),
    ...(match.mtime !== undefined ? { mtime: match.mtime } : {}),
  }));
}

export function hitsFromSessionSearch(
  rows: SessionSearchHit[],
): AppSearchHit[] {
  const hits: AppSearchHit[] = [];
  for (const row of rows) {
    const harness = asHarness(row.harness);
    const title = sessionDisplayTitle(row.title, harness);
    if (row.kind === "conversation") {
      hits.push({
        id: `conversation:${row.sessionId}`,
        kind: "conversation",
        sessionId: row.sessionId,
        cwd: row.cwd,
        harness,
        title,
        updatedAt: row.updatedAt,
        score: 10 + recencyBonus(row.updatedAt),
        positions: [],
      });
      continue;
    }
    if (row.kind !== "message" || (!row.blockId && row.seq === undefined)) continue;
    hits.push({
      id: `message:${row.sessionId}:${row.blockId ?? `seq-${row.seq}`}`,
      kind: "message",
      sessionId: row.sessionId,
      cwd: row.cwd,
      harness,
      title,
      updatedAt: row.updatedAt,
      blockId: row.blockId,
      seq: row.seq,
      role: row.role ?? "assistant",
      preview: row.preview,
      score: 16 + recencyBonus(row.updatedAt),
    });
  }
  return hits;
}

export function conversationRowsFrom(
  history: SessionSummary[],
  sessions: Session[],
): Array<{
  id: string;
  cwd: string;
  harness: HarnessId;
  title: string;
  updatedAt: number;
}> {
  const rows = new Map<
    string,
    {
      id: string;
      cwd: string;
      harness: HarnessId;
      title: string;
      updatedAt: number;
    }
  >();
  for (const row of history) {
    rows.set(row.id, {
      id: row.id,
      cwd: row.cwd,
      harness: row.harness,
      title: row.title,
      updatedAt: row.updatedAt,
    });
  }
  for (const session of sessions) {
    const previous = rows.get(session.id);
    rows.set(session.id, {
      id: session.id,
      cwd: session.cwd,
      harness: session.harness,
      title: session.title,
      updatedAt: previous?.updatedAt ?? Date.now(),
    });
  }
  return [...rows.values()];
}

export function mergeHits(...lists: AppSearchHit[][]): AppSearchHit[] {
  const byId = new Map<string, AppSearchHit>();
  for (const list of lists) {
    for (const hit of list) {
      const existing = byId.get(hit.id);
      if (!existing) {
        byId.set(hit.id, hit);
        continue;
      }
      if (scoreOf(hit) > scoreOf(existing)) byId.set(hit.id, hit);
    }
  }
  return [...byId.values()];
}

export function filterHitsByProject(
  hits: AppSearchHit[],
  cwd: string | undefined,
): AppSearchHit[] {
  if (!cwd || cwd === "~") return hits;
  return hits.filter((hit) => {
    if (hit.kind === "file" || hit.kind === "content") return true;
    if (hit.kind === "project") return sameProjectPath(hit.path, cwd);
    if (hit.kind === "note") return !hit.cwd || sameProjectPath(hit.cwd, cwd);
    return sameProjectPath(hit.cwd, cwd);
  });
}

/** Hits by group, each sorted by one host-neutral rule (score, then
 *  recency or path) and capped for the narrowing: a scope name, a list of
 *  kinds from `type:` tokens, or null for everything. */
export function groupHits(
  hits: AppSearchHit[],
  scope: SearchScope | readonly SearchKind[] | null,
): GroupedHits {
  const grouped: GroupedHits = {
    conversations: [],
    messages: [],
    files: [],
    content: [],
    notes: [],
    projects: [],
  };
  for (const hit of hits) {
    if (hit.kind === "conversation") grouped.conversations.push(hit);
    else if (hit.kind === "message") grouped.messages.push(hit);
    else if (hit.kind === "file") grouped.files.push(hit);
    else if (hit.kind === "content") grouped.content.push(hit);
    else if (hit.kind === "note") grouped.notes.push(hit);
    else grouped.projects.push(hit);
  }
  grouped.conversations.sort(byScoreThenRecency);
  grouped.messages.sort(byScoreThenRecency);
  grouped.files.sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
  grouped.content.sort(
    (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.relative.localeCompare(b.relative) || a.line - b.line,
  );
  grouped.notes.sort(byScoreThenRecency);
  grouped.projects.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const limits = limitsFor(typeof scope === "string" ? SCOPE_KINDS[scope] : scope);
  return {
    conversations: grouped.conversations.slice(0, limits.conversations),
    messages: grouped.messages.slice(0, limits.messages),
    files: grouped.files.slice(0, limits.files),
    content: grouped.content.slice(0, limits.content),
    notes: grouped.notes.slice(0, limits.notes),
    projects: grouped.projects.slice(0, limits.projects),
  };
}

export function flattenGrouped(grouped: GroupedHits): AppSearchHit[] {
  return [
    ...grouped.conversations,
    ...grouped.messages,
    ...grouped.files,
    ...grouped.content,
    ...grouped.notes,
    ...grouped.projects,
  ];
}

export function groupedCount(grouped: GroupedHits): number {
  return flattenGrouped(grouped).length;
}

function isSearchableRole(role: Block["role"]): boolean {
  return role === "user" || role === "assistant" || role === "tool" || role === "plan";
}

function blockSearchText(block: Block): string {
  const parts: string[] = [];
  if (block.text.trim()) parts.push(block.text);
  if (block.tool?.title) parts.push(block.tool.title);
  if (block.tool?.detail) parts.push(block.tool.detail);
  if (block.tool?.preview?.query) parts.push(block.tool.preview.query);
  if (block.tool?.preview?.path) parts.push(block.tool.preview.path);
  if (block.tool?.preview?.output) parts.push(block.tool.preview.output);
  if (block.tool?.preview?.title) parts.push(block.tool.preview.title);
  return parts.join("\n");
}

export function recencyBonus(updatedAt: number): number {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 0;
  const age = Date.now() - updatedAt;
  if (age <= 0) return 24;
  const week = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round(24 * (1 - Math.min(age, week) / week)));
}

function scoreOf(hit: AppSearchHit): number {
  if (hit.kind === "content") return 0;
  return hit.score;
}

function byScoreThenRecency<T extends { score: number; updatedAt: number }>(
  a: T,
  b: T,
): number {
  if (b.score !== a.score) return b.score - a.score;
  return b.updatedAt - a.updatedAt;
}
