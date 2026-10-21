/**
 * The bundle served at `/ui` by the fixed port runs in a plain browser:
 * there is no preload, so `window.api` is absent. This object has the same
 * shape and gives every Electron-only command a browser answer: dialogs go
 * through confirm/alert, links open in a tab, the terminal says it needs the
 * desktop app, and window chrome, updates and appshots are inert. The slot
 * is `web`, so the browser keeps its own workspace snapshot and never
 * overwrites the desktop layout.
 */
import { logoAssetUrl } from "@server/shared/assets";

type Api = typeof window.api;

const DESKTOP_ONLY = "needs the desktop app";
const needsDesktop = (what: string) => Promise.reject(new Error(`${what} ${DESKTOP_ONLY}`));
const noop = () => {};
const done = () => Promise.resolve();

/** True when this page is served by the fixed port rather than Electron. */
export function isWebMode(): boolean {
  return typeof window !== "undefined" && typeof (window as { api?: unknown }).api === "undefined";
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
  getServerPort: () => Promise.resolve(null),
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
    enableGlass: done,
    disableGlass: () => done(),
    setGlassPref: () => done(),
    setZoom: () => done(),
    onResized: (cb) => {
      window.addEventListener("resize", cb);
      return () => window.removeEventListener("resize", cb);
    },
    onCloseRequested: () => noop,
    onPersistRequested: () => noop,
    persisted: noop,
  },
  menu: { onCommand: () => noop },
  dialog: {
    open: () => needsDesktop("The file picker"),
    ask: (text) => Promise.resolve(window.confirm(text)),
    message: (text) => {
      window.alert(text);
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
