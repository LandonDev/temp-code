import { describe, expect, it } from "vitest";
import type { Environment } from "./connection/types";
import { groupByEnvironment } from "./environmentGroups";

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });

describe("groupByEnvironment", () => {
  it("splits rows by host in registry order, unclaimed folders on this machine, empty hosts kept", () => {
    const items = [{ path: "/a", openedAt: 1 }, { path: "/srv/agents/work/b", openedAt: 2 }, { path: "/c", openedAt: 3 }];
    const owner = (path: string) => (path.startsWith("/srv/") ? "box" : path === "/c" ? undefined : "local");
    const groups = groupByEnvironment(items, [env("local", "This Mac"), env("box", "box"), env("mini", "mini")], owner);
    expect(groups.map((g) => [g.environment.id, g.items.map((i) => i.path)])).toEqual([
      ["local", ["/a", "/c"]],
      ["box", ["/srv/agents/work/b"]],
      ["mini", []],
    ]);
  });
  it("drops a row whose host is gone when there is no group at all", () => {
    expect(groupByEnvironment([{ path: "/a", openedAt: 1 }], [], () => "x")).toEqual([]);
  });
});
