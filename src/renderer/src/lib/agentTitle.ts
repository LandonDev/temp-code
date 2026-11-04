import { bareAgentId, cutAtWord } from "@shared/watch";
import { threadMentionsToTitles, useTitlesOf, type TitleOf } from "./threadMentions";

/** The longest title an agent row names in full; past it, cut at a word with "…". */
export const AGENT_TITLE_MAX = 48;

/** How an agent row names its agent: `title` as drawn, `full` for its
 *  tooltip, `named` when it is the agent's own name rather than its task
 *  or the bare fallback (a group phrase quotes only a name). */
export type AgentTitle = { title: string; full: string; named: boolean };

export type AgentTitleSources = {
  titleOf: TitleOf;
  /** The `title` the spawn call gave this agent. */
  inputTitle?: string;
  /** The title a report row stamped (`Block.agent.title`). */
  stamped?: string;
  /** The agent's task, whose first line stands in until a title is known. */
  task?: string;
};

const clean = (text: string | undefined): string => (text ?? "").split("\n")[0].replace(/\s+/g, " ").trim();

/**
 * One rule for every agent row: the store's title for the agent (a
 * cross-host id read by its bare session id), else the spawn call's own
 * title, else the title its report stamped, else its task's first line,
 * else "a subagent".
 */
export function agentTitle(id: string | null | undefined, { titleOf, inputTitle, stamped, task }: AgentTitleSources): AgentTitle {
  const stored = id ? clean(titleOf(bareAgentId(id)) ?? titleOf(id)) : "";
  const name = stored || clean(inputTitle) || clean(stamped);
  const full = name || clean(task ? threadMentionsToTitles(task, titleOf) : "") || "a subagent";
  return { title: cutAtWord(full, AGENT_TITLE_MAX), full, named: !!name };
}

/** `agentTitle`, re-rendering when the agent's title lands in the store. */
export function useAgentTitle(id: string | null | undefined, sources: Omit<AgentTitleSources, "titleOf"> = {}): AgentTitle {
  const titleOf = useTitlesOf(id ? [bareAgentId(id), id] : []);
  return agentTitle(id, { ...sources, titleOf });
}
