import { useSyncExternalStore } from "react";
import type { Block, HarnessId } from "../lib/session";
import { inputOf } from "../lib/toolDetails";
import { slashCommandStore } from "../lib/tcserver/slashCommands";
import { sessionStore } from "../lib/tcserver/store";
import type { SlashCommand } from "../lib/tcserver/types";
import { AGENT_TOOLS } from "./appTool";

/**
 * What a row's leading mark should be: the connector's brand for an addon
 * call, the provider for a subagent call, else the plain tool icon.
 */

const shortName = (name: string): string => name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");

/** "mcp__linear__create_issue" → "linear". The tool is the last "__"
 *  segment, so a server whose own name carries an underscore (e.g.
 *  "claude_ai_Gmail") still resolves whole. Not an MCP call → null. */
export function mcpServerOf(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const cut = rest.lastIndexOf("__");
  return cut > 0 ? rest.slice(0, cut) : null;
}

export function isAgentCall(block: Block): boolean {
  const short = shortName(block.tool?.name ?? "");
  return AGENT_TOOLS.has(short) || short === "Agent" || short === "Task";
}

/**
 * The provider a subagent call runs on: an in-harness Agent/Task is the
 * harness's own; a fleet call names it in its input, or the spawned
 * session knows.
 */
export function agentProviderOf(block: Block, spawned?: string | null): HarnessId | null {
  if (!isAgentCall(block)) return null;
  const short = shortName(block.tool?.name ?? "");
  if (short === "Agent" || short === "Task") return "claude";
  if (spawned) return spawned as HarnessId;
  const input = inputOf(block);
  const hint = [input.provider, input.model].filter((v) => typeof v === "string").join(" ");
  if (/codex|gpt|openai/i.test(hint)) return "codex";
  if (/cursor|composer/i.test(hint)) return "cursor";
  return "claude";
}

/** `/name` tokens in a user's words, matched against the session's commands. */
const COMMAND_TOKEN = /(^|\s)\/([\w][\w:-]*)/g;

export type CommandPart = { text: string } | { command: SlashCommand };

export function commandParts(text: string, commands: SlashCommand[]): CommandPart[] {
  if (commands.length === 0 || !text.includes("/")) return [{ text }];
  const byName = new Map(commands.map((c) => [c.name.toLowerCase(), c]));
  const parts: CommandPart[] = [];
  let cursor = 0;
  for (const m of text.matchAll(COMMAND_TOKEN)) {
    const command = byName.get(m[2]!.toLowerCase());
    if (!command) continue;
    const start = m.index + m[1]!.length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ command });
    cursor = start + 1 + m[2]!.length;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor) });
  return parts;
}

const EMPTY: SlashCommand[] = [];

/**
 * The commands the composer already fetched for this session's provider
 * and cwd; the transcript reads, never refetches.
 */
export function useKnownCommands(sessionId: string | undefined): SlashCommand[] {
  return useSyncExternalStore(slashCommandStore.subscribe, () => {
    const meta = sessionId ? sessionStore.metaOf(sessionId) : null;
    if (!meta) return EMPTY;
    return slashCommandStore.peek(meta.provider, meta.cwd) ?? EMPTY;
  });
}
