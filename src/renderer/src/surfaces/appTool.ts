import type { Block } from "../lib/session";
import { isAppshotPath, isInternalPath, memoryLabel } from "../lib/internalPath";
import { agentTitle } from "../lib/agentTitle";
import { type TitleOf } from "../lib/threadMentions";
import { bareAgentId } from "@shared/watch";
import { inputOf, toolPathOf } from "../lib/toolDetails";
import { hostOf } from "../lib/threads/researchBoard";
import { isLive } from "../lib/toolPhrase";
import { EDIT_TOOLS } from "./editModel";
import { editPaths } from "./editCards";

/**
 * Calls into the app itself (threads, subagents, memory) read as what they
 * mean — "Read thread “Auth rewrite”", "Updated project memory" — never as
 * raw ids or file paths. A view carries the thread it is about, when it is
 * about one, so the row can link to it.
 */
export type AppView = { label: string; detail: string; phrase: string; threadId?: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortName = (name: string): string => name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");

export const AGENT_TOOLS = new Set([
  "spawn_agent",
  "send_to_agent",
  "check_agent",
  "wait_for_agent",
  "interrupt_agent",
  "answer_agent",
]);

/** Each agent call's verb, settled and live. */
const AGENT_VERB: Record<string, [past: string, live: string]> = {
  spawn_agent: ["Spawned", "Spawning"],
  send_to_agent: ["Messaged", "Messaging"],
  // A wait draws no row of its own (agentSteps.ts); these words are for anything else that reads the call.
  wait_for_agent: ["Waited on", "Waiting on"],
  interrupt_agent: ["Stopped", "Stopping"],
  check_agent: ["Checked", "Checking"],
  answer_agent: ["Answered", "Answering"],
};

/** The subagent this call is about: the child the host stamped on the call, the input arg, or the spawn result. */
export function agentIdOf(block: Block): string | null {
  const spawned = block.tool?.spawned?.[0];
  if (spawned) return spawned;
  const fromInput = str(inputOf(block).agentId);
  if (fromInput) return fromInput;
  const out = block.tool?.detail;
  const m = out ? /"agentId"\s*:\s*"([\w:-]+)"/.exec(out) : null;
  return m?.[1] ?? null;
}

/** `live` speaks in the present ("Waiting for"); left out, the call's own state decides. */
export function appView(block: Block, titleOf: TitleOf, live = isLive(block)): AppView | null {
  const name = block.tool?.name ?? "";
  const tense = (past: string, now: string): string => (live ? now : past);
  const i = inputOf(block);
  if (isAppshotPath(toolPathOf(block))) {
    return { label: "Read", detail: "appshot", phrase: "read the appshot" };
  }
  if (EDIT_TOOLS.has(name)) {
    const paths = editPaths(block);
    if (paths.length && paths.every(isInternalPath)) {
      const what = memoryLabel(paths);
      return { label: "Updated", detail: what, phrase: `updated ${what}` };
    }
    return null;
  }
  const short = shortName(name);
  if (short === "spawn_agent" && Array.isArray(i.agents) && i.agents.length > 1) {
    const n = i.agents.length;
    return { label: tense("Spawned", "Spawning"), detail: `${n} agents`, phrase: `${tense("spawned", "spawning")} ${n} agents` };
  }
  if (AGENT_TOOLS.has(short) || short === "Agent" || short === "Task") {
    const id = agentIdOf(block);
    const words = AGENT_VERB[short];
    const verb = words ? tense(...words) : "Subagent";
    // Only a spawn carries the agent's name and task; any other call names its agent by title alone.
    const builtin = short === "Agent" || short === "Task";
    const spawn = short === "spawn_agent" || builtin;
    const name = agentTitle(id, {
      titleOf,
      inputTitle: spawn ? str(i.title) || (builtin ? str(i.description) : "") : undefined,
      task: spawn ? str(i.task) || str(i.prompt) : undefined,
    });
    return {
      label: verb,
      detail: name.title,
      phrase: `${verb === "Subagent" ? tense("ran", "running") : verb.toLowerCase()} ${name.named ? `“${trim(name.title, 24)}”` : "a subagent"}`,
      threadId: id ?? undefined,
    };
  }
  switch (short) {
    case "update_notes":
      return { label: tense("Updated", "Updating"), detail: "the notes", phrase: `${tense("updated", "updating")} the notes` };
    case "batch_rules":
      return { label: tense("Set", "Setting"), detail: "the batch steps", phrase: `${tense("set", "setting")} the batch steps` };
    case "merge_branch": {
      const branch = str(i.branch);
      return {
        label: tense("Merged", "Merging"),
        detail: branch || "the branch",
        phrase: `${tense("merged", "merging")} ${branch ? trim(branch, 24) : "the branch"}`,
      };
    }
    case "plan_complete":
      return { label: tense("Marked", "Marking"), detail: "the plan complete", phrase: `${tense("marked", "marking")} the plan complete` };
    case "TaskCreate":
      return {
        label: tense("Added a task", "Adding a task"),
        detail: trim(str(i.subject), 48),
        phrase: tense("added a task", "adding a task"),
      };
    case "TaskUpdate":
      return {
        label: tense("Updated a task", "Updating a task"),
        detail: trim(str(i.subject), 48),
        phrase: tense("updated a task", "updating a task"),
      };
    case "list_agents":
      return { label: "Agents", detail: "listed", phrase: "listed the subagents" };
    case "app_list_threads":
      return {
        label: "Threads",
        detail: i.allProjects ? "all projects" : "this project",
        phrase: "listed the threads",
      };
    case "app_read_thread": {
      const id = str(i.threadId);
      const title = titleOf(id);
      return {
        label: "Read thread",
        detail: title ?? id,
        phrase: title ? `read thread “${trim(title, 24)}”` : "read a thread",
        threadId: title ? id : undefined,
      };
    }
    case "app_start_thread": {
      let title = str(i.title);
      const out = block.tool?.detail;
      if (!title && out) {
        try {
          title = str((JSON.parse(out) as { title?: string }).title);
        } catch {
          // a refusal string; the type alone is the detail
        }
      }
      const type = str(i.threadType);
      return {
        label: type ? `New ${type} thread` : "New thread",
        detail: title,
        phrase: `${tense("started", "starting")} ${title ? `thread “${trim(title, 24)}”` : "a thread"}`,
      };
    }
    case "cite_source": {
      const url = str(i.url);
      const where = hostOf(url) || url.split("/").filter(Boolean).pop() || "a source";
      return { label: "Cited", detail: where, phrase: `cited ${where}` };
    }
    case "html_preview":
      return { label: "Previewed", detail: "page", phrase: "previewed a page" };
    case "html_render": {
      const title = str(i.title);
      return {
        label: "Showed page",
        detail: title ? `“${trim(title, 48)}”` : "",
        phrase: title ? `showed page “${trim(title, 24)}”` : "showed a page",
      };
    }
    default:
      return null;
  }
}

/** The thread ids a call's view could name — what a row subscribes to. */
export function appThreadIds(block: Block): string[] {
  const i = inputOf(block);
  const agents = [agentIdOf(block) ?? "", ...(block.tool?.spawned ?? [])].filter(Boolean);
  const ids = [str(i.threadId), ...agents, ...agents.map(bareAgentId)].filter(Boolean);
  const text = str(i.description) || str(i.task) || str(i.prompt) || str(i.message);
  for (const m of text.matchAll(/@thread:([\w-]{6,})/g)) ids.push(m[1]);
  return Array.from(new Set(ids));
}
