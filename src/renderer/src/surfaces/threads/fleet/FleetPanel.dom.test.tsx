// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSections, agentTree, type AgentTreeNode } from "../../../lib/threads/agents";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { fixtureMeta } from "./fleetFixture";

const { model } = vi.hoisted(() => ({
  model: { tree: [] as AgentTreeNode[], detailId: null as string | null, setDetailId: vi.fn() },
}));
vi.mock("./useFleetModel", () => ({ useFleetModel: () => model }));
vi.mock("./AgentRow", () => ({
  AgentRow: ({ agent, selected, depth, heading, onOpen }: { agent: SessionMeta; selected: boolean; depth: number; heading: string | null; onOpen: () => void }) => (
    <button type="button" aria-current={selected || undefined} data-depth={depth} data-heading={heading ?? ""} onClick={onOpen}>
      {agent.title}
    </button>
  ),
}));
vi.mock("./AgentDetail", () => ({ AgentDetail: ({ agentId }: { agentId: string }) => <div data-testid="detail">{agentId}</div> }));

import { FleetList, FleetSectionsView } from "./FleetPanel";

afterEach(cleanup);

const FLEET = [
  fixtureMeta("done", { title: "Done one", createdAt: 1 }),
  fixtureMeta("work", { title: "Working one", status: "running", createdAt: 2 }),
  fixtureMeta("wait", { title: "Waiting one", status: "waiting", createdAt: 3 }),
  fixtureMeta("queue", { title: "Queued one", status: "queued", createdAt: 4 }),
  fixtureMeta("kid", { parentId: "work", title: "Its child", createdAt: 5 }),
  fixtureMeta("grand", { parentId: "kid", title: "Its grandchild", status: "running", createdAt: 6 }),
];

const titles = (el: ParentNode) => [...el.querySelectorAll("button")].map((b) => b.textContent);

describe("FleetSectionsView", () => {
  it("draws the board's sections in order, each with its heading", () => {
    const { container } = render(<FleetSectionsView sections={agentSections(agentTree(FLEET, "ios-orch"))} onOpen={() => {}} />);
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Needs you", "Working", "Queued", "Done"]);
    expect(titles(container)).toEqual(["Waiting one", "Working one", "Its child", "Its grandchild", "Queued one", "Done one"]);
    const heading = container.querySelector("h3")!;
    expect(heading.className).toContain("text-xs");
    expect(heading.className).toContain("h-6");
    expect(container.querySelector('[data-slot="agents-section"]')?.className).toContain("gap-4");
  });

  it("draws no heading with one section, so every row says its own word", () => {
    const one = [fixtureMeta("a", { title: "A" }), fixtureMeta("b", { title: "B" })];
    const { container } = render(<FleetSectionsView sections={agentSections(agentTree(one, "ios-orch"))} onOpen={() => {}} />);
    expect(container.querySelector("h3")).toBeNull();
    expect([...container.querySelectorAll("button")].map((b) => b.getAttribute("data-heading"))).toEqual(["", ""]);
  });

  it("indents descendants under their parent and passes the drawn heading down", () => {
    const { container } = render(<FleetSectionsView sections={agentSections(agentTree(FLEET, "ios-orch"))} onOpen={() => {}} />);
    const kid = screen.getByText("Its child");
    const grand = screen.getByText("Its grandchild");
    expect(kid.getAttribute("data-depth")).toBe("1");
    expect(grand.getAttribute("data-depth")).toBe("2");
    expect(grand.getAttribute("data-heading")).toBe("Working");
    expect(container.querySelector('[data-section="running"]')?.contains(grand)).toBe(true);
  });

  it("marks the selected row and opens the one picked", () => {
    const onOpen = vi.fn();
    render(<FleetSectionsView sections={agentSections(agentTree(FLEET, "ios-orch"))} selectedId="kid" onOpen={onOpen} />);
    expect(screen.getByText("Its child").getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Done one").hasAttribute("aria-current")).toBe(false);
    fireEvent.click(screen.getByText("Done one"));
    expect(onOpen).toHaveBeenCalledWith("done");
  });

  it("says No subagents when there are none", () => {
    render(<FleetSectionsView sections={[]} onOpen={() => {}} />);
    expect(screen.getByText("No subagents")).toBeTruthy();
  });
});

describe("FleetList", () => {
  it("says No subagents when there are none", () => {
    model.tree = [];
    model.detailId = null;
    render(<FleetList sessionId="s1" parentCwd="/p" />);
    expect(screen.getByText("No subagents")).toBeTruthy();
  });

  it("lists the tree in a native scroller and opens the detail of the one picked", () => {
    model.tree = agentTree(FLEET, "ios-orch");
    model.detailId = "grand";
    const { container } = render(<FleetList sessionId="s1" parentCwd="/p" />);
    expect(container.querySelector('[data-slot="agents-section"]')?.parentElement?.className).toContain("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Its grandchild" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("detail").textContent).toBe("grand");
    fireEvent.click(screen.getByRole("button", { name: "Waiting one" }));
    expect(model.setDetailId).toHaveBeenCalledWith("wait");
  });
});
