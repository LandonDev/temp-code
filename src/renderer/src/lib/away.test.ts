import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwaySnapshot } from "@server/shared/contract-away";
import { attachAwayLink, awayEnabled, awayStore, onAwayPush, resetAwayForTest } from "./away";
import { registry } from "./connection/registry";
import type { ServerPush } from "./tcserver/types";

/** A link that answers `away.get` with `snapshot` and lets the test push. */
function fakeLink(environmentId: string, snapshot: AwaySnapshot) {
  let push: (p: ServerPush) => void = () => {};
  let open: () => void = () => {};
  const link = {
    environmentId,
    connected: false,
    request: vi.fn(async () => snapshot),
    onPush: (l: (p: ServerPush) => void) => ((push = l), () => {}),
    onOpen: (l: () => void) => ((open = l), () => {}),
  };
  return { link: link as never, push: (p: AwaySnapshot) => push({ push: "away", ...p } as ServerPush), open: () => open() };
}

const snap = (enabled: boolean, at: number, threads: { sessionId: string; count: number }[] = []): AwaySnapshot => ({
  state: { enabled, at, by: "env_mac" },
  decided: { since: at, threads },
});

afterEach(() => resetAwayForTest());

describe("the away store", () => {
  it("reads a host's state at open, and hears only its live pushes as pushes", async () => {
    const heard = vi.fn();
    onAwayPush(heard);
    const box = fakeLink("env_box", snap(true, 10));
    attachAwayLink(box.link);
    box.open();
    await vi.waitFor(() => expect(awayStore.getState().hosts.env_box?.state.enabled).toBe(true));
    expect(heard).not.toHaveBeenCalled();
    box.push(snap(false, 20, [{ sessionId: "a", count: 2 }]));
    expect(heard).toHaveBeenCalledWith("env_box", snap(true, 10), snap(false, 20, [{ sessionId: "a", count: 2 }]));
    expect(awayStore.getState().hosts.env_box?.decided.threads).toEqual([{ sessionId: "a", count: 2 }]);
  });

  it("shows this machine's flip until the host's word is as new", () => {
    const local = fakeLink(registry.primaryEnvironmentId, snap(false, 0));
    attachAwayLink(local.link);
    awayStore.setState({ pending: { enabled: true, at: 50, by: "" } });
    expect(awayEnabled()).toBe(true);
    local.push(snap(false, 40));
    expect(awayStore.getState().pending).not.toBeNull();
    local.push(snap(true, 60));
    expect(awayStore.getState().pending).toBeNull();
    expect(awayEnabled()).toBe(true);
  });

  it("reads another host's state apart from this machine's", () => {
    const box = fakeLink("env_box", snap(false, 0));
    attachAwayLink(box.link);
    box.push(snap(true, 5));
    expect(awayEnabled()).toBe(false);
  });
});
