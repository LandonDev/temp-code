import type { Block } from "./session";
import { displayPath } from "./paths";

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

/**
 * Plain words for a tool call: "Read src/lib/paths.ts", "Searched for
 * toolCallLabel", "Ran the tests", "Used Create Thread". The row comes from here;
 * the group line builds on it (lib/groupPhrase.ts). Raw tool names, JSON and
 * provider names never make it into the line; the body keeps the detail.
 */

export type ToolKind =
  | "run"
  | "read"
  | "write"
  | "edit"
  | "patch"
  | "search"
  | "glob"
  | "fetch"
  | "web"
  | "todo"
  | "list"
  | "question"
  | "skill"
  | "mcp"
  | "tool";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const trim = (s: string, n = 40): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function inputOf(block: Block): Record<string, unknown> {
  const i = block.tool?.input;
  return i && typeof i === "object" && !Array.isArray(i)
    ? (i as Record<string, unknown>)
    : {};
}

/** "mcp__orchestrator__spawn_agent" → "spawn_agent"; "linear.save" → "save". */
export function shortName(name: string): string {
  if (name.startsWith("mcp__")) return last(name.split("__")) || name;
  if (name.includes(".")) return last(name.split(".")) || name;
  return name;
}

const NAME_KIND: Record<string, ToolKind> = {
  Bash: "run",
  shell: "run",
  Shell: "run",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  apply_patch: "patch",
  Grep: "search",
  Glob: "glob",
  LS: "list",
  WebFetch: "fetch",
  WebSearch: "web",
  web_search: "web",
  TodoWrite: "todo",
  update_plan: "todo",
  AskUserQuestion: "question",
  Skill: "skill",
};

/** Human names for the app's own tools; anything else title-cases its short name. */
const APP_TOOL: Record<string, string> = {
  app_start_thread: "Create Thread",
  app_list_threads: "List Threads",
  app_read_thread: "Read Thread",
  spawn_agent: "Spawn Agent",
  send_to_agent: "Message Agent",
  wait_for_agent: "Wait For Agent",
  check_agent: "Check Agent",
  answer_agent: "Answer Agent",
  interrupt_agent: "Interrupt Agent",
  list_agents: "List Agents",
  AskUserQuestion: "Ask User",
  Task: "Agent",
  Agent: "Agent",
  EnterPlanMode: "Plan Mode",
  ExitPlanMode: "Exit Plan Mode",
};

export function kindOf(block: Block): ToolKind {
  const name = block.tool?.name;
  if (name) {
    const known = NAME_KIND[name];
    if (known) return known;
    if (name.startsWith("mcp__") || name.includes(".")) return "mcp";
  }
  const kind = block.tool?.kind?.trim().toLowerCase() ?? "";
  const preview = block.tool?.preview;
  const title = (block.text || block.tool?.title || "").trim();
  if (kind === "question") return "question";
  if (kind === "skill") return "skill";
  if (kind === "fetch") return "fetch";
  if (kind === "search" || preview?.kind === "search") return "search";
  if (kind === "read" || preview?.kind === "read") return "read";
  if (kind === "write" || /^(wrote|writ(e|ing)|creat(e|ed|ing))\b/i.test(title))
    return "write";
  if (["edit", "delete", "move"].includes(kind) || preview?.kind === "write")
    return "edit";
  if (["execute", "shell", "bash"].includes(kind) || preview?.kind === "shell")
    return "run";
  if (kind === "other" || !kind) {
    if (/^(edit|updat)/i.test(title)) return "edit";
    if (/^read\b/i.test(title)) return "read";
    if (/^(find|search|grep|glob)/i.test(title)) return "search";
    if (/^(bash|shell|run)/i.test(title)) return "run";
  }
  return "tool";
}

/** "AskUserQuestion" → "Ask User Question", "list_agents" → "List Agents". */
export function humanName(name: string): string {
  const short = shortName(name);
  return (
    APP_TOOL[short] ??
    short
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(" ")
      .filter(Boolean)
      .map(cap)
      .join(" ")
  );
}

/** The file a call names, from its input or the server's preview. */
export function pathOf(block: Block): string {
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

function queryOf(block: Block): string {
  const i = inputOf(block);
  return str(i.pattern) || str(i.query) || block.tool?.preview?.query || "";
}

function commandOf(block: Block): string {
  const i = inputOf(block);
  const c = i.command;
  if (Array.isArray(c)) return c.map(String).join(" ");
  if (typeof c === "string") return c;
  const title = (block.text || block.tool?.title || "").trim();
  return title.replace(/^(bash|shell|run(?:ning)?(?:\s+command)?)\b[:\s]*/i, "");
}

/** Still running, streaming or waiting on a decision. */
/** A call the person (or the host for them) denied: it never ran, so its words keep the plain verb. */
export function isRefused(block: Block): boolean {
  return block.approval?.decided === "deny";
}

/** The settled verbs a refused call takes back to their plain form: "Created" → "Create". */
const PLAIN: Record<string, string> = {
  ran: "run",
  read: "read",
  wrote: "write",
  created: "create",
  edited: "edit",
  deleted: "delete",
  searched: "search",
  listed: "list",
  fetched: "fetch",
  updated: "update",
  asked: "ask",
  used: "use",
};

/** The phrase's first word in its plain form, its capital kept. */
function plainForm(verb: string): string {
  const [first, ...rest] = verb.split(" ");
  const plain = PLAIN[first.toLowerCase()];
  if (!plain) return verb;
  const head = first.charAt(0) === first.charAt(0).toUpperCase() ? cap(plain) : plain;
  return [head, ...rest].join(" ");
}

export function isLive(block: Block): boolean {
  const status = block.tool?.status?.toLowerCase() ?? "";
  return (
    !!block.streaming ||
    (!!block.approval && !block.approval.decided) ||
    status === "running" ||
    status === "pending" ||
    status === "in_progress"
  );
}

/** Drop a `sh -lc '…'` wrapper and leading env assignments. */
function unwrap(raw: string): string {
  let s = raw.trim();
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/.exec(s);
  if (m) {
    const rest = m[1].trim();
    const q = /^(['"])([\s\S]*)\1$/.exec(rest);
    s = (q ? q[2] : rest).trim();
  }
  return s;
}

/** Split on top-level `&&`, `||`, `|`, `;` and newlines, quote-aware. */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
    } else if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) {
      // A redirect (`2>&1`, `&>out`), not a separator.
      cur += c;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (s: string): string => s.replace(/^['"`]|['"`]$/g, "");
const base = (p: string): string =>
  unquote(p).replace(/\/+$/, "").split("/").pop() || p;

const PAST: Record<string, string> = {
  check: "checked",
  read: "read",
  view: "viewed",
  list: "listed",
  find: "found",
  search: "searched",
  count: "counted",
  run: "ran",
  build: "built",
  typecheck: "typechecked",
  install: "installed",
  fetch: "fetched",
  create: "created",
  delete: "deleted",
  copy: "copied",
  move: "moved",
  write: "wrote",
  stage: "staged",
  commit: "committed",
  push: "pushed",
  sync: "synced",
  switch: "switched",
  stash: "stashed",
  show: "showed",
  update: "updated",
  start: "started",
  stop: "stopped",
  kill: "killed",
  test: "tested",
  open: "opened",
  wait: "waited",
  compare: "compared",
  print: "printed",
  change: "changed",
  add: "added",
  remove: "removed",
  make: "made",
  format: "formatted",
  lint: "linted",
  query: "queried",
  manage: "managed",
};

const ING: Record<string, string> = {
  run: "running",
  write: "writing",
  stop: "stopping",
  commit: "committing",
  stash: "stashing",
  make: "making",
  create: "creating",
  delete: "deleting",
  update: "updating",
  remove: "removing",
  change: "changing",
  compare: "comparing",
  move: "moving",
  stage: "staging",
  query: "querying",
  format: "formatting",
  manage: "managing",
};

/** "check git status" → "checked git status" / "checking git status". */
function tense(p: string, live: boolean): string {
  const [first, ...rest] = p.split(" ");
  const w = first.toLowerCase();
  const verb = live
    ? (ING[w] ?? (PAST[w] ? `${w.replace(/e$/, "")}ing` : w))
    : (PAST[w] ?? w);
  return [verb, ...rest].join(" ");
}

/** `> file` and `>> file`; not a descriptor (`2>&1`) or stderr alone (`2> x`). */
const FILE_REDIRECT = /(?<![\d&])>>?\s*([^&\s]\S*)/;

/** One shell segment → a present-tense phrase, or null for pipe noise. */
function segmentPhrase(seg: string, cwd?: string): string | null {
  const words = seg.split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === "env")) i++;
  if (words[i] === "sudo" || words[i] === "xargs") i++;
  const cmd = base(words[i] ?? "");
  const args = words.slice(i + 1);
  const plain = args.filter((a) => !a.startsWith("-") && !/^\d*[<>]/.test(a) && !a.includes(">"));
  const file = plain[0];
  const rel = (p: string): string => displayPath(unquote(p), cwd);
  const sub = plain[0] ?? "";
  switch (cmd) {
    case "cd":
    case "pwd":
    case "true":
    case "exit":
    case "export":
    case "setopt":
    case "awk":
    case "sort":
    case "uniq":
    case "cut":
    case "tr":
    case "jq":
    case "tee":
    case "xargs":
      return null;
    case "grep":
    case "rg":
    case "ag": {
      const pat = plain[0];
      return pat ? `search for ${trim(unquote(pat), 24)}` : null;
    }
    case "head":
    case "tail":
    case "cat":
    case "less":
    case "bat":
    case "more":
      return file ? `read ${rel(file)}` : null;
    case "sed": {
      const f = last(plain.filter((a) => !/^['"]?[\d,$]+p['"]?$/.test(a)));
      return /-n/.test(seg) && f && !f.includes("s/") ? `read ${rel(f)}` : null;
    }
    case "wc":
      return file ? `count lines in ${rel(file)}` : null;
    case "ls":
    case "tree":
      return file ? `list ${rel(file)}` : "list files";
    case "find":
    case "fd":
      return "find files";
    case "git":
      switch (sub) {
        case "status": return "check git status";
        case "log": return "read git history";
        case "diff": return "view the diff";
        case "add": return "stage changes";
        case "commit": return "commit";
        case "push": return "push";
        case "pull":
        case "fetch": return "sync with the remote";
        case "checkout":
        case "switch": return "switch branches";
        case "branch": return "list branches";
        case "stash": return "stash changes";
        case "show": return "show a commit";
        case "worktree": return "manage worktrees";
        default: return sub ? `run git ${sub}` : "run git";
      }
    case "npm":
    case "pnpm":
    case "bun":
    case "yarn":
      if (sub === "test" || sub === "t") return "run the tests";
      if (sub === "install" || sub === "i" || sub === "ci" || sub === "add") return "install dependencies";
      if (sub === "run") return `run ${cmd} run ${plain[1] ?? ""}`.trim();
      return sub ? `run ${cmd} ${sub}` : `run ${cmd}`;
    case "npx":
    case "bunx":
      // The package is the command: "npx convex dev" reads as "convex dev" would.
      return sub ? segmentPhrase(words.slice(i + 1).filter((w) => !w.startsWith("-")).join(" "), cwd) : `run ${cmd}`;
    case "cargo":
    case "go":
    case "mvn":
    case "gradle":
    case "gradlew":
      if (sub === "test" || /test/.test(sub)) return "run the tests";
      if (["build", "compile", "package", "install"].includes(sub)) return "build the project";
      return sub ? `run ${cmd} ${sub}` : `run ${cmd}`;
    case "vitest":
    case "jest":
    case "pytest":
      return "run the tests";
    case "tsc":
      return "typecheck";
    case "eslint":
      return "lint";
    case "prettier":
      return "format code";
    case "make":
      return sub ? `make ${sub}` : "run make";
    case "python":
    case "python3":
    case "node":
    case "ruby":
    case "perl":
      if (args.includes("-c") || args.includes("-e")) return `run a ${cmd.startsWith("python") ? "Python" : cmd === "node" ? "JS" : cmd} snippet`;
      return file ? `run ${base(file)}` : `run ${cmd}`;
    case "curl":
    case "wget": {
      const url = args.find((a) => /^https?:\/\//.test(unquote(a)));
      try {
        return url ? `fetch ${new URL(unquote(url)).hostname}` : "fetch a URL";
      } catch {
        return "fetch a URL";
      }
    }
    case "mkdir":
      return "create a folder";
    case "touch":
      return file ? `create ${rel(file)}` : "create a file";
    case "rm":
      return file ? `delete ${rel(file)}` : "delete files";
    case "cp":
    case "rsync":
      return file ? `copy ${base(file)}` : "copy files";
    case "mv":
      return file ? `move ${base(file)}` : "move files";
    case "chmod":
    case "chown":
      return "change permissions";
    case "echo":
    case "printf": {
      const redirect = FILE_REDIRECT.exec(seg);
      return redirect ? `write ${rel(redirect[1])}` : null;
    }
    case "open":
      return file ? `open ${base(file)}` : "open something";
    case "sleep":
      return "wait";
    case "kill":
    case "pkill":
    case "killall":
      return "stop a process";
    case "ps":
    case "pgrep":
    case "lsof":
      return "check running processes";
    case "diff":
      return "compare files";
    case "which":
    case "command":
    case "type":
      return `check for ${base(last(plain) ?? "a tool")}`;
    case "gh":
    case "docker":
      return sub ? `run ${cmd} ${sub}` : `run ${cmd}`;
    default: {
      const out = FILE_REDIRECT.exec(seg);
      if (out) return `write ${rel(out[1])}`;
      return cmd ? `run ${cmd}${/^[a-z][\w:-]*$/i.test(sub) ? ` ${sub}` : ""}` : null;
    }
  }
}

/** The command's gist: up to two distinct phrases, present tense. */
export function commandPhrases(raw: string, cwd?: string): string[] {
  const out: string[] = [];
  for (const seg of segments(unwrap(raw))) {
    let p = segmentPhrase(seg, cwd);
    // "Ran bun run typecheck" says nothing the command card does not.
    if (p?.startsWith("run ") && echoesCommand(p.slice(4), seg)) p = "run a command";
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The words are the segment's own leading words, as typed. */
function echoesCommand(words: string, seg: string): boolean {
  const typed = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== "env" && w !== "sudo");
  const said = words.split(" ");
  return said.length <= typed.length && said.every((w, n) => w === (n === 0 ? base(typed[0]) : unquote(typed[n])));
}

/** A title the fold already turned into "Read x" / "Find x", for a call with no command. */
function foldedTitle(block: Block): RegExpExecArray | null {
  if (str(inputOf(block).description).trim() || inputOf(block).command !== undefined) return null;
  const title = (block.text || block.tool?.title || "").trim();
  return /^(Read|Find|List|Edit|Write|Delete|Move|Fetch|Create)\s+(.+)$/.exec(title);
}

/**
 * A run call's words as clauses, the first capitalized: a description or a
 * folded title is one clause, a command one per distinct segment ("Checked
 * git status", "ran the tests"). Empty when nothing can be said. The row
 * joins the first two; the group line (lib/groupPhrase.ts) keeps the first.
 */
export function runClauses(block: Block, cwd?: string, live = isLive(block)): string[] {
  // A refused command never ran: its clauses keep the plain verb ("Create empty file x.txt").
  const form = (p: string): string => (!live && isRefused(block) ? p : tense(p, live));
  const desc = str(inputOf(block).description).trim();
  if (desc) return [cap(form(trim(desc.charAt(0).toLowerCase() + desc.slice(1), 60)))];
  const m = foldedTitle(block);
  if (m) return [`${cap(form(m[1] === "Find" ? "search for" : m[1].toLowerCase()))} ${m[2]}`];
  return commandPhrases(commandOf(block), cwd).map((p, i) => (i === 0 ? cap(form(p)) : form(p)));
}

/** The run row's words: a description or the command's gist, split at the verb. */
function runParts(block: Block, cwd: string | undefined, live: boolean): PhraseParts {
  const refused = !live && isRefused(block);
  const m = foldedTitle(block);
  if (m) {
    const verb = m[1] === "Find" ? "search for" : m[1].toLowerCase();
    return { verb: cap(refused ? verb : tense(verb, live)), object: m[2] };
  }
  const clauses = runClauses(block, cwd, live);
  if (clauses.length === 0) return { verb: live ? "Running" : refused ? "Run" : "Ran", object: "a command" };
  const extra = clauses.length - 2;
  return splitVerb(clauses.slice(0, 2).join(", ") + (extra > 0 ? ` and ${extra} more` : ""));
}

/** "Ran the tests" → verb "Ran", object "the tests"; the phrase's first word. */
function splitVerb(phrase: string): PhraseParts {
  const at = phrase.indexOf(" ");
  if (at < 0) return { verb: phrase, object: "" };
  return { verb: phrase.slice(0, at), object: phrase.slice(at + 1) };
}

type PatchFile = { path: string; op: "add" | "update" | "delete" };

/** The files a patch touches and what it does to each: the server's change
 *  array (codex), else the raw patch text's headers, else the named path. */
function patchFiles(block: Block): PatchFile[] {
  const input = block.tool?.input;
  if (Array.isArray(input)) {
    return input.flatMap((c) => {
      const change = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
      const kind = change.kind && typeof change.kind === "object" ? (change.kind as Record<string, unknown>) : {};
      const type = str(kind.type);
      const path = str(change.path);
      return path ? [{ path, op: type === "add" ? "add" : type === "delete" ? "delete" : "update" } as PatchFile] : [];
    });
  }
  const raw = typeof input === "string" ? input : str(inputOf(block).input) || str(inputOf(block).patch);
  const found = [...raw.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map(
    (m) => ({ path: m[2].trim(), op: m[1].toLowerCase() }) as PatchFile,
  );
  if (found.length) return found;
  const p = pathOf(block);
  return p ? [{ path: p, op: "update" }] : [];
}

/** A file call's object: the basename, the shown path in `title`. */
function fileParts(verb: string, path: string, cwd?: string): PhraseParts {
  if (!path) return { verb, object: "a file" };
  const title = displayPath(path, cwd);
  return { verb, object: base(path), title };
}

/** A call's words split for the row: verb muted, object in foreground. */
export interface PhraseParts {
  verb: string;
  object: string;
  /** The object's full form (the shown path), for the tooltip. */
  title?: string;
}

/**
 * The words for one call, split at the verb: "Read" + "paths.ts", "Searched
 * for" + "toolCallLabel", "Ran" + "the tests". Empty verb when nothing can
 * be said.
 */
export function toolPhraseParts(block: Block, cwd?: string, live = isLive(block)): PhraseParts {
  const parts = settledParts(block, cwd, live);
  // A refused call never ran: "Create notes.txt", not "Created notes.txt" (a run's clauses are already plain).
  return !live && isRefused(block) && kindOf(block) !== "run" ? { ...parts, verb: plainForm(parts.verb) } : parts;
}

function settledParts(block: Block, cwd: string | undefined, live: boolean): PhraseParts {
  const name = block.tool?.name ?? "";
  const kind = kindOf(block);
  const deleting = block.tool?.kind?.trim().toLowerCase() === "delete";
  switch (kind) {
    case "run":
      return runParts(block, cwd, live);
    case "read":
      return fileParts(live ? "Reading" : "Read", pathOf(block), cwd);
    case "write":
      // A Write over a file that was there is an edit (lib/groupPhrase.ts says the same).
      return /has been (updated|overwritten)/i.test(block.tool?.detail ?? "")
        ? fileParts(live ? "Editing" : "Edited", pathOf(block), cwd)
        : fileParts(live ? "Creating" : "Created", pathOf(block), cwd);
    case "edit":
      return deleting
        ? fileParts(live ? "Deleting" : "Deleted", pathOf(block), cwd)
        : fileParts(live ? "Editing" : "Edited", pathOf(block), cwd);
    case "patch": {
      const files = patchFiles(block);
      if (files.length === 1) {
        const op = files[0].op;
        const verb =
          op === "add" ? (live ? "Creating" : "Created") : op === "delete" ? (live ? "Deleting" : "Deleted") : live ? "Editing" : "Edited";
        return fileParts(verb, files[0].path, cwd);
      }
      const verb = live ? "Editing" : "Edited";
      return { verb, object: files.length === 0 ? "files" : `${files.length} files` };
    }
    case "search":
    case "glob": {
      const q = queryOf(block);
      return q
        ? { verb: live ? "Searching for" : "Searched for", object: trim(q, 32), title: q }
        : { verb: live ? "Searching" : "Searched", object: "the project" };
    }
    case "list": {
      const p = pathOf(block);
      return { verb: live ? "Listing" : "Listed", object: p ? displayPath(p, cwd) : "files" };
    }
    case "fetch": {
      const url = str(inputOf(block).url);
      const verb = live ? "Fetching" : "Fetched";
      try {
        return url ? { verb, object: new URL(url).hostname, title: url } : { verb, object: "a page" };
      } catch {
        return { verb, object: "a page" };
      }
    }
    case "web": {
      const q = str(inputOf(block).query) || block.tool?.preview?.query || "";
      return q
        ? { verb: live ? "Searching the web for" : "Searched the web for", object: trim(q, 32), title: q }
        : { verb: live ? "Searching" : "Searched", object: "the web" };
    }
    case "todo":
      return { verb: live ? "Updating todos" : "Updated todos", object: "" };
    case "question":
      return { verb: live ? "Asking" : "Asked", object: "a question" };
    case "skill": {
      const i = inputOf(block);
      const title = (block.text || block.tool?.title || "").replace(/^skill\b\s*/i, "").trim();
      const skill = str(i.skill) || str(i.name) || title;
      return { verb: live ? "Using skill" : "Used skill", object: skill };
    }
    default: {
      const verb = live ? "Using" : "Used";
      if (!name) {
        const title = (block.text || block.tool?.title || "").trim();
        if (!title || /^(working|tool|running)$/i.test(title)) return { verb: "", object: "" };
        return { verb, object: humanName(title.split(/[\s:]/)[0] || title) };
      }
      return { verb, object: humanName(name) };
    }
  }
}

/** The plain-word line for one call. Empty when nothing can be said. */
export function toolPhrase(block: Block, cwd?: string, live = isLive(block)): string {
  const { verb, object } = toolPhraseParts(block, cwd, live);
  return [verb, object].filter(Boolean).join(" ");
}
