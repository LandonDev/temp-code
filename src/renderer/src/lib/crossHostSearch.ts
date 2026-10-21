import {
  SEARCH_KINDS,
  kindOf,
  mergeHits,
  recencyBonus,
  type AppSearchHit,
  type ContentHit,
  type FileHit,
  type MessageHit,
  type NoteHit,
  type SearchKind,
} from "./appSearch";
import type { Environment } from "./connection/types";
import { projectName } from "./paths";
import { relativeInPair, type ProjectPair } from "./projectPairs";

/**
 * One search over every connected host.
 *
 * The query box takes three filter tokens beside the words: `host:` (a
 * host's name, or `mac` / `box`), `type:` (thread, file, note, project;
 * several with commas) and `project:` (a project's name). The rest is the
 * text every host is asked for. Each host is queried in parallel and its
 * hits land as they come (streaming), with the time it took and whether
 * it was skipped (offline) or failed; the merge gives every hit one score
 * that never looks at which host it came from, and a file that a paired
 * project holds on two hosts (projectPairs.ts) folds into one row that
 * opens on the newer copy and says which host that is.
 */

export type ParsedQuery = {
  /** The words, filter tokens removed, single-spaced. */
  text: string;
  host: string | null;
  types: SearchKind[] | null;
  project: string | null;
};

const FILTER_KEYS = new Set(["host", "type", "project"]);

export function parseSearchQuery(raw: string): ParsedQuery {
  const words: string[] = [];
  let host: string | null = null;
  let project: string | null = null;
  let types: SearchKind[] | null = null;
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    if (!FILTER_KEYS.has(key)) {
      words.push(token);
      continue;
    }
    const value = token.slice(colon + 1);
    // `host:` with nothing after it is a token being typed, not a filter.
    if (!value) continue;
    if (key === "host") host = value.toLowerCase();
    else if (key === "project") project = value.toLowerCase();
    else {
      const picked = value
        .toLowerCase()
        .split(",")
        .map((v) => v.replace(/s$/, ""))
        .filter((v): v is SearchKind => (SEARCH_KINDS as readonly string[]).includes(v));
      if (picked.length > 0) types = [...new Set([...(types ?? []), ...picked])];
    }
  }
  return { text: words.join(" "), host, types, project };
}

/** The hosts a `host:` token names: `mac` is the macOS host (this machine
 *  on a Mac, or a host called so), else any host whose name or id carries
 *  the token. Case-insensitive; an empty list means no host matched. */
export function hostsMatching(
  token: string | null,
  environments: readonly Environment[],
  isMac = false,
): Environment[] {
  if (!token) return [...environments];
  const needle = token.toLowerCase();
  return environments.filter((env) => {
    const name = env.name.toLowerCase();
    if (name.includes(needle) || env.id.toLowerCase() === needle) return true;
    if (needle === "mac" && env.id === "local" && isMac) return true;
    return false;
  });
}

/** Whether a hit belongs to the project a `project:` token names: the
 *  pair's name (both hosts' copies), the folder's own name, or the thread's
 *  project folder. */
export function matchesProject(
  hit: AppSearchHit,
  token: string | null,
  pairs: readonly ProjectPair[],
): boolean {
  if (!token) return true;
  const needle = token.toLowerCase();
  const names: string[] = [];
  const pathOf = hit.kind === "file" || hit.kind === "content" || hit.kind === "project" ? hit.path : hit.cwd;
  if (pathOf) {
    names.push(projectName(pathOf).toLowerCase());
    if (hit.host) {
      const found = relativeInPair(pairs, hit.host, pathOf);
      if (found) names.push(found.pair.name.toLowerCase());
    }
  }
  if (hit.kind === "project") names.push(hit.name.toLowerCase());
  return names.some((name) => name.includes(needle));
}

// ── fan-out ───────────────────────────────────────────────────────────

export type HostState = "searching" | "done" | "skipped" | "failed";

export type HostProgress = {
  environmentId: string;
  name: string;
  state: HostState;
  /** Milliseconds from the start to the host's last answer. */
  elapsedMs: number;
  /** Why it was skipped or failed. */
  detail?: string;
};

export type SearchSnapshot = {
  hits: ReadonlyMap<string, AppSearchHit[]>;
  progress: HostProgress[];
  /** Every host has answered, been skipped or failed. */
  settled: boolean;
};

export type SearchHost = {
  environmentId: string;
  name: string;
  online: boolean;
};

export type RunOptions = {
  hosts: readonly SearchHost[];
  /** The sources to ask one host, each a promise of its hits. */
  sources: (host: SearchHost) => Promise<AppSearchHit[]>[];
  onUpdate: (snapshot: SearchSnapshot) => void;
  now?: () => number;
};

/** Ask every online host in parallel and publish a snapshot after each
 *  answer, so results stream in host by host and source by source. An
 *  offline host is skipped at once; a host whose every source fails is
 *  failed with the first error; one failed source among others is
 *  tolerated. Returns a cancel: nothing is published after it. */
export function runCrossHostSearch(options: RunOptions): () => void {
  const now = options.now ?? (() => performance.now());
  const start = now();
  let cancelled = false;
  const hits = new Map<string, AppSearchHit[]>();
  const progress = new Map<string, HostProgress>();
  const publish = (): void => {
    if (cancelled) return;
    const rows = [...progress.values()];
    options.onUpdate({
      hits: new Map(hits),
      progress: rows,
      settled: rows.every((row) => row.state !== "searching"),
    });
  };
  for (const host of options.hosts) {
    if (!host.online) {
      progress.set(host.environmentId, {
        environmentId: host.environmentId,
        name: host.name,
        state: "skipped",
        elapsedMs: 0,
        detail: "offline",
      });
      continue;
    }
    progress.set(host.environmentId, { environmentId: host.environmentId, name: host.name, state: "searching", elapsedMs: 0 });
    const sources = options.sources(host);
    if (sources.length === 0) {
      progress.set(host.environmentId, { environmentId: host.environmentId, name: host.name, state: "done", elapsedMs: 0 });
      continue;
    }
    let left = sources.length;
    let answered = 0;
    let firstError: string | null = null;
    const collected: AppSearchHit[] = [];
    for (const source of sources) {
      source
        .then((rows) => {
          if (cancelled) return;
          answered += 1;
          collected.push(...rows.map((hit) => ({ ...hit, host: hit.host || host.environmentId })));
          hits.set(host.environmentId, [...collected]);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          firstError ??= error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          if (cancelled) return;
          left -= 1;
          const elapsedMs = Math.max(0, now() - start);
          const done = left === 0;
          progress.set(host.environmentId, {
            environmentId: host.environmentId,
            name: host.name,
            state: !done ? "searching" : answered === 0 && firstError !== null ? "failed" : "done",
            elapsedMs,
            ...(done && answered === 0 && firstError !== null ? { detail: firstError } : {}),
          });
          publish();
        });
    }
  }
  // The first snapshot: the skipped hosts and the searching ones.
  queueMicrotask(publish);
  return () => {
    cancelled = true;
  };
}

// ── merge ─────────────────────────────────────────────────────────────

export type MergeOptions = {
  pairs: readonly ProjectPair[];
  /** Registry order: the tie-break when two copies are equally new. It
   *  decides which copy a row opens, never where the row ranks. */
  hostOrder: readonly string[];
  project?: string | null;
  types?: readonly SearchKind[] | null;
};

/** Every host's hits as one list: duplicates by id folded (mergeHits),
 *  a paired project's file on two hosts folded into one row on the newer
 *  copy, message scores given their match quality from the hosts' ranks,
 *  and the `type:` / `project:` filters applied. Nothing here reads which
 *  host a hit came from to score it. */
export function mergeCrossHost(
  perHost: ReadonlyMap<string, AppSearchHit[]>,
  options: MergeOptions,
): AppSearchHit[] {
  const order = new Map(options.hostOrder.map((id, index) => [id, index] as const));
  const lists = [...perHost.entries()]
    .sort((a, b) => (order.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (order.get(b[0]) ?? Number.MAX_SAFE_INTEGER))
    .map(([, hits]) => hits);
  let merged = mergeHits(...lists);
  merged = scoreMessages(merged);
  merged = dedupePairedFiles(merged, options.pairs);
  if (options.types && options.types.length > 0) {
    const wanted = new Set(options.types);
    merged = merged.filter((hit) => wanted.has(kindOf(hit)));
  }
  if (options.project) merged = merged.filter((hit) => matchesProject(hit, options.project ?? null, options.pairs));
  return merged;
}

/** Message hits scored by match quality and recency alone: the best FTS
 *  rank among the hits is quality 1, a hit the host scanned (no rank) or a
 *  loaded transcript matched in memory sits in the middle. */
export function scoreMessages(hits: AppSearchHit[]): AppSearchHit[] {
  let best = 0;
  for (const hit of hits) {
    if (hit.kind === "message" && typeof hit.rank === "number" && hit.rank < best) best = hit.rank;
  }
  return hits.map((hit) => {
    if (hit.kind !== "message") return hit;
    const quality = typeof hit.rank === "number" && best < 0 ? Math.min(1, hit.rank / best) : 0.5;
    return { ...hit, score: 16 + Math.round(quality * 8) + recencyBonus(hit.updatedAt) };
  });
}

/** A file at the same relative path in two hosts' copies of a paired
 *  project (or the same line of it, for a content hit) is one row: the
 *  copy with the later mtime, else the earliest host in the list, marked
 *  with the hosts it is also on and whether it won by being newer. */
export function dedupePairedFiles(hits: AppSearchHit[], pairs: readonly ProjectPair[]): AppSearchHit[] {
  type Copy = FileHit | ContentHit;
  const groups = new Map<string, Copy[]>();
  const keyed = new Map<Copy, string>();
  for (const hit of hits) {
    if ((hit.kind !== "file" && hit.kind !== "content") || !hit.host) continue;
    const found = relativeInPair(pairs, hit.host, hit.path);
    if (!found || found.pair.members.length < 2) continue;
    const key =
      hit.kind === "content"
        ? `content:${found.pair.id}:${found.relative}:${hit.line}:${hit.column}`
        : `file:${found.pair.id}:${found.relative}`;
    keyed.set(hit, key);
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }
  const winners = new Map<string, Copy>();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    let winner = group[0];
    let newer = false;
    for (const copy of group.slice(1)) {
      if ((copy.mtime ?? -1) > (winner.mtime ?? -1)) {
        winner = copy;
        newer = true;
      } else if ((copy.mtime ?? -1) < (winner.mtime ?? -1)) newer = true;
    }
    const alsoOn = group.filter((copy) => copy !== winner).map((copy) => copy.host!);
    winners.set(key, { ...winner, alsoOn, newer } as Copy);
  }
  const out: AppSearchHit[] = [];
  const emitted = new Set<string>();
  for (const hit of hits) {
    const key = hit.kind === "file" || hit.kind === "content" ? keyed.get(hit) : undefined;
    if (key === undefined || !winners.has(key)) {
      out.push(hit);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(winners.get(key)!);
  }
  return out;
}

// ── per-host hit builders (pure; the surface feeds them the wire rows) ──

export type ThreadMeta = {
  id: string;
  cwd: string;
  harness: MessageHit["harness"];
  title: string;
  updatedAt: number;
};

/** Transcript rows a host found (`session.search`) as message hits, titled
 *  from that host's thread metas; rows of threads the window has loaded
 *  whole are left to the in-memory search so a stream's last row never
 *  repeats its block. */
export function transcriptHits(
  host: string,
  rows: readonly { sessionId: string; seq: number; role: string; snippet: string; ts: number; rank?: number }[],
  metas: ReadonlyMap<string, ThreadMeta>,
  loaded: (sessionId: string) => boolean,
  displayTitle: (title: string, harness: MessageHit["harness"]) => string,
): MessageHit[] {
  const out: MessageHit[] = [];
  for (const row of rows) {
    const meta = metas.get(row.sessionId);
    if (!meta || loaded(meta.id)) continue;
    out.push({
      id: `message:${row.sessionId}:seq-${row.seq}`,
      kind: "message",
      host,
      sessionId: row.sessionId,
      cwd: meta.cwd,
      harness: meta.harness,
      title: displayTitle(meta.title, meta.harness),
      updatedAt: meta.updatedAt,
      seq: row.seq,
      role: row.role,
      preview: row.snippet,
      score: 16,
      ...(typeof row.rank === "number" ? { rank: row.rank } : {}),
    });
  }
  return out;
}

export function noteHits(
  host: string,
  rows: readonly { id: string; title: string; snippet: string; updatedAt: number; sourceCwd?: string }[],
): NoteHit[] {
  return rows.map((row) => ({
    id: `note:${host}:${row.id}`,
    kind: "note",
    host,
    noteId: row.id,
    title: row.title,
    preview: row.snippet,
    updatedAt: row.updatedAt,
    ...(row.sourceCwd ? { cwd: row.sourceCwd } : {}),
    score: 12 + recencyBonus(row.updatedAt),
  }));
}

/** The footer's line for one host: "box: 1.2 s", "mac: skipped (offline)". */
export function hostTimingLabel(row: HostProgress): string {
  if (row.state === "skipped") return `${row.name}: skipped${row.detail ? ` (${row.detail})` : ""}`;
  if (row.state === "failed") return `${row.name}: failed${row.detail ? ` (${row.detail})` : ""}`;
  if (row.state === "searching") return `${row.name}: …`;
  return `${row.name}: ${formatSeconds(row.elapsedMs)}`;
}

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
