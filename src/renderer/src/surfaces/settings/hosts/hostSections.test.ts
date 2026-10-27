import { describe, expect, it } from "vitest";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";
import { hostSections } from "./hostSections";

const saved = (id: string, name: string): SavedEnvironment => ({ id, name, routes: [{ url: `wss://${name}/ws`, kind: "tunnel" }], caps: ["read", "admin"], keyId: "k", addedAt: 0 }) as unknown as SavedEnvironment;
const bridge = (environmentId: string, name: string): MacBridgeHostPolicy => ({
  environmentId,
  name,
  policy: "read",
  shared: [],
  showRunning: true,
  registered: true,
  maxRunning: 4,
  maxThreads: 2,
  running: 0,
  held: 0,
  threads: 0,
});
const local = { id: "local", name: "This Mac" };
const thisMac = { environmentId: "env_mac", name: "This Mac", local: true };

describe("hostSections", () => {
  it("is this machine alone, with its devices, when nothing is paired", () => {
    const sections = hostSections({ environments: [local], saved: [], bridgeHosts: [], deviceHosts: [thisMac], web: false });
    expect(sections).toEqual([{ id: "local", name: "This Mac", local: true, saved: null, bridge: null, devices: thisMac }]);
  });

  it("puts a paired host after this machine with its saved row and its Mac bridge policy", () => {
    const box = saved("env_box", "box");
    const sections = hostSections({
      environments: [local, { id: "env_box", name: "box" }],
      saved: [box],
      bridgeHosts: [bridge("env_box", "box")],
      deviceHosts: [thisMac],
      web: false,
    });
    expect(sections.map((s) => s.id)).toEqual(["local", "env_box"]);
    expect(sections[1]).toMatchObject({ name: "box", local: false, saved: box, bridge: { environmentId: "env_box" }, devices: null });
    expect(sections[0]!.devices).toBe(thisMac);
  });

  it("keeps the environments' order and lists a host only the bridge knows last", () => {
    const sections = hostSections({
      environments: [local, { id: "env_b", name: "b" }, { id: "env_a", name: "a" }],
      saved: [saved("env_a", "a"), saved("env_b", "b")],
      bridgeHosts: [bridge("env_c", "studio box"), bridge("env_a", "a")],
      deviceHosts: [],
      web: false,
    });
    expect(sections.map((s) => s.id)).toEqual(["local", "env_b", "env_a", "env_c"]);
    expect(sections[3]).toMatchObject({ name: "studio box", saved: null, bridge: { environmentId: "env_c" } });
  });

  it("in web mode is the served host first, then the Macs linked to it holding only their devices", () => {
    const studio = { environmentId: "env_mac", name: "Studio", local: false };
    const sections = hostSections({
      environments: [{ id: "web", name: "box" }],
      saved: [],
      bridgeHosts: [bridge("env_x", "x")],
      deviceHosts: [studio],
      web: true,
    });
    expect(sections).toEqual([
      { id: "web", name: "box", local: true, saved: null, bridge: null, devices: null },
      { id: "env_mac", name: "Studio", local: false, saved: null, bridge: null, devices: studio },
    ]);
  });
});
