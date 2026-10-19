import { bindServer, getServerPort, isWebMode } from "../native";
import { webSocketUrl } from "../nativeWeb";
import {
  LOCAL_ENVIRONMENT_ID,
  WEB_ENVIRONMENT_ID,
  localEnvironment,
  registry,
  savedEnvironment,
  webEnvironment,
  type EnvLink,
} from "../connection";
import { smoke } from "./smoke";

type Doctor = Record<string, { found: boolean; version?: string; error?: string }>;
type SavedEnvironmentRow = { id: string; name: string; routes: { url: string; kind: "loopback" | "lan" | "tunnel" }[] };

declare global {
  interface Window {
    __monocode?: {
      registry: typeof registry;
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
  window.__monocode = { registry, smoke };
  // The bridge dispatches server commands over the environment's link.
  bindServer(registry);
  registry.installWindowHooks();
  registry.onLink((link, event) => {
    if (event !== "added") return;
    link.onOpen(() => void report(link));
    if (link.environmentId === LOCAL_ENVIRONMENT_ID) link.onOpen(() => void loadSavedEnvironments(link));
  });
  if (isWebMode()) {
    registry.setPrimary(WEB_ENVIRONMENT_ID);
    registry.add(webEnvironment(webSocketUrl(), location.hostname));
    return;
  }
  getServerPort().then(
    (port) => registry.add(localEnvironment(port)),
    (e) => console.error(`${TAG} no server port:`, e),
  );
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
    const [doctor] = await Promise.all([
      link.request<Doctor>("doctor.get"),
      link.request("catalog.get"),
    ]);
    const providers = Object.entries(doctor)
      .map(([id, r]) => `${id} ${!r.found ? "missing" : r.error ? "error" : "ok"}`)
      .join(", ");
    console.info(`${TAG} ${link.environmentId} connected ${link.transport?.url ?? ""}, providers: ${providers}`);
  } catch (e) {
    console.error(`${TAG} ${link.environmentId} handshake failed:`, e);
  }
}
