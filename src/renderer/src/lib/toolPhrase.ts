import type { Block } from "./session";
import { displayPath, projectName } from "./paths";

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

/**
 * Plain words for a tool call: "Read src/lib/paths.ts", "Searched for
 * toolCallLabel", "Ran the tests", "Used Create Thread". The row and the
 * settled group header both come from here. Raw tool names, JSON and
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

function pathOf(block: Block): string {
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

function isLive(block: Block): boolean {
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
      return sub ? `run ${base(sub)}` : `run ${cmd}`;
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
      const redirect = />>?\s*(\S+)/.exec(seg);
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
    default:
      if (/>>?\s*\S+/.test(seg)) return `write ${rel(/>>?\s*(\S+)/.exec(seg)![1])}`;
      return cmd ? `run ${cmd}${/^[a-z][\w:-]*$/i.test(sub) ? ` ${sub}` : ""}` : null;
  }
}

/** The command's gist: up to two distinct phrases, present tense. */
export function commandPhrases(raw: string, cwd?: string): string[] {
  const out: string[] = [];
  for (const seg of segments(unwrap(raw))) {
    const p = segmentPhrase(seg, cwd);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function runPhrase(block: Block, cwd: string | undefined, live: boolean): string {
  const desc = str(inputOf(block).description).trim();
  if (desc) return cap(tense(trim(desc.charAt(0).toLowerCase() + desc.slice(1), 60), live));
  if (inputOf(block).command === undefined) {
    // The fold may already have turned the command into "Read x" / "Find x".
    const title = (block.text || block.tool?.title || "").trim();
    const m = /^(Read|Find|List|Edit|Write|Delete|Move|Fetch|Create)\s+(.+)$/.exec(title);
    if (m) {
      const verb = m[1] === "Find" ? "search for" : m[1].toLowerCase();
      return cap(`${tense(verb, live)} ${m[2]}`);
    }
  }
  const phrases = commandPhrases(commandOf(block), cwd).map((p) => tense(p, live));
  if (phrases.length === 0) return live ? "Running a command" : "Ran a command";
  const extra = phrases.length - 2;
  return cap(phrases.slice(0, 2).join(" · ") + (extra > 0 ? ` +${extra} more` : ""));
}

function patchPaths(block: Block): string[] {
  const i = inputOf(block);
  const raw = typeof block.tool?.input === "string" ? block.tool.input : str(i.patch);
  const found = [...raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  if (found.length) return found;
  const p = pathOf(block);
  return p ? [p] : [];
}

function fileWord(block: Block, cwd?: string): string {
  const p = pathOf(block);
  return p ? displayPath(p, cwd) : "a file";
}

/** The plain-word line for one call. Empty when nothing can be said. */
export function toolPhrase(block: Block, cwd?: string, live = isLive(block)): string {
  const name = block.tool?.name ?? "";
  const kind = kindOf(block);
  switch (kind) {
    case "run":
      return runPhrase(block, cwd, live);
    case "read":
      return `${live ? "Reading" : "Read"} ${fileWord(block, cwd)}`;
    case "write":
      return `${live ? "Writing" : "Wrote"} ${fileWord(block, cwd)}`;
    case "edit":
      return `${live ? "Editing" : "Edited"} ${fileWord(block, cwd)}`;
    case "patch": {
      const paths = patchPaths(block);
      const what =
        paths.length === 0
          ? "files"
          : paths.length === 1
            ? displayPath(paths[0], cwd)
            : `${paths.length} files`;
      return `${live ? "Patching" : "Patched"} ${what}`;
    }
    case "search":
    case "glob": {
      const q = queryOf(block);
      return q
        ? `${live ? "Searching" : "Searched"} for ${trim(q, 32)}`
        : live
          ? "Searching the project"
          : "Searched the project";
    }
    case "list": {
      const p = pathOf(block);
      return `${live ? "Listing" : "Listed"} ${p ? displayPath(p, cwd) : "files"}`;
    }
    case "fetch": {
      const url = str(inputOf(block).url);
      try {
        return `${live ? "Fetching" : "Fetched"} ${url ? new URL(url).hostname : "a page"}`;
      } catch {
        return live ? "Fetching a page" : "Fetched a page";
      }
    }
    case "web": {
      const q = str(inputOf(block).query) || block.tool?.preview?.query || "";
      return `${live ? "Searching" : "Searched"} the web${q ? ` for ${trim(q, 32)}` : ""}`;
    }
    case "todo":
      return live ? "Updating todos" : "Updated todos";
    case "question":
      return live ? "Asking a question" : "Asked a question";
    case "skill": {
      const i = inputOf(block);
      const title = (block.text || block.tool?.title || "").replace(/^skill\b\s*/i, "").trim();
      const skill = str(i.skill) || str(i.name) || title;
      return `${live ? "Using" : "Used"} Skill${skill ? ` ${skill}` : ""}`;
    }
    default: {
      if (!name) {
        const title = (block.text || block.tool?.title || "").trim();
        if (!title || /^(working|tool|running)$/i.test(title)) return "";
        return `${live ? "Using" : "Used"} ${humanName(title.split(/[\s:]/)[0] || title)}`;
      }
      return `${live ? "Using" : "Used"} ${humanName(name)}`;
    }
  }
}

function isFailed(block: Block): boolean {
  const s = block.tool?.status?.toLowerCase() ?? "";
  return s === "failed" || s === "error" || block.approval?.decided === "deny";
}

/** Shared folder of a set of cwd-relative paths, "" at the project root. */
function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  let shared = dirs[0] ?? [];
  for (const d of dirs.slice(1)) {
    let n = 0;
    while (n < shared.length && n < d.length && shared[n] === d[n]) n++;
    shared = shared.slice(0, n);
  }
  return shared.join("/");
}

function readsPhrase(paths: string[], cwd: string | undefined, live: boolean): string {
  const verb = live ? "Reading" : "Read";
  const rel = paths.map((p) => displayPath(p, cwd));
  if (rel.length === 1) return `${verb} ${rel[0]}`;
  const inside = cwd ? rel.every((p) => !p.startsWith("/") && !p.startsWith("~")) : false;
  if (!inside) return `${verb} ${rel.length} files`;
  const dir = commonDir(rel);
  return dir
    ? `${verb} ${rel.length} files in ${dir}`
    : `${verb} ${projectName(cwd!)} files`;
}

/**
 * One line for a run of calls: consecutive reads fold into "Read 3 files in
 * src/lib" (or "Read MonoCode files" across the project), edits into "Edited
 * 2 files", and the first two distinct phrases lead, "+N more" behind them.
 */
export function groupPhrase(blocks: Block[], cwd?: string, live?: boolean): string {
  const tools = blocks.filter((b) => b.role === "tool" || b.role === "approval");
  if (tools.length === 0) return "";
  const running = live ?? tools.some(isLive);
  const phrases: string[] = [];
  const push = (p: string): void => {
    if (p && !phrases.includes(p)) phrases.push(p);
  };
  let reads: string[] = [];
  let edits: string[] = [];
  const flushReads = (): void => {
    if (reads.length) push(readsPhrase([...new Set(reads)], cwd, running));
    reads = [];
  };
  const flushEdits = (): void => {
    const unique = [...new Set(edits)];
    if (unique.length === 1) push(`${running ? "Editing" : "Edited"} ${displayPath(unique[0], cwd)}`);
    else if (unique.length > 1) push(`${running ? "Editing" : "Edited"} ${unique.length} files`);
    edits = [];
  };
  for (const b of tools) {
    const kind = kindOf(b);
    const path = pathOf(b);
    if (kind === "read" && path) {
      flushEdits();
      reads.push(path);
      continue;
    }
    if ((kind === "edit" || kind === "write" || kind === "patch") && path) {
      flushReads();
      edits.push(path);
      continue;
    }
    flushReads();
    flushEdits();
    push(toolPhrase(b, cwd, running));
  }
  flushReads();
  flushEdits();
  const failed = tools.filter(isFailed).length;
  const extra = phrases.length - 2;
  let line = phrases.slice(0, 2).map((p) => trim(p, 48)).join(" · ");
  if (!line) line = running ? "Working" : `Ran ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  if (extra > 0) line += ` +${extra} more`;
  if (failed) line += ` · ${failed} failed`;
  return line;
}
