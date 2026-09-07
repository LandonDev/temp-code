/**
 * The one renderer module that touches `window.api`. It keeps the donor's
 * Tauri names (`invoke`, `listen`, `getCurrentWindow`, `convertFileSrc`,
 * `open`, `ask`, `message`, `getVersion`, …) so call sites change imports
 * only. `invoke` is a closed command map: every command routes to the
 * in-process server (over the shared WebSocket client) or to the main
 * process (over preload); nothing fakes success.
 */

export type UnlistenFn = () => void;
export type NativeEvent<T> = { payload: T };

/** Every donor command that still has a call site. Retired with their call
 *  sites: `sidecar_restart`, `sidecar_logs`, `set_window_background_blur`. */
export type NativeCommand =
  | "clone_repo"
  | "confirm_quit"
  | "copy_path"
  | "create_path"
  | "default_cwd"
  | "delete_path"
  | "destroy_window"
  | "enable_window_glass"
  | "fetch_claude_usage"
  | "fetch_codex_usage"
  | "git_branches"
  | "git_checkout"
  | "git_commit"
  | "git_create_branch"
  | "git_diff_index"
  | "git_diff_stats"
  | "git_discard_file"
  | "git_file_diff"
  | "git_github_pr_diff"
  | "git_github_repo"
  | "git_github_work_item_comment"
  | "git_github_work_item_details"
  | "git_github_work_item_thread"
  | "git_github_work_items"
  | "git_log"
  | "git_pr_create"
  | "git_pr_status"
  | "git_pull"
  | "git_push"
  | "git_range_context"
  | "git_stage_all"
  | "git_stage_contents"
  | "git_stage_file"
  | "git_staged_context"
  | "git_stash"
  | "git_sync"
  | "git_unstage_all"
  | "git_unstage_file"
  | "hide_window"
  | "home_dir"
  | "inspect_paths"
  | "linear_issue_comment"
  | "linear_issue_details"
  | "linear_issue_thread"
  | "linear_list_issues"
  | "linear_list_teams"
  | "linear_set_token"
  | "linear_status"
  | "list_dir"
  | "list_project_files"
  | "move_path"
  | "notes_delete"
  | "notes_get"
  | "notes_list"
  | "notes_upsert"
  | "open_new_window"
  | "pty_ack"
  | "pty_kill"
  | "pty_kill_all"
  | "pty_resize"
  | "pty_spawn"
  | "pty_status"
  | "pty_write"
  | "read_file_base64"
  | "read_file_preview"
  | "read_text_file"
  | "remove_project_logo"
  | "rename_path"
  | "reveal_path"
  | "save_project_logo"
  | "search_project"
  | "session_checkpoint_capture"
  | "session_checkpoint_ensure"
  | "session_checkpoint_keep"
  | "session_checkpoint_status"
  | "session_checkpoint_sync"
  | "session_checkpoint_undo"
  | "set_dock_badge"
  | "set_traffic_lights_visible"
  | "set_zoom"
  | "sidecar_port"
  | "stage_window_transfer"
  | "stat_files"
  | "take_window_transfer"
  | "workspace_get_snapshot"
  | "workspace_set_snapshot"
  | "write_attachment"
  | "write_text_file";

/** Events the donor listened for: the menu ids, `quit_requested`,
 *  `pty-data` (`{id, data: Uint8Array}`) and `pty-exit` (`{id, code}`). */
export type NativeEventName = string;

type Args = Record<string, unknown> | undefined;
type Backed = (args: Args) => Promise<unknown>;

const arg = <T>(args: Args, key: string): T => (args ?? {})[key] as T;
const scope = (args: Args) => ({ sessionId: arg<string>(args, "sessionId"), cwd: arg<string>(args, "cwd") });

// ── Server dispatch ────────────────────────────────────────────────────────

/** What the bridge needs from the WebSocket client. `tcserver/client.ts`
 *  imports this module for the port, so the client is injected from
 *  `main.tsx` instead of imported here. */
export type ServerLink = {
  readonly connected: boolean;
  request<T>(method: string, params?: unknown): Promise<T>;
  onOpen(listener: () => void): UnlistenFn;
};

const SERVER_OPEN_TIMEOUT_MS = 15_000;
let server: ServerLink | null = null;

export function bindServer(link: ServerLink): void {
  server = link;
}

function whenServerOpen(link: ServerLink): Promise<void> {
  if (link.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("server not connected"));
    }, SERVER_OPEN_TIMEOUT_MS);
    const off = link.onOpen(() => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  if (!server) throw new Error(`server link not bound (${method})`);
  await whenServerOpen(server);
  return server.request<T>(method, params);
}

/** Commands whose donor args are the server method's params unchanged. */
const serverMethods: Partial<Record<NativeCommand, string>> = {
  clone_repo: "git.clone",
  copy_path: "fs.copyPath",
  create_path: "fs.createPath",
  delete_path: "fs.deletePath",
  fetch_claude_usage: "rateLimits.claudeUsage",
  fetch_codex_usage: "rateLimits.codexUsage",
  git_branches: "git.branches",
  git_checkout: "git.checkout",
  git_commit: "git.commitStaged",
  git_create_branch: "git.createBranch",
  git_diff_index: "git.diffIndex",
  git_diff_stats: "git.diffStats",
  git_discard_file: "git.discardFile",
  git_file_diff: "git.fileDiff",
  git_github_pr_diff: "github.prDiff",
  git_github_repo: "github.repo",
  git_github_work_item_comment: "github.comment",
  git_github_work_item_details: "github.details",
  git_github_work_item_thread: "github.thread",
  git_github_work_items: "github.workItems",
  git_log: "git.log",
  git_pr_create: "github.createPr",
  git_pr_status: "github.prStatus",
  git_pull: "git.pull",
  git_push: "git.push",
  git_range_context: "git.rangeContext",
  git_stage_all: "git.stageAll",
  git_stage_contents: "git.stageContents",
  git_stage_file: "git.stageFile",
  git_staged_context: "git.stagedContext",
  git_stash: "git.stash",
  git_sync: "git.sync",
  git_unstage_all: "git.unstageAll",
  git_unstage_file: "git.unstageFile",
  inspect_paths: "fs.inspectPaths",
  list_dir: "fs.listPath",
  list_project_files: "fs.projectFiles",
  move_path: "fs.movePath",
  notes_delete: "notes.delete",
  notes_get: "notes.get",
  notes_list: "notes.list",
  notes_upsert: "notes.upsert",
  read_file_base64: "fs.readBase64",
  read_file_preview: "fs.readPreview",
  read_text_file: "fs.readText",
  rename_path: "fs.renamePath",
  search_project: "search.project",
  stat_files: "fs.statFiles",
  workspace_get_snapshot: "workspace.getSnapshot",
  workspace_set_snapshot: "workspace.setSnapshot",
  write_text_file: "fs.writeText",
};

// ── Command map ────────────────────────────────────────────────────────────

const backed: Record<NativeCommand, Backed> = {
  ...(Object.fromEntries(
    Object.entries(serverMethods).map(([command, method]) => [
      command,
      (args: Args) => rpc(method, args),
    ]),
  ) as Record<NativeCommand, Backed>),

  // Server commands whose params or result differ from the donor's.
  write_attachment: async (args) => {
    const saved = await rpc<{ path: string }>("attachment.save", {
      name: arg<string>(args, "name"),
      dataBase64: arg<string>(args, "data"),
    });
    return saved.path;
  },
  save_project_logo: (args) =>
    rpc("projectLogo.save", {
      projectPath: arg<string>(args, "project"),
      sourcePath: arg<string>(args, "sourcePath"),
    }),
  remove_project_logo: (args) =>
    rpc("projectLogo.remove", { projectPath: arg<string>(args, "project") }),

  // Main process.
  sidecar_port: () => getServerPort(),
  reveal_path: (args) => window.api.revealInFinder(arg<string>(args, "path")),
  default_cwd: () => window.api.app.defaultCwd(),
  home_dir: () => window.api.app.homeDir(),
  confirm_quit: () => window.api.app.confirmQuit(),
  set_dock_badge: (args) => window.api.app.dockBadge(arg<number>(args, "count")),
  hide_window: () => window.api.win.hide(),
  destroy_window: () => window.api.win.destroy(),
  open_new_window: () => window.api.win.create(),
  stage_window_transfer: (args) =>
    window.api.win.stageTransfer(arg<unknown>(args, "payload")),
  take_window_transfer: () => window.api.win.takeTransfer<string>(),
  set_traffic_lights_visible: (args) =>
    window.api.win.setButtonsVisible(arg<boolean>(args, "visible")),
  enable_window_glass: () => window.api.win.enableGlass(),
  set_zoom: (args) => window.api.win.setZoom(arg<number>(args, "level")),
  pty_spawn: (args) =>
    window.api.pty.spawn({
      id: arg<string>(args, "id"),
      cwd: arg<string>(args, "cwd"),
      cols: arg<number>(args, "cols"),
      rows: arg<number>(args, "rows"),
    }),
  pty_write: (args) =>
    window.api.pty.write(arg<string>(args, "id"), arg<string>(args, "data")),
  pty_resize: (args) =>
    window.api.pty.resize(
      arg<string>(args, "id"),
      arg<number>(args, "cols"),
      arg<number>(args, "rows"),
    ),
  pty_status: (args) => window.api.pty.status(arg<string>(args, "id")),
  pty_kill: (args) => window.api.pty.kill(arg<string>(args, "id")),
  pty_kill_all: () => window.api.pty.killAll(),
  pty_ack: async (args) =>
    window.api.pty.ack(arg<string>(args, "id"), arg<number>(args, "bytes")),

  // Checkpoints (M9) and Linear (M11): params shaped here, not passed through.
  session_checkpoint_ensure: (args) => rpc("checkpoint.ensure", scope(args)),
  session_checkpoint_capture: (args) =>
    rpc("checkpoint.capture", { ...scope(args), paths: arg<string[]>(args, "paths") ?? [] }),
  session_checkpoint_sync: (args) => rpc("checkpoint.sync", scope(args)),
  session_checkpoint_status: (args) => rpc("checkpoint.status", scope(args)),
  session_checkpoint_undo: (args) =>
    rpc("checkpoint.undo", { ...scope(args), relative: arg<string | null>(args, "relative") ?? null }),
  session_checkpoint_keep: (args) =>
    rpc("checkpoint.keep", { ...scope(args), relative: arg<string | null>(args, "relative") ?? null }),
  // Linear (M11): server-owned token, GraphQL in the server.
  linear_status: () => rpc("linear.status"),
  linear_set_token: (args) =>
    rpc("linear.setToken", { token: arg<string>(args, "token") }),
  linear_list_teams: () => rpc("linear.teams"),
  linear_list_issues: (args) =>
    rpc("linear.issues", {
      assignedToMe: arg<boolean>(args, "assignedToMe"),
      state: arg<string>(args, "state"),
      teamIds: arg<string[]>(args, "teamIds"),
    }),
  linear_issue_details: (args) =>
    rpc("linear.details", { id: arg<string>(args, "id") }),
  linear_issue_thread: (args) =>
    rpc("linear.thread", { id: arg<string>(args, "id") }),
  linear_issue_comment: (args) =>
    rpc("linear.comment", {
      id: arg<string>(args, "id"),
      body: arg<string>(args, "body"),
      parentId: arg<string>(args, "parentId"),
    }),
};

export function notPorted(name: string): Error {
  return new Error(`not ported: ${name}`);
}

export async function invoke<T = unknown>(
  command: NativeCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  const impl = backed[command];
  if (!impl) throw notPorted(command);
  return (await impl(args)) as T;
}

/** The in-process server's port, straight from preload; never opens a socket. */
export async function getServerPort(): Promise<number> {
  const port = await window.api.getServerPort();
  if (port == null) throw new Error("server port unavailable");
  return port;
}

// ── Events ─────────────────────────────────────────────────────────────────

/** Menu ids share one `native:menu` subscription; it is held only while a
 *  listener exists, so StrictMode's double effects leave no duplicates. */
const menuHandlers = new Map<string, Set<(event: NativeEvent<string>) => void>>();
let menuOff: UnlistenFn | null = null;

function listenMenu(
  id: string,
  handler: (event: NativeEvent<string>) => void,
): UnlistenFn {
  let set = menuHandlers.get(id);
  if (!set) {
    set = new Set();
    menuHandlers.set(id, set);
  }
  set.add(handler);
  menuOff ??= window.api.menu.onCommand((command) => {
    const handlers = menuHandlers.get(command);
    if (!handlers) return;
    for (const h of [...handlers]) h({ payload: command });
  });
  return () => {
    set.delete(handler);
    if (set.size === 0) menuHandlers.delete(id);
    if (menuHandlers.size === 0 && menuOff) {
      menuOff();
      menuOff = null;
    }
  };
}

export type PtyDataPayload = { id: string; data: Uint8Array };
export type PtyExitPayload = { id: string; code: number | null };

export function listen<T = unknown>(
  event: NativeEventName,
  handler: (event: NativeEvent<T>) => void,
): Promise<UnlistenFn> {
  const emit = (payload: unknown) => handler({ payload: payload as T });
  switch (event) {
    case "quit_requested":
      return Promise.resolve(window.api.app.onQuitRequested(() => emit(null)));
    case "pty-data":
      return Promise.resolve(
        window.api.pty.onData((id, data) => emit({ id, data })),
      );
    case "pty-exit":
      return Promise.resolve(
        window.api.pty.onExit((id, code) => emit({ id, code })),
      );
    default:
      return Promise.resolve(
        listenMenu(event, handler as (event: NativeEvent<string>) => void),
      );
  }
}

// ── Window ─────────────────────────────────────────────────────────────────

export type NativeWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  onResized(handler: () => void): Promise<UnlistenFn>;
  onCloseRequested(
    handler: (event: { preventDefault(): void }) => void,
  ): Promise<UnlistenFn>;
};

export function getCurrentWindow(): NativeWindow {
  const win = window.api.win;
  return {
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    isMaximized: () => win.isMaximized(),
    isFocused: () => win.isFocused(),
    setTitle: (title) => win.setTitle(title),
    onResized: (handler) => Promise.resolve(win.onResized(handler)),
    // Subscribing makes main defer every close to us. A handler that does
    // not prevent the default gets the donor's default: the window goes.
    onCloseRequested: (handler) =>
      Promise.resolve(
        win.onCloseRequested(() => {
          let prevented = false;
          handler({ preventDefault: () => (prevented = true) });
          if (!prevented) void win.destroy();
        }),
      ),
  };
}

// ── Files, dialogs, app ────────────────────────────────────────────────────

/** URL a saved project logo is served from (scoped custom protocol). */
export function convertFileSrc(path: string): string {
  return window.api.app.logoUrl(path);
}

/** Disk path of a dropped File (File.path is gone in Electron ≥32). */
export function getPathForFile(file: File): string {
  return window.api.getPathForFile(file);
}

export type OpenDialogOptions = {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
};

export function open(options: OpenDialogOptions): Promise<string | string[] | null> {
  return window.api.dialog.open(options);
}

export type DialogKind = "info" | "warning" | "error";
export type AskOptions = {
  title?: string;
  kind?: DialogKind;
  okLabel?: string;
  cancelLabel?: string;
};
export type MessageOptions = { title?: string; kind?: DialogKind };

export function ask(text: string, options?: AskOptions): Promise<boolean> {
  return window.api.dialog.ask(text, options);
}

export function message(text: string, options?: MessageOptions): Promise<void> {
  return window.api.dialog.message(text, options);
}

export function getVersion(): Promise<string> {
  return window.api.app.version();
}

export function openUrl(url: string): Promise<void> {
  return window.api.app.openUrl(url);
}

// ── Updates ────────────────────────────────────────────────────────────────

/** Main's update status: release numbers, not semver; the app relaunches
 *  itself after `apply`, so there is no renderer-side relaunch. */
export type UpdateStatus = Awaited<ReturnType<typeof window.api.updates.get>>;

export const updates = {
  get: (): Promise<UpdateStatus> => window.api.updates.get(),
  check: (): Promise<UpdateStatus> => window.api.updates.check(),
  apply: (): Promise<UpdateStatus> => window.api.updates.apply(),
  onStatus: (cb: (status: UpdateStatus) => void): UnlistenFn =>
    window.api.updates.onStatus(cb),
};
