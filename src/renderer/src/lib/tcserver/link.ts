import { bindServer, getServerPort, isWebMode } from "../native";
import { webSocketUrl } from "../nativeWeb";
import {
  LOCAL_ENVIRONMENT_ID,
  WEB_ENVIRONMENT_ID,
  localEnvironment,
  registry,
  savedEnvironment,
  webEnvironment,
  trackLastSeen,
  type EnvLink,
} from "../connection";
import { smoke } from "./smoke";
import { focusSignal } from "./commands";
import { sessionStore } from "./store";
import { environmentStore } from "../../stores/environment";
import { refreshCatalog } from "./catalog";
import { dropHarnessModels, setDefaultCatalogEnvironment } from "../models";
import { dropHarnessAvailability, probeHarnessAvailability } from "../harness/availability";

type Doctor = Record<string, { found: boolean; version?: string; error?: string }>;
type SavedEnvironmentRow = { id: string; name: string; routes: { url: string; kind: "loopback" | "lan" | "tunnel" }[] };

declare global {
  interface Window {
    /** Devtools and the e2e scripts: the registry, the session store and the boot helpers. */
    __monocode?: {
      registry: typeof registry;
      sessionStore: typeof sessionStore;
      /** The window's current environment and the workspace last used per environment (thread K2). */
      environment: typeof environmentStore;
      loadSavedEnvironments: typeof loadSavedEnvironments;
      smoke: typeof smoke;
    };
  }
}

const TAG = "[monocode:server]";

/**
 * Boot hook: register environment zero and start the connection runtime.
 * The desktop window asks preload for the loopback port and adds this
 * machine's server as `local`, exactly as the single client once connected;
 * the page served at /ui by the fixed port adds its own origin as `web`,
 * the cookie on the upgrade, and that is its only environment. Saved remote
 * hosts come from the main process once the local link is up.
 */
export function initServerLink(): void {
  if (typeof window !== "undefined") {
    window.__monocode = { registry, sessionStore, environment: environmentStore, loadSavedEnvironments, smoke };
    registry.installWindowHooks();
    installFocusHooks();
    trackLastSeen();
  }
  // The bridge dispatches server commands over the environment's link.
  bindServer(registry);
  registry.onLink((link, event) => {
    if (event !== "added") {
      dropHarnessModels(link.environmentId);
      dropHarnessAvailability(link.environmentId);
      return;
    }
    link.onOpen(() => void report(link));
    // A new socket holds no focus: tell it which thread this window shows.
    link.onOpen(() => focusSignal.reopened(link.environmentId));
    // Each host's model catalog and installed CLIs, so a picker on its thread shows its rows.
    link.onOpen(() => {
      void refreshCatalog(link.environmentId).catch(() => undefined);
      void probeHarnessAvailability({ environmentId: link.environmentId, force: true });
    });
    if (link.environmentId === LOCAL_ENVIRONMENT_ID) link.onOpen(() => void loadSavedEnvironments(link));
  });
  if (isWebMode()) {
    setDefaultCatalogEnvironment(WEB_ENVIRONMENT_ID);
    registry.setPrimary(WEB_ENVIRONMENT_ID);
    registry.add(webEnvironment(webSocketUrl(), location.hostname));
    return;
  }
  getServerPort().then(
    (port) => registry.add(localEnvironment(port)),
    (e) => console.error(`${TAG} no server port:`, e),
  );
}

/** The window losing focus clears this window's focus on every host; coming
 *  back restores it. Focus moving into a frame inside the window (an html
 *  render, a webview) blurs the window but leaves the document focused. */
function installFocusHooks(): void {
  focusSignal.window(document.hasFocus());
  window.addEventListener("focus", () => focusSignal.window(true));
  window.addEventListener("blur", () => {
    setTimeout(() => focusSignal.window(document.hasFocus()), 0);
  });
}

/** The hosts the main process keeps keys for join the registry (or update their routes). */
export async function loadSavedEnvironments(local: EnvLink = registry.linkOf(LOCAL_ENVIRONMENT_ID)): Promise<void> {
  try {
    const rows = await local.request<SavedEnvironmentRow[]>("remote.environments.list");
    const keep = new Set([LOCAL_ENVIRONMENT_ID]);
    for (const row of rows) {
      keep.add(row.id);
      registry.add(savedEnvironment(row));
    }
    for (const env of registry.environments()) if (!keep.has(env.id)) registry.remove(env.id);
  } catch (e) {
    console.error(`${TAG} saved environments:`, e);
  }
}

async function report(link: EnvLink): Promise<void> {
  try {
    const doctor = await link.request<Doctor>("doctor.get");
    const providers = Object.entries(doctor)
      .map(([id, r]) => `${id} ${!r.found ? "missing" : r.error ? "error" : "ok"}`)
      .join(", ");
    console.info(`${TAG} ${link.environmentId} connected ${link.transport?.url ?? ""}, providers: ${providers}`);
  } catch (e) {
    console.error(`${TAG} ${link.environmentId} handshake failed:`, e);
  }
}
