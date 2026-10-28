import type { Block } from "./session";
import { displayPath, projectName } from "./paths";
import { isLive, isRefused, kindOf, pathOf, runClauses, toolPhrase } from "./toolPhrase";
import { editModel, isEditBlock } from "../surfaces/editModel";
import { splitEditCards } from "../surfaces/editCards";

/**
 * One line for a run of calls, the group line's words: "Created diag.ts,
 * ran a command". Like calls in a row fold into one phrase (reads by folder,
 * edits by verb, commands and searches by count); phrases join with ", ",
 * the first capitalized, at most three, then " and N more". The line names
 * files by basename; each row under it carries the path. Failures are the
 * line's own red figure, never words here.
 */

const MAX_PHRASES = 3;

const trim = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

/** Shared folder of a set of cwd-relative paths, "" at the project root. */
export function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  let shared = dirs[0] ?? [];
  for (const d of dirs.slice(1)) {
    let n = 0;
    while (n < shared.length && n < d.length && shared[n] === d[n]) n++;
    shared = shared.slice(0, n);
  }
  return shared.join("/");
}

/** "Read types.ts", "Read 3 files in src/lib", "Read monocode files". */
export function readsPhrase(paths: string[], cwd: string | undefined, live: boolean): string {
  const verb = live ? "Reading" : "Read";
  const rel = paths.map((p) => displayPath(p, cwd));
  if (rel.length === 1) return `${verb} ${basename(rel[0])}`;
  const inside = cwd ? rel.every((p) => !p.startsWith("/") && !p.startsWith("~")) : false;
  if (!inside) return `${verb} ${rel.length} files`;
  const dir = commonDir(rel);
  return dir ? `${verb} ${rel.length} files in ${dir}` : `${verb} ${projectName(cwd!)} files`;
}

export type EditVerb = "create" | "edit" | "delete";

/**
 * What an edit did to its file. Created only for a file that did not exist
 * before: a Write whose result says it updated the file is an edit.
 */
export function editVerbOf(block: Block): EditVerb {
  const m = editModel(block);
  if (m.remove) return "delete";
  if (m.create && !/has been (updated|overwritten)/i.test(block.tool?.detail ?? "")) return "create";
  return "edit";
}

const EDIT_WORD: Record<EditVerb, [past: string, live: string]> = {
  create: ["Created", "Creating"],
  edit: ["Edited", "Editing"],
  delete: ["Deleted", "Deleting"],
};

/** Each file of a stretch of edits once, by verb in order of first appearance. */
function editsPhrases(edits: { verb: EditVerb; path: string }[], live: boolean): string[] {
  const byVerb = new Map<EditVerb, string[]>();
  for (const { verb, path } of edits) {
    const paths = byVerb.get(verb) ?? [];
    if (!paths.includes(path)) paths.push(path);
    byVerb.set(verb, paths);
  }
  return [...byVerb].map(([verb, paths]) => {
    const word = EDIT_WORD[verb][live ? 1 : 0];
    return paths.length === 1 ? `${word} ${basename(paths[0])}` : `${word} ${paths.length} files`;
  });
}

type Stretch = "read" | "edit" | "run" | "search" | "other";

function stretchOf(block: Block): Stretch {
  const kind = kindOf(block);
  if (kind === "read" && pathOf(block)) return "read";
  if (isEditBlock(block) || ((kind === "edit" || kind === "write" || kind === "patch") && pathOf(block)))
    return "edit";
  if (kind === "run") return "run";
  if (kind === "search" || kind === "glob") return "search";
  return "other";
}

/** The words for a stretch of like calls. */
function stretchPhrases(stretch: Stretch, blocks: Block[], cwd: string | undefined, live: boolean): string[] {
  switch (stretch) {
    case "read":
      return [readsPhrase([...new Set(blocks.map(pathOf))], cwd, live)];
    case "edit":
      return editsPhrases(
        blocks.flatMap((b) =>
          splitEditCards(b).cards.map((card) => ({
            verb: editVerbOf(card),
            path: editModel(card).path || pathOf(b),
          })),
        ),
        live,
      );
    case "run":
      // One clause per command: the line's commas join phrases, never a command's parts.
      if (blocks.length === 1) return [runClauses(blocks[0], cwd, live)[0] ?? `${live ? "Running" : "Ran"} a command`];
      return [`${live ? "Running" : "Ran"} ${blocks.length} commands`];
    case "search":
      if (blocks.length === 1) return [toolPhrase(blocks[0], cwd, live)];
      return [`${live ? "Running" : "Ran"} ${blocks.length} searches`];
    default:
      return blocks.map((b) => toolPhrase(b, cwd, live));
  }
}

/**
 * The group line's phrase. `live` puts every phrase in the present tense;
 * left out, the run is live while any call in it still runs.
 */
export function groupPhrase(blocks: Block[], cwd?: string, live?: boolean): string {
  const all = blocks.filter((b) => b.role === "tool" || b.role === "approval");
  if (all.length === 0) return "";
  const running = live ?? all.some(isLive);
  const phrases: string[] = [];
  const push = (p: string): void => {
    if (p && !phrases.includes(p)) phrases.push(p);
  };
  // A refused call never ran: the words say what ran, and the line's red
  // figure counts the refusals. A run refused whole reads as what it asked
  // to do, each call in its plain verb ("Create notes.txt").
  const tools = all.filter((b) => !isRefused(b));
  if (tools.length === 0) {
    all.forEach((b) => push(toolPhrase(b, cwd, false)));
  }
  let stretch: Stretch | null = null;
  let run: Block[] = [];
  const flush = (): void => {
    if (stretch) stretchPhrases(stretch, run, cwd, running).forEach(push);
    run = [];
  };
  for (const b of tools) {
    const s = stretchOf(b);
    if (s !== stretch || s === "other") {
      flush();
      stretch = s;
    }
    run.push(b);
  }
  flush();
  if (phrases.length === 0) {
    return running ? "Working" : `Ran ${all.length} ${all.length === 1 ? "tool" : "tools"}`;
  }
  const shown = phrases.slice(0, MAX_PHRASES).map((p, i) => trim(i === 0 ? p : lower(p)));
  const extra = phrases.length - MAX_PHRASES;
  return shown.join(", ") + (extra > 0 ? ` and ${extra} more` : "");
}
