import type { ProjectFile } from "./fs";
import { isMarkdownBlockquotePosition } from "./quoteDraft";
import type { SessionMeta, SlashCommand } from "./tcserver/types";

/**
 * The composer's two autocomplete triggers, ported from temp-code's
 * PromptBar: `/` opens the provider's commands, `@` opens files and
 * threads. Pure helpers; the popover and the composer own the state.
 */

export type TriggerMode = "command" | "file";

export type Trigger = {
  mode: TriggerMode;
  query: string;
  /** Offset of the `/` or `@` in the text. */
  start: number;
};

/** The token under the caret, if it triggers autocomplete. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n")) + 1;
  const token = before.slice(start);
  // Skill references work anywhere in the message, any number of them —
  // the server expands every /name token, so the menu opens wherever one
  // is being typed. Paths like src/foo don't trigger: the token has to
  // START with the slash.
  if (token.startsWith("/") && !token.includes("/", 1)) {
    return { mode: "command", query: token.slice(1), start };
  }
  if (token.startsWith("@") && !token.includes("@", 1)) {
    return { mode: "file", query: token.slice(1), start };
  }
  return null;
}

/** Replace the trigger span `[start, caret)` with `inserted` and a space. */
export function replaceTrigger(
  text: string,
  trigger: Pick<Trigger, "start">,
  caret: number,
  inserted: string,
): { text: string; caret: number } {
  const value = `${inserted} `;
  return {
    text: `${text.slice(0, trigger.start)}${value}${text.slice(caret)}`,
    caret: trigger.start + value.length,
  };
}

export const SOURCE_ORDER: SlashCommand["source"][] = ["plugin", "mcp", "skill", "command", "prompt"];

export const SECTION_LABELS: Record<SlashCommand["source"], string> = {
  plugin: "Connectors",
  mcp: "MCP servers",
  skill: "Skills",
  command: "Commands",
  prompt: "Prompts",
};

/** Substring on the name, sectioned by source then alphabetical. */
export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
        a.name.localeCompare(b.name),
    );
}

/** Basename prefix > path prefix > substring; shorter paths win ties. */
export function rankFiles(files: readonly ProjectFile[], query: string, max = 8): ProjectFile[] {
  if (!query) return files.slice(0, max);
  const q = query.toLowerCase();
  const scored: { f: ProjectFile; s: number }[] = [];
  for (const f of files) {
    const lower = f.relative.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const s = base.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (s >= 0) scored.push({ f, s });
    if (scored.length > 400) break;
  }
  return scored
    .sort((a, b) => a.s - b.s || a.f.relative.length - b.f.relative.length)
    .slice(0, max)
    .map((x) => x.f);
}

/** Threads mentionable from this composer: every non-archived root thread
 *  except the current one — current project's first, then the rest, most
 *  recently active first. */
export function rankThreads(
  sessions: readonly SessionMeta[],
  query: string,
  currentId: string | undefined,
  currentProjectId: string | null,
): SessionMeta[] {
  const q = query.toLowerCase();
  return sessions
    .filter(
      (s) =>
        !s.parentId &&
        !s.archived &&
        s.id !== currentId &&
        (!q || s.title.toLowerCase().includes(q)),
    )
    .sort(
      (a, b) =>
        Number(b.projectId === currentProjectId) - Number(a.projectId === currentProjectId) ||
        b.updatedAt - a.updatedAt,
    )
    .slice(0, query ? 5 : 3);
}

const COMMAND_TOKEN_RE =
  /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?)(?=\s|$)/g;

export type CommandTextPart = {
  text: string;
  command?: SlashCommand;
};

/** Split composer text so known `/name` tokens can be painted. */
export function commandTextParts(
  text: string,
  commands: ReadonlyMap<string, SlashCommand>,
): CommandTextPart[] {
  if (!text) return [];
  if (commands.size === 0) return [{ text }];

  const parts: CommandTextPart[] = [];
  const push = (value: string, command?: SlashCommand) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && !last.command && !command) {
      last.text += value;
      return;
    }
    parts.push(command ? { text: value, command } : { text: value });
  };

  COMMAND_TOKEN_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMAND_TOKEN_RE.exec(text))) {
    const name = match[2];
    const start = match.index + (match[1] ?? "").length;
    const command = name ? commands.get(name) : undefined;
    if (!command || isMarkdownBlockquotePosition(text, start)) continue;
    const end = start + 1 + name!.length;
    push(text.slice(cursor, start));
    push(text.slice(start, end), command);
    cursor = end;
  }
  push(text.slice(cursor));
  return parts;
}
