/**
 * The bundle served at `/ui` by the fixed port runs in a plain browser:
 * there is no preload, so `window.api` is absent. This object has the same
 * shape and gives every Electron-only command a browser answer: an ask is
 * the app's own confirm dialog and a message a toast (never the browser's
 * confirm or alert), links open in a tab, the terminal says it needs the
 * desktop app, and window chrome, updates and appshots are inert. Those
 * refusals are the last resort: the controls that would reach them are not
 * drawn (`desktopOnly`), and a desktop-only surface reached anyway says
 * `DESKTOP_ONLY_LINE`. The slot is `web`, so the browser keeps its own
 * workspace snapshot and never overwrites the desktop layout.
 */
import { logoAssetUrl } from "@server/shared/assets";
import { confirmAction, type ConfirmRequest } from "../chrome/ConfirmDialog";

type Api = typeof window.api;

const DESKTOP_ONLY = "needs the desktop app";
const needsDesktop = (what: string) => Promise.reject(new Error(`${what} ${DESKTOP_ONLY}`));
const noop = () => {};
const done = () => Promise.resolve();

/** sonner rides the toast chunk, out of the first paint; loaded once, on the first message. */
let sonner: Promise<typeof import("sonner")> | undefined;

/** A dialog's text as a title and the rest: its first line, then what follows the blank line. */
function splitText(text: string): { title: string; body?: string } {
  const [first, ...rest] = text.split("\n");
  const body = rest.join("\n").trim();
  return { title: first.trim(), ...(body ? { body } : {}) };
}

/** The desktop's native ask as the app's confirm: its title (else the
 *  text's first line), the text, the OK label as the verb; a warning asks
 *  in red. */
export function askRequest(
  text: string,
  options?: { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string },
): ConfirmRequest {
  const split = options?.title ? { title: options.title, body: text } : splitText(text);
  return {
    title: split.title,
    ...(split.body ? { body: split.body } : {}),
    action: options?.okLabel ?? "OK",
    ...(options?.kind === "warning" || options?.kind === "error" ? { danger: true } : {}),
  };
}

/** True when this page is served by the fixed port rather than Electron. */
export function isWebMode(): boolean {
  return typeof window !== "undefined" && typeof (window as { api?: unknown }).api === "undefined";
}

/** What a desktop-only surface says when the browser reaches it anyway. */
export const DESKTOP_ONLY_LINE = "Available in the desktop app";

/** The handler on the desktop, undefined at /ui: a menu row or button whose
 *  handler is undefined is not drawn, so web mode shows no dead control. */
export function desktopOnly<T>(handler: T): T | undefined {
  return isWebMode() ? undefined : handler;
}

/** `wss://host/ws` (or ws:// on plain http) on this page's own origin. */
export function webSocketUrl(): string {
  return `${location.origin.replace(/^http/, "ws")}/ws`;
}

/** A `tempcode-asset://host/path` URL as this page can load it: unchanged in
 *  Electron, `/asset/host/path` on the fixed port's origin in a browser. */
export function assetHref(url: string): string {
  if (!isWebMode()) return url;
  const m = /^tempcode-asset:\/\/([^/?#]+)(.*)$/.exec(url);
  return m ? `/asset/${m[1]}${m[2].startsWith("/") ? "" : "/"}${m[2]}` : url;
}

let version: Promise<string> | null = null;

export const webApi: Api = {
  // The page's one host says its platform in its hello; nothing is known before it.
  platform: "",
  getServerPort: () => Promise.resolve(null),
  // The page at /ui has one host and no main process: nothing to paint from before its socket.
  launchMirror: { read: () => null, write: noop },
  appshots: {
    onCapture: () => noop,
    onError: () => noop,
    permissions: () => Promise.resolve({ available: false, screen: false, ax: false }),
  },
  updates: {
    get: () => Promise.resolve(IDLE_UPDATE),
    check: () => Promise.resolve(IDLE_UPDATE),
    apply: () => Promise.resolve(IDLE_UPDATE),
    onStatus: () => noop,
  },
  pickDirectory: () => Promise.resolve(null),
  revealInFinder: () => done(),
  editor: {
    config: () => Promise.resolve(null),
    setChoice: () => done(),
    open: () => needsDesktop("Opening a file in an editor"),
  },
  getPathForFile: () => {
    throw new Error(`Dropping files from disk ${DESKTOP_ONLY}`);
  },
  pty: {
    spawn: () => needsDesktop("Terminal"),
    write: () => needsDesktop("Terminal"),
    resize: () => done(),
    status: () => Promise.resolve({ foreground: null }),
    kill: () => done(),
    killAll: () => done(),
    ack: noop,
    onData: () => noop,
    onExit: () => noop,
  },
  win: {
    slot: "web",
    minimize: done,
    toggleMaximize: done,
    close: done,
    isMaximized: () => Promise.resolve(false),
    isFocused: () => Promise.resolve(document.hasFocus()),
    setTitle: (title) => {
      document.title = title;
      return done();
    },
    hide: done,
    destroy: done,
    create: () => {
      window.open(location.href, "_blank", "noopener");
      return done();
    },
    stageTransfer: () => done(),
    takeTransfer: () => Promise.resolve(null),
    setButtonsVisible: () => done(),
    setZoom: () => done(),
    onResized: (cb) => {
      window.addEventListener("resize", cb);
      return () => window.removeEventListener("resize", cb);
    },
    onCloseRequested: () => noop,
    onPersistRequested: () => noop,
    persisted: noop,
  },
  menu: { onCommand: () => noop, setState: noop },
  dialog: {
    open: () => needsDesktop("The file picker"),
    ask: (text, options) => confirmAction(askRequest(text, options)),
    message: (text, options) => {
      const { title, body } = splitText(text);
      void (sonner ??= import("sonner")).then(({ toast }) =>
        (options?.kind === "error" ? toast.error : toast)(title, body ? { description: body } : undefined),
      );
      return done();
    },
  },
  app: {
    version: () =>
      (version ??= fetch("/api/hello")
        .then((r) => r.json() as Promise<{ version?: string }>)
        .then((j) => j.version ?? "")
        .catch(() => "")),
    homeDir: () => Promise.resolve(""),
    defaultCwd: () => Promise.resolve(""),
    openUrl: (url) => {
      window.open(url, "_blank", "noopener");
      return done();
    },
    dockBadge: () => done(),
    confirmQuit: done,
    declineQuit: noop,
    onQuitRequested: () => noop,
    logoUrl: (absolutePath) => assetHref(logoAssetUrl(absolutePath)),
    // A browser tab cannot tell whether its person is there: always present.
    attention: () => Promise.resolve(true),
    onAttention: () => noop,
  },
  debug: {
    menuClick: () => needsDesktop("Debug"),
    dockBadge: () => needsDesktop("Debug"),
    windowTitle: () => needsDesktop("Debug"),
    ptyFlow: () => needsDesktop("Debug"),
    nextPick: () => needsDesktop("Debug"),
    assetFetch: () => needsDesktop("Debug"),
    windows: () => needsDesktop("Debug"),
    ptys: () => needsDesktop("Debug"),
    aliaxCalls: () => needsDesktop("Debug"),
    appshot: () => needsDesktop("Debug"),
  },
};

const IDLE_UPDATE: Awaited<ReturnType<Api["updates"]["get"]>> = {
  current: "",
  latest: null,
  notes: "",
  canApply: false,
  checked: true,
  phase: "idle",
};
