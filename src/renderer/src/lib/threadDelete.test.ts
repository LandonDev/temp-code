import { describe, expect, it } from "vitest";
import { leaf, leafIds, newTab, type WorkspaceTab } from "./layout";
import type { Session } from "./session";
import { deleteNeighbour, planThreadDelete } from "./threadDelete";
import type { HeaderModel } from "./threadHeaderModel";

/** Stability 1: Delete keeps the window on its project and selects the
 *  neighbour chip, decided from the layout as it stood before the delete. */
function session(id: string, projectId: string | null): Session {
  return { id, environmentId: "local", cwd: "/repo", projectId, harness: "claude", title: id, blocks: [], busy: false, model: "" };
}
const tab = (id: string, sessionId: string): WorkspaceTab => ({ ...newTab(sessionId), id });
const replacement = (seed: Session | undefined): Session => session("fresh", seed?.projectId ?? null);
const chip = (id: string) => ({ id, thread: { id } }) as HeaderModel["live"][number];

const a1 = session("a1", "pA");
const a2 = session("a2", "pA");
const a3 = session("a3", "pA");
const b1 = session("b1", "pB");

describe("planThreadDelete", () => {
  it("the thread on screen gives way to its neighbour's tab; the window never reaches another project", () => {
    // b1's tab sits right before the deleted one: the old rule activated it.
    const plan = planThreadDelete({
      tabs: [tab("tb1", "b1"), tab("ta1", "a1"), tab("ta2", "a2")],
      sessions: [b1, a1, a2],
      activeTabId: "ta1",
      sessionId: "a1",
      projectKey: "pA",
      neighbourId: "a2",
      createReplacement: replacement,
    });
    expect(plan.tabs.map((t) => t.id)).toEqual(["tb1", "ta2"]);
    expect(plan.activeTabId).toBe("ta2");
    expect(plan.select).toBe("a2");
    expect(plan.sessions.map((s) => s.id)).toEqual(["b1", "a2"]);
  });

  it("a neighbour with no tab takes the deleted tab's place: a blank pane it fills, in the same tab", () => {
    const plan = planThreadDelete({
      tabs: [tab("tb1", "b1"), tab("ta1", "a1")],
      sessions: [b1, a1],
      activeTabId: "ta1",
      sessionId: "a1",
      projectKey: "pA",
      neighbourId: "a3",
      createReplacement: replacement,
    });
    expect(plan.activeTabId).toBe("ta1");
    expect(plan.tabs[1]?.focusedId).toBe("fresh");
    expect(plan.select).toBe("a3");
  });

  it("the last chip of the project leaves the project's empty screen, carrying the project", () => {
    const plan = planThreadDelete({
      tabs: [tab("tb1", "b1"), tab("ta1", "a1")],
      sessions: [b1, a1],
      activeTabId: "ta1",
      sessionId: "a1",
      projectKey: "pA",
      neighbourId: null,
      createReplacement: replacement,
    });
    expect(plan.activeTabId).toBe("ta1");
    expect(plan.select).toBeNull();
    expect(plan.sessions.find((s) => s.id === "fresh")?.projectId).toBe("pA");
  });

  it("a stub or draft that names no project closes to the window's project, never to the tab before it", () => {
    const stub = session("x", null);
    const draft = session("d", "pA");
    const plan = planThreadDelete({
      tabs: [tab("tb1", "b1"), tab("tx", "x"), tab("td", "d")],
      sessions: [b1, stub, draft],
      activeTabId: "tx",
      sessionId: "x",
      projectKey: "pA",
      neighbourId: null,
      createReplacement: replacement,
    });
    expect(plan.activeTabId).toBe("td");
    expect(plan.tabs.map((t) => t.id)).toEqual(["tb1", "td"]);
  });

  it("in a split only the deleted pane closes", () => {
    const split: WorkspaceTab = {
      ...tab("s", "a1"),
      layout: { type: "split", id: "sp", dir: "right", children: [leaf("a1"), leaf("a2")], sizes: [0.5, 0.5] },
      focusedId: "a1",
    };
    const plan = planThreadDelete({
      tabs: [tab("tb1", "b1"), split],
      sessions: [b1, a1, a2],
      activeTabId: "s",
      sessionId: "a1",
      projectKey: "pA",
      neighbourId: "a2",
      createReplacement: replacement,
    });
    expect(plan.activeTabId).toBe("s");
    expect(leafIds(plan.tabs[1]!.layout)).toEqual(["a2"]);
    expect(plan.select).toBeNull();
  });

  it("a thread not on screen loses its tab and nothing else moves", () => {
    const plan = planThreadDelete({
      tabs: [tab("ta1", "a1"), tab("ta2", "a2")],
      sessions: [a1, a2],
      activeTabId: "ta2",
      sessionId: "a1",
      projectKey: "pA",
      neighbourId: null,
      createReplacement: replacement,
    });
    expect(plan.tabs.map((t) => t.id)).toEqual(["ta2"]);
    expect(plan.activeTabId).toBe("ta2");
    expect(plan.select).toBeNull();
  });
});

describe("deleteNeighbour", () => {
  it("is Archive's neighbour on the project's strip, a linked copy's chip included", () => {
    // a3 is the box copy's thread: one strip for both copies.
    const model: HeaderModel = { live: [chip("a1"), chip("a2"), chip("a3")], dormant: [], activeId: "a2" };
    expect(deleteNeighbour(model, "a2")).toBe("a3");
    expect(deleteNeighbour({ ...model, activeId: "a3" }, "a3")).toBe("a2");
  });

  it("never the chip of another scope's thread shown only because it is on screen", () => {
    const model: HeaderModel = { live: [chip("a1"), chip("b1")], dormant: [], activeId: "a1", outsideId: "b1" };
    expect(deleteNeighbour(model, "a1")).toBeNull();
    // Deleting the outside thread itself picks from the project's own chips.
    expect(deleteNeighbour({ ...model, activeId: "b1" }, "b1")).toBe("a1");
  });

  it("the last chip has none: the shelf's first takes over, else nothing", () => {
    expect(deleteNeighbour({ live: [chip("a1")], dormant: [chip("a2")], activeId: "a1" }, "a1")).toBe("a2");
    expect(deleteNeighbour({ live: [chip("a1")], dormant: [], activeId: "a1" }, "a1")).toBeNull();
  });
});
