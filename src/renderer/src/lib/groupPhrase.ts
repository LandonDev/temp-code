import type { Block } from "./session";
import { displayPath, projectName } from "./paths";
import { isLive, isRefused, kindOf, pathOf, runClauses, shortName, toolPhrase } from "./toolPhrase";
import { editModel, isEditBlock } from "../surfaces/editModel";
import { splitEditCards } from "../surfaces/editCards";
import { agentIdOf, appView } from "../surfaces/appTool";
import { isWaitCall, waitOutcomes } from "../surfaces/agentSteps";
import { bareAgentId } from "@shared/watch";
import type { TitleOf } from "./threadMentions";

/**
 * One line for a run of steps, the group line's words: "Created diag.ts,
 * ran a command", "Spawned “Port the view”, heard from “Port the view”".
 * A wait that returned is heard from the agents it returned on. Like steps in a row fold into one phrase
 * (reads by folder, edits by verb, commands and searches by count, agent
 * calls by agent, reports and finished tasks by count); app calls speak
 * through appView, the host's steps (gate, review, pass, check, hand-off)
 * in their own words. Phrases join with ", ", the first capitalized, at most
 * three, then " and N more". The line names files by basename; each row
 * under it carries the path. Failures are the line's own red figure, never
 * words here.
 */

const MAX_PHRASES = 3;

const trim = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
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

type Stretch = "read" | "edit" | "run" | "search" | "report" | "task" | `app:${string}` | "other";

/** App calls whose stretch folds into one count: the plural, settled and live. */
const COUNTED: Record<string, [past: string, live: string]> = {
  spawn_agent: ["spawned # agents", "spawning # agents"],
  app_start_thread: ["started # threads", "starting # threads"],
  send_to_agent: ["messaged # agents", "messaging # agents"],
  check_agent: ["checked # agents", "checking # agents"],
  answer_agent: ["answered # agents", "answering # agents"],
  interrupt_agent: ["stopped # agents", "stopping # agents"],
  merge_branch: ["merged # branches", "merging # branches"],
  TaskCreate: ["added # tasks", "adding # tasks"],
  TaskUpdate: ["updated # tasks", "updating # tasks"],
};

const noTitles: TitleOf = () => undefined;

function stretchOf(block: Block): Stretch {
  if (isWaitCall(block)) return "report";
  if (block.role === "system") {
    if (block.agent?.status !== undefined) return "report";
    if (block.agent) return "app:spawn_agent";
    if (block.task) return "task";
    return "other";
  }
  const short = shortName(block.tool?.name ?? "");
  if (COUNTED[short]) return `app:${short}`;
  const kind = kindOf(block);
  if (kind === "read" && pathOf(block)) return "read";
  if (isEditBlock(block) || ((kind === "edit" || kind === "write" || kind === "patch") && pathOf(block)))
    return "edit";
  if (kind === "run") return "run";
  if (kind === "search" || kind === "glob") return "search";
  return "other";
}

/** What one stretch step is about, for counting distinct targets: the agent, the branch, else the step itself. */
function targetsOf(block: Block): string[] {
  if (block.role === "system") return [block.agent?.id ?? block.id];
  const short = shortName(block.tool?.name ?? "");
  if (short === "spawn_agent") {
    const agents = (block.tool?.input as { agents?: unknown } | undefined)?.agents;
    const n = Array.isArray(agents) ? Math.max(1, agents.length) : 1;
    return Array.from({ length: n }, (_, i) => `${block.id}:${i}`);
  }
  if (short === "merge_branch") return [String((block.tool?.input as { branch?: unknown } | undefined)?.branch ?? block.id)];
  if (short === "TaskCreate" || short === "TaskUpdate") return [block.id];
  return [agentIdOf(block) ?? block.id];
}

const quoted = (title: string): string => `“${trim(title, 24)}”`;

/** An agent a step heard from: a report's, or one a wait returned on. */
type Heard = { id: string; batch: boolean; title?: string };

function heardOf(block: Block): Heard[] {
  if (isWaitCall(block)) return waitOutcomes(block).map((o) => ({ id: o.id, batch: false }));
  const agent = block.agent;
  return agent ? [{ id: agent.id, batch: !!agent.batch, title: agent.title }] : [];
}

/** A report's words: the agent by title, the master's batch as the batch. */
function heardPhrase(heard: Heard, titleOf: TitleOf): string {
  if (heard.batch) return "heard from the batch";
  const title = titleOf(bareAgentId(heard.id)) || titleOf(heard.id) || heard.title;
  return `heard from ${title ? quoted(title) : "a subagent"}`;
}

const TASK_WORD: Record<NonNullable<Block["task"]>["status"], string> = {
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
};

const REVIEW_WORDS: Record<string, string> = {
  pass: "review passed",
  held: "review held the merge",
  timeout: "review timed out",
  failed: "review failed to run",
  "merged-anyway": "merged anyway",
  skipped: "merged without review",
};

const AWAY_PHRASE = {
  decision: "decided without asking",
  question: "answered for you",
  allowed: "allowed for you",
  approval: "skipped an approval",
} as const;

/** A host step on its own: a gate, a review, a pass, a check, a hand-off, a batch merge. */
function hostPhrase(block: Block): string {
  if (block.gate) {
    const step = block.gate.step;
    return block.gate.ok ? `${step} passed` : `${step} failed on ${block.gate.branch}`;
  }
  if (block.review) return REVIEW_WORDS[block.review.outcome] ?? "reviewed";
  if (block.backgroundCheck) return "checked background tasks";
  if (block.planHandoff) return "started the build";
  if (block.notice?.kind === "batch") return "merged by the batch";
  if (block.notice?.kind === "away") return AWAY_PHRASE[block.notice.away?.kind ?? "decision"];
  if (/^Pass:/.test(block.text)) return "ran the pass";
  return "";
}

/** One step's words in an "other" stretch, or a stretch of one. */
function stepPhrase(block: Block, cwd: string | undefined, live: boolean, titleOf: TitleOf): string {
  if (block.role === "system") {
    if (block.agent?.status !== undefined) return heardPhrase(heardOf(block)[0], titleOf);
    if (block.agent) {
      const title = titleOf(block.agent.id) || block.agent.title;
      return `spawned ${title ? quoted(title) : "a subagent"}`;
    }
    if (block.task) return `${trim(block.task.label, 24)} ${TASK_WORD[block.task.status]}`;
    return hostPhrase(block);
  }
  return appView(block, titleOf, live)?.phrase ?? toolPhrase(block, cwd, live);
}

/** The words for a stretch of like steps. */
function stretchPhrases(
  stretch: Stretch,
  blocks: Block[],
  cwd: string | undefined,
  live: boolean,
  titleOf: TitleOf,
): string[] {
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
    case "report": {
      const heard = blocks.flatMap(heardOf);
      const agents = new Map(heard.filter((h) => !h.batch).map((h) => [h.id, h] as const));
      const out = heard.some((h) => h.batch) ? ["heard from the batch"] : [];
      if (agents.size === 1) out.push(heardPhrase([...agents.values()][0], titleOf));
      else if (agents.size > 1) out.push(`heard from ${agents.size} agents`);
      return out;
    }
    case "task":
      if (blocks.length === 1) return [stepPhrase(blocks[0], cwd, live, titleOf)];
      return [`${blocks.length} tasks finished`];
    case "other":
      return blocks.map((b) => stepPhrase(b, cwd, live, titleOf));
    default: {
      const words = COUNTED[stretch.slice(4)];
      const targets = new Set(blocks.flatMap(targetsOf));
      if (targets.size <= 1 || !words) return blocks.map((b) => stepPhrase(b, cwd, live, titleOf));
      return [words[live ? 1 : 0].replace("#", String(targets.size))];
    }
  }
}

/**
 * The group line's phrase. `live` puts every phrase in the present tense;
 * left out, the run is live while any call in it still runs. `titleOf`
 * names the threads the agent calls and reports are about.
 */
export function groupPhrase(blocks: Block[], cwd?: string, live?: boolean, titleOf: TitleOf = noTitles): string {
  const all = blocks.filter((b) => b.role === "tool" || b.role === "approval");
  const host = blocks.filter((b) => b.role === "system");
  if (all.length === 0 && host.length === 0) return "";
  // A thread the store has not listed (archived, on a host not connected) is named by the report that came back from it.
  const reported = new Map(host.flatMap((b) => (b.agent?.title && !b.agent.batch ? [[b.agent.id, b.agent.title] as const] : [])));
  const known = titleOf;
  titleOf = (id) => known(id) ?? reported.get(id);
  const running = live ?? all.some(isLive);
  const phrases: string[] = [];
  const push = (p: string): void => {
    if (p && !phrases.includes(p)) phrases.push(p);
  };
  // A refused call never ran: the words say what ran, and the line's red
  // figure counts the refusals. A run refused whole reads as what it asked
  // to do, each call in its plain verb ("Create notes.txt").
  const steps = blocks.filter((b) => b.role === "system" || ((b.role === "tool" || b.role === "approval") && !isRefused(b)));
  if (host.length === 0 && steps.length === 0) {
    all.forEach((b) => push(toolPhrase(b, cwd, false)));
  }
  let stretch: Stretch | null = null;
  let run: Block[] = [];
  const flush = (): void => {
    if (stretch) stretchPhrases(stretch, run, cwd, running, titleOf).forEach(push);
    run = [];
  };
  for (const b of steps) {
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
  const shown = phrases.slice(0, MAX_PHRASES).map((p, i) => trim(i === 0 ? cap(p) : lower(p)));
  const extra = phrases.length - MAX_PHRASES;
  return shown.join(", ") + (extra > 0 ? ` and ${extra} more` : "");
}
