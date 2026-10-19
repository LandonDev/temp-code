import { bindServer, isWebMode } from "../native";
import { webSocketUrl } from "../nativeWeb";
import { client } from "./client";
import { smoke } from "./smoke";

type Doctor = Record<string, { found: boolean; version?: string; error?: string }>;

declare global {
  interface Window {
    __monocode?: {
      server: typeof client;
      smoke: typeof smoke;
    };
  }
}

const TAG = "[monocode:server]";

/** Boot hook: connect to the in-process server, report provider status, expose devtools helpers. */
export function initServerLink(): void {
  window.__monocode = { server: client, smoke };
  // The bridge dispatches server commands over this one shared client.
  bindServer(client);
  client.onOpen(() => void report());
  // The desktop window asks preload for the loopback port; the page served
  // at /ui by the fixed port speaks to its own origin, cookie on the upgrade.
  client
    .connect(isWebMode() ? { url: webSocketUrl() } : undefined)
    .catch((e) => console.error(`${TAG} connect failed:`, e));
}

async function report(): Promise<void> {
  try {
    const [doctor] = await Promise.all([
      client.request<Doctor>("doctor.get"),
      client.request("catalog.get"),
    ]);
    const providers = Object.entries(doctor)
      .map(([id, r]) => `${id} ${!r.found ? "missing" : r.error ? "error" : "ok"}`)
      .join(", ");
    console.info(`${TAG} connected :${client.port}, providers: ${providers}`);
  } catch (e) {
    console.error(`${TAG} handshake failed:`, e);
  }
}
