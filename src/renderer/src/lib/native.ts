/**
 * The one renderer module that touches `window.api`. It keeps the donor's
 * Tauri names (`invoke`, `listen`, `getCurrentWindow`, `convertFileSrc`,
 * `open`, `ask`, `message`, `getVersion`, …) so call sites change imports
 * only. `invoke` is a closed command map: a command with no backend yet
 * rejects with `not ported: <name>` and never fakes success.
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

/** Events the donor listened for. Menu ids arrive as their own event names. */
export type NativeEventName = string;

type Args = Record<string, unknown> | undefined;
type Backed = (args: Args) => Promise<unknown>;

const arg = <T>(args: Args, key: string): T => (args ?? {})[key] as T;
const scope = (args: Args) => ({ sessionId: arg<string>(args, "sessionId"), cwd: arg<string>(args, "cwd") });

/** The WS client's request(), injected once at boot (`bindServer` from the
 *  server link) so server-backed commands need no import cycle. */
type ServerRequest = <T>(method: string, params?: unknown) => Promise<T>;
let serverRequest: ServerRequest | null = null;
export function bindServer(request: ServerRequest): void {
  serverRequest = request;
}
const server: ServerRequest = (method, params) => {
  if (!serverRequest) return Promise.reject(new Error("server not bound"));
  return serverRequest(method, params);
};

/** Commands with a backend today. Everything else rejects `not ported`. */
const backed: Partial<Record<NativeCommand, Backed>> = {
  sidecar_port: () => getServerPort(),
  reveal_path: (args) => window.api.revealInFinder(arg<string>(args, "path")),
  session_checkpoint_ensure: (args) => server("checkpoint.ensure", scope(args)),
  session_checkpoint_capture: (args) =>
    server("checkpoint.capture", { ...scope(args), paths: arg<string[]>(args, "paths") ?? [] }),
  session_checkpoint_sync: (args) => server("checkpoint.sync", scope(args)),
  session_checkpoint_status: (args) => server("checkpoint.status", scope(args)),
  session_checkpoint_undo: (args) =>
    server("checkpoint.undo", { ...scope(args), relative: arg<string | null>(args, "relative") ?? null }),
  session_checkpoint_keep: (args) =>
    server("checkpoint.keep", { ...scope(args), relative: arg<string | null>(args, "relative") ?? null }),
  // Linear (M11): server-owned token, GraphQL in the server.
  linear_status: () => server("linear.status"),
  linear_set_token: (args) =>
    server("linear.setToken", { token: arg<string>(args, "token") }),
  linear_list_teams: () => server("linear.teams"),
  linear_list_issues: (args) =>
    server("linear.issues", {
      assignedToMe: arg<boolean>(args, "assignedToMe"),
      state: arg<string>(args, "state"),
      teamIds: arg<string[]>(args, "teamIds"),
    }),
  linear_issue_details: (args) =>
    server("linear.details", { id: arg<string>(args, "id") }),
  linear_issue_thread: (args) =>
    server("linear.thread", { id: arg<string>(args, "id") }),
  linear_issue_comment: (args) =>
    server("linear.comment", {
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

/** Native events (menu ids, pty-data, pty-exit, quit_requested). No backend
 *  emits them yet, so subscriptions resolve with a no-op unsubscribe. */
export function listen<T = unknown>(
  _event: NativeEventName,
  _handler: (event: NativeEvent<T>) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(() => undefined);
}

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

const reject = (name: string) => () => Promise.reject(notPorted(name));

export function getCurrentWindow(): NativeWindow {
  return {
    minimize: reject("window_minimize"),
    toggleMaximize: reject("window_toggle_maximize"),
    close: reject("window_close"),
    isMaximized: reject("window_is_maximized"),
    isFocused: reject("window_is_focused"),
    setTitle: reject("window_set_title"),
    onResized: () => Promise.resolve(() => undefined),
    onCloseRequested: () => Promise.resolve(() => undefined),
  };
}

export type DragDropPayload =
  | { type: "enter" | "over"; position: { x: number; y: number }; paths: string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };

export function getCurrentWebview(): {
  onDragDropEvent(
    handler: (event: NativeEvent<DragDropPayload>) => void,
  ): Promise<UnlistenFn>;
} {
  return { onDragDropEvent: () => Promise.resolve(() => undefined) };
}

/** URL a saved project logo is served from (scoped custom protocol). */
export function convertFileSrc(path: string): string {
  return `tempcode-asset://local${encodeURI(path)}`;
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

export function open(_options: OpenDialogOptions): Promise<string | string[] | null> {
  return Promise.reject(notPorted("dialog_open"));
}

export type DialogKind = "info" | "warning" | "error";
export type AskOptions = {
  title?: string;
  kind?: DialogKind;
  okLabel?: string;
  cancelLabel?: string;
};
export type MessageOptions = { title?: string; kind?: DialogKind };

export function ask(_text: string, _options?: AskOptions): Promise<boolean> {
  return Promise.reject(notPorted("dialog_ask"));
}

export function message(_text: string, _options?: MessageOptions): Promise<void> {
  return Promise.reject(notPorted("dialog_message"));
}

export function getVersion(): Promise<string> {
  return Promise.reject(notPorted("app_version"));
}

/** External links go through the main process's window-open handler,
 *  which opens them in the default browser and denies the popup. */
export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener");
}

export function relaunch(): Promise<void> {
  return Promise.reject(notPorted("app_relaunch"));
}

// ── Updater (Tauri plugin shape; reshaped onto window.api.updates in M2b) ──

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type Update = {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
};

/** Until the updater is ported, checks fail the way an unconfigured donor
 *  updater did, which keeps automatic checks quiet. */
export function check(): Promise<Update | null> {
  return Promise.reject(
    new Error("updater does not have any endpoints set (not ported: updater_check)"),
  );
}
