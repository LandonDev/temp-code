import type { Block } from "./session";
import { commandPhrases } from "./toolPhrase";

/**
 * What exactly an approval asks for, shaped per tool and never raw JSON:
 * a shell command with its gist, a file edit with the lines it adds, or the
 * request's string fields. Plus the one-line outcome once it is decided.
 */

export type ApprovalDetail =
  | { kind: "shell"; doing: string; command: string }
  | { kind: "file"; path: string; added: string[]; more: boolean }
  | { kind: "fields"; entries: [string, string][] };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const MAX_ADDED = 10;
const MAX_FIELDS = 4;
const FIELD_CHARS = 300;

/** Home dirs read as `~`; a `sh -lc '…'` wrapper and env prefix fall away. */
export function bareCommand(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/^env\s+(?:-u\s+\w+\s+)*/, "");
    while (/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/.test(s)) {
      s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/, "");
    }
    const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/.exec(s);
    if (m) {
      const rest = m[1].trim();
      const q = /^(['"])([\s\S]*)\1$/.exec(rest);
      s = (q ? q[2] : rest).trim();
    }
    if (s === before) break;
  }
  return s.replace(/\/Users\/[^/\s'"]+/g, "~");
}

/** `partialInput` streams in while the model still writes the call (M4); `auto` marks a policy decision (M4). */
type ApprovalTool = NonNullable<Block["tool"]> & { partialInput?: unknown };
type Approval = NonNullable<Block["approval"]> & { auto?: boolean };

function inputOf(block: Block): Record<string, unknown> {
  const tool = block.tool as ApprovalTool | undefined;
  const i = tool?.input ?? tool?.partialInput;
  return i && typeof i === "object" && !Array.isArray(i) ? (i as Record<string, unknown>) : {};
}

function commandOf(input: Record<string, unknown>): string {
  const c = input.command ?? input.cmd;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return str(c);
}

export function approvalDetailOf(block: Block, cwd?: string): ApprovalDetail | null {
  const input = inputOf(block);
  const name = (block.tool?.name ?? "").toLowerCase();
  const command = commandOf(input);
  if (command && (name === "bash" || name === "shell" || name === "local_shell" || name === "exec" || block.tool?.kind === "execute")) {
    const phrases = commandPhrases(command, cwd);
    return {
      kind: "shell",
      doing: phrases.length > 0 ? cap(phrases.slice(0, 2).join(" · ")) : "Run a command",
      command: bareCommand(command),
    };
  }
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (path) {
    const content = str(input.content) || str(input.new_string) || str(input.new_source);
    const lines = content ? content.split("\n") : [];
    return {
      kind: "file",
      path,
      added: lines.slice(0, MAX_ADDED),
      more: lines.length > MAX_ADDED,
    };
  }
  const entries = Object.entries(input)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0)
    .slice(0, MAX_FIELDS)
    .map(([k, v]) => [k, v.slice(0, FIELD_CHARS)] as [string, string]);
  return entries.length > 0 ? { kind: "fields", entries } : null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The decided line: who allowed it, or that a timeout did the denying. */
export function approvalOutcome(approval: Approval | undefined): string | null {
  if (!approval?.decided) return null;
  if (approval.decided === "allow") return "approved";
  return approval.auto ? "denied (timed out)" : "denied";
}
