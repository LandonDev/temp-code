import type { Block } from "../lib/session";
import { isAppshotPath, isInternalPath, memoryLabel } from "../lib/internalPath";
import { threadMentionsToTitles, type TitleOf } from "../lib/threadMentions";
import { inputOf, toolPathOf } from "../lib/toolDetails";
import { hostOf } from "../lib/threads/researchBoard";
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

const AGENT_VERB: Record<string, string> = {
  spawn_agent: "Spawned",
  send_to_agent: "Messaged",
  wait_for_agent: "Waited for",
  interrupt_agent: "Stopped",
  check_agent: "Checked",
  answer_agent: "Answered",
};

/** The subagent this call is about — input arg, or the spawn result. */
export function agentIdOf(block: Block): string | null {
  const fromInput = str(inputOf(block).agentId);
  if (fromInput) return fromInput;
  const out = block.tool?.detail;
  const m = out ? /"agentId"\s*:\s*"([\w-]+)"/.exec(out) : null;
  return m?.[1] ?? null;
}

export function appView(block: Block, titleOf: TitleOf): AppView | null {
  const name = block.tool?.name ?? "";
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
  if (AGENT_TOOLS.has(short) || short === "Agent" || short === "Task") {
    const id = agentIdOf(block);
    const title = id ? titleOf(id) : undefined;
    const verb = AGENT_VERB[short] ?? "Subagent";
    const task = trim(
      threadMentionsToTitles(str(i.description) || str(i.task) || str(i.prompt) || str(i.message), titleOf),
      48,
    );
    return {
      label: verb,
      detail: title ?? task,
      phrase: `${verb === "Subagent" ? "ran" : verb.toLowerCase()} ${title ? `“${trim(title, 24)}”` : "a subagent"}`,
      threadId: title && id ? id : undefined,
    };
  }
  switch (short) {
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
        label: "New thread",
        detail: [title, type].filter(Boolean).join(" · "),
        phrase: title ? `started thread “${trim(title, 24)}”` : "started a thread",
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
  const ids = [str(i.threadId), agentIdOf(block) ?? ""].filter(Boolean);
  const text = str(i.description) || str(i.task) || str(i.prompt) || str(i.message);
  for (const m of text.matchAll(/@thread:([\w-]{6,})/g)) ids.push(m[1]);
  return Array.from(new Set(ids));
}
