import type { SavedEnvironment } from "@server/shared/contract-remote";
import type { HostDevicesHost } from "@server/shared/contract-hostdevices";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID } from "../../../lib/connection/registry";

/**
 * The Hosts page's sections, in order: this machine first (the served host
 * in web mode), then each paired host in the environments' order, then a
 * host only the Mac bridge or the devices list knows (a box registered with
 * this Mac but not saved here, or in web mode a Mac linked to the host).
 * Each section carries what the page draws for it.
 */

export type HostSectionModel = {
  id: string;
  name: string;
  /** This machine (the desktop's local server, or the host a web page is served by). */
  local: boolean;
  /** The saved row of a paired host; null for this machine and for a host only the bridge or devices know. */
  saved: SavedEnvironment | null;
  /** That host's Mac bridge policy on this Mac (desktop only). */
  bridge: MacBridgeHostPolicy | null;
  /** The Mac whose devices the section lists. */
  devices: HostDevicesHost | null;
};

export type HostSectionsInput = {
  environments: readonly { id: string; name: string }[];
  saved: readonly SavedEnvironment[];
  bridgeHosts: readonly MacBridgeHostPolicy[];
  deviceHosts: readonly HostDevicesHost[];
  web: boolean;
};

export function hostSections({ environments, saved, bridgeHosts, deviceHosts, web }: HostSectionsInput): HostSectionModel[] {
  const localId = web ? WEB_ENVIRONMENT_ID : LOCAL_ENVIRONMENT_ID;
  const savedById = new Map(saved.map((s) => [s.id, s] as const));
  // The bridge is this Mac's: a web page has none to show.
  const bridgeById = new Map((web ? [] : bridgeHosts).map((b) => [b.environmentId, b] as const));
  const localDevices = deviceHosts.find((d) => d.local) ?? null;
  const devicesById = new Map(deviceHosts.filter((d) => !d.local).map((d) => [d.environmentId, d] as const));

  const local = environments.find((e) => e.id === localId);
  const sections: HostSectionModel[] = [
    { id: localId, name: local?.name ?? "This machine", local: true, saved: null, bridge: null, devices: localDevices },
  ];
  const seen = new Set([localId]);
  const add = (section: HostSectionModel): void => {
    if (seen.has(section.id)) return;
    seen.add(section.id);
    sections.push(section);
  };
  // A web page reaches one host: whatever else it lists is not a host it can pair.
  if (!web) {
    for (const env of environments) {
      if (env.id === LOCAL_ENVIRONMENT_ID || env.id === WEB_ENVIRONMENT_ID) continue;
      add({ id: env.id, name: env.name, local: false, saved: savedById.get(env.id) ?? null, bridge: bridgeById.get(env.id) ?? null, devices: devicesById.get(env.id) ?? null });
    }
  }
  for (const b of bridgeById.values()) add({ id: b.environmentId, name: b.name, local: false, saved: null, bridge: b, devices: devicesById.get(b.environmentId) ?? null });
  for (const d of devicesById.values()) add({ id: d.environmentId, name: d.name, local: false, saved: null, bridge: null, devices: d });
  return sections;
}
