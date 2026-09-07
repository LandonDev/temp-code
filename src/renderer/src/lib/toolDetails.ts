import type { Block } from "./session";
import { kindOf } from "./toolPhrase";
import type { TitleOf } from "./threadMentions";

/**
 * The model behind a tool row's details: what was asked, in the words a
 * person would use, and what came back once the call settled. The
 * inspector reads everything through here so the row itself never has to
 * look at a tool's input.
 */

const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function inputOf(block: Block): Record<string, unknown> {
  return rec(block.tool?.input);
}

/** The file a call names, if any. */
export function toolPathOf(block: Block): string {
  const i = inputOf(block);
  return (
    str(i.file_path) ||
    str(i.path) ||
    str(i.notebook_path) ||
    block.tool?.preview?.path ||
    block.tool?.preview?.fileName ||
    ""
  );
}

/** Drop a `sh -lc '…'` wrapper so a command reads as the model wrote it. */
export function stripShell(raw: string): string {
  let s = raw.trim();
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/.exec(s);
  if (m) {
    const rest = m[1].trim();
    const q = /^(['"])([\s\S]*)\1$/.exec(rest);
    s = (q ? q[2] : rest).trim();
  }
  return s;
}

const commandText = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(" ") : str(v);

/** One line saying what the call asked for, by kind. */
export function invocationBody(block: Block): string {
  const i = inputOf(block);
  switch (kindOf(block)) {
    case "run":
      return stripShell(commandText(i.command));
    case "search":
      return [str(i.pattern), str(i.path) && `in ${str(i.path)}`].filter(Boolean).join(" ");
    case "glob":
      return str(i.pattern);
    case "fetch":
      return str(i.url);
    case "web":
      return str(i.query);
    default:
      return toolPathOf(block);
  }
}

/** Input, verbatim: the command for a shell call, pretty JSON otherwise. */
export function rawInput(block: Block): string {
  const input = block.tool?.input;
  if (kindOf(block) === "run") {
    const c = commandText(rec(input).command);
    if (c) return c;
  }
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Kinds whose input is worth showing as key/value rows rather than one line. */
export function prettyInputKind(block: Block): boolean {
  const k = kindOf(block);
  return k === "mcp" || k === "tool" || k === "patch";
}

/** JSON payload → structured view fodder; undefined when it isn't JSON. */
export function parseJson(text: string): unknown {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export const scalar = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v === null
      ? "—"
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

/** A key that names a thread shows the thread's title in its place. */
export function kvDisplay(key: string, value: unknown, titleOf: TitleOf): string {
  if (/threadid|sessionid/i.test(key) && typeof value === "string") {
    const title = titleOf(value);
    if (title) return title;
  }
  return scalar(value);
}

const SETTLED = new Set(["completed", "success", "failed", "error", "cancelled", "canceled"]);

/** Whether the call has finished, one way or the other. */
export function isSettled(block: Block): boolean {
  if (block.streaming) return false;
  const status = block.tool?.status?.toLowerCase() ?? "";
  if (SETTLED.has(status)) return true;
  return block.approval?.decided === "deny";
}

export type ToolOutput = { text: string; error: boolean };

/**
 * The output pane's text. Output shows only once the call settles: while it
 * runs, `detail` can hold a streaming partial that the row's spinner
 * already stands for, and a pane that grows under a spinner reads as two
 * things happening.
 */
export function toolOutput(block: Block): ToolOutput | undefined {
  if (!isSettled(block)) return undefined;
  const status = block.tool?.status?.toLowerCase() ?? "";
  const error =
    status === "failed" || status === "error" || block.approval?.decided === "deny";
  const text = block.tool?.detail ?? "";
  if (!text && !error) return undefined;
  return { text, error };
}

/** ANSI colour and cursor sequences, gone. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export const OUTPUT_LINE_CAP = 24;

/** The first lines of an output, and how many it left out. */
export function outputLines(text: string): { shown: string[]; more: number } {
  const all = stripAnsi(text).replace(/\n+$/, "").split("\n");
  const shown = all.slice(0, OUTPUT_LINE_CAP);
  return { shown, more: all.length - shown.length };
}

export type TodoItem = { text: string; status: string };

/** Items of a TodoWrite / update_plan call. */
export function todoItems(block: Block): TodoItem[] {
  const i = inputOf(block);
  const raw = i.todos ?? i.plan;
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const r = rec(t);
    return { text: str(r.content) || str(r.step), status: str(r.status) };
  });
}

/** Whether the user asked for the verbatim view of a call, across mounts. */
const rawView = new Map<string, boolean>();
export const getRawView = (key: string): boolean => rawView.get(key) ?? false;
export const setRawView = (key: string, raw: boolean): void => {
  rawView.set(key, raw);
};
