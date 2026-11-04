// A8 (action rows): what one action row draws, decided once and tested.
import { addonTitle } from "../../lib/addonNames";
import type { Block } from "../../lib/session";
import { useTitlesOf } from "../../lib/threadMentions";
import { kindOf, sentenceName, toolPhraseParts, type ToolKind } from "../../lib/toolPhrase";
import { inputOf, todoItems } from "../../lib/toolDetails";
import { appThreadIds, appView, type AppView } from "../appTool";
import { editModel, isEditBlock } from "../editModel";
import { isAgentCall, mcpServerOf } from "../toolMarks";
import { needsApproval, toolCallState } from "../transcriptActivity";

/** The glyph a row leads with when it is neither running nor failed. */
export type GlyphKey = ToolKind | "delete" | "app";

/** What a row opens onto: a diff, a command card, the call's details, the file it read, a thread. */
export type ActionOpens = "diff" | "command" | "details" | "file" | "thread" | "none";

export interface Action {
  glyph: GlyphKey;
  verb: string;
  object: string;
  /** The object's full form (a path, a query, a thread title), for the tooltip. */
  title?: string;
  /** The file the row is about, as the call named it. */
  path?: string;
  /** The line the file opens at: the read's offset, the edit's first line. */
  line?: number;
  /** A tally in the counts slot, muted: a todo list's `3/7`. */
  tally?: string;
  adds?: number;
  dels?: number;
  opens: ActionOpens;
  /** The thread an app call names, when the object links to it. */
  threadId?: string;
  /** The connector the call went through, for its mark in place of the icon. */
  connector?: string;
  /** A subagent call: the provider mark leads. */
  agent: boolean;
  failed: boolean;
  running: boolean;
  /** Waiting on the person's approval: the body shows open above Allow and Deny. */
  pending: boolean;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * toolPhrase.ts's stand-in objects, said when a call names nothing: filler,
 * not a target. A row folds them into its verb ("Ran a command"), all muted.
 */
const GENERIC_OBJECTS = new Set(["a command", "a file", "the project", "a page", "the web", "a question"]);

/** Filler folded into the verb, so the row reads the verb alone. A subagent's words are its own. */
function foldFiller(action: Action): Action {
  if (action.agent || !GENERIC_OBJECTS.has(action.object)) return action;
  return { ...action, verb: [action.verb, action.object].filter(Boolean).join(" "), object: "", title: undefined };
}

/** The connector a call went through, when it is not the app itself. */
function connectorOf(block: Block): string | undefined {
  const app = block.tool?.display?.app;
  if (app) return app;
  const server = mcpServerOf(block.tool?.name ?? "");
  return server && server !== "app" ? server : undefined;
}

/**
 * One block → the row's words, glyph, counts and what it opens. Every
 * decision about a row lives here; the components only draw it.
 */
export function actionOf(block: Block, cwd?: string, app: AppView | null = null, live?: boolean): Action {
  return foldFiller(rowAction(block, cwd, app, live));
}

function rowAction(block: Block, cwd: string | undefined, app: AppView | null, live: boolean | undefined): Action {
  const state = toolCallState(block);
  const pending = needsApproval(block);
  const failed = state === "rejected";
  const running = state === "pending" && !pending;
  const kind = kindOf(block);
  const deleting = block.tool?.kind?.trim().toLowerCase() === "delete";
  const parts = toolPhraseParts(block, cwd, live);
  const connector = connectorOf(block);
  const display = block.tool?.display;
  const base: Action = {
    glyph: deleting ? "delete" : kind,
    verb: parts.verb,
    object: parts.object,
    title: parts.title,
    opens: block.tool ? "details" : "none",
    connector,
    agent: isAgentCall(block),
    failed,
    running,
    pending,
  };

  if (block.question) return { ...base, opens: "none" };

  if (display?.app) {
    return {
      ...base,
      verb: addonTitle(display.app),
      object: display.action ?? "",
      title: display.action,
    };
  }

  if (app) {
    return {
      ...base,
      glyph: "app",
      verb: app.label,
      object: app.detail,
      title: app.detail,
      opens: "details",
      threadId: app.threadId,
    };
  }

  // A connector's call reads as the connector doing it: "Cosmic Admin  Build get".
  // The spinner says it is live, so the verb keeps no tense.
  const server = mcpServerOf(block.tool?.name ?? "");
  if (connector && server && server !== "orchestrator" && !base.agent) {
    const object = sentenceName(block.tool?.name ?? "");
    return { ...base, verb: addonTitle(connector), object, title: object };
  }

  if (isEditBlock(block)) {
    const m = editModel(block);
    const startLine = block.tool?.preview?.startLine;
    return {
      ...base,
      glyph: m.remove ? "delete" : m.create && parts.verb.startsWith("Creat") ? "write" : kind === "patch" ? "patch" : "edit",
      path: m.path || undefined,
      line: startLine && startLine > 0 ? startLine : undefined,
      adds: m.adds,
      dels: m.dels,
      opens: "diff",
    };
  }

  if (kind === "run") return { ...base, opens: "command" };

  if (kind === "todo") {
    // The row says how far the list is, as a count: "Updated todos  3/7"; its body is the list.
    const items = todoItems(block);
    const done = items.filter((t) => t.status === "completed").length;
    return items.length ? { ...base, object: "", tally: `${done}/${items.length}` } : base;
  }

  if (kind === "read" || kind === "list") {
    const i = inputOf(block);
    const path =
      (typeof i.file_path === "string" && i.file_path) ||
      (typeof i.path === "string" && i.path) ||
      block.tool?.preview?.path ||
      "";
    // A failed read keeps its error, a waiting one what it asks: both open their details.
    if (!path || failed || pending) return { ...base, path: path || undefined };
    // Claude's Read offset is the 1-based line it starts at.
    const offset = num(i.offset);
    const startLine = block.tool?.preview?.startLine;
    const line = offset && offset > 0 ? offset : startLine && startLine > 0 ? startLine : undefined;
    return { ...base, path, line, opens: "file" };
  }

  return base;
}

/** The row's action, kept current as the titles of the threads it names arrive. */
export function useAction(block: Block, cwd?: string, live?: boolean): Action {
  const titleOf = useTitlesOf(appThreadIds(block));
  return actionOf(block, cwd, appView(block, titleOf, live), live);
}
