// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { model } = vi.hoisted(() => ({
  model: { agents: [] as { id: string; title: string }[], detailId: null as string | null, setDetailId: vi.fn() },
}));
vi.mock("./useFleetModel", () => ({ useFleetModel: () => model }));
vi.mock("./AgentRow", () => ({
  AgentRow: ({ agent, selected, onOpen }: { agent: { id: string; title: string }; selected: boolean; onOpen: () => void }) => (
    <button type="button" aria-current={selected || undefined} onClick={onOpen}>
      {agent.title}
    </button>
  ),
}));
vi.mock("./AgentDetail", () => ({ AgentDetail: ({ agentId }: { agentId: string }) => <div data-testid="detail">{agentId}</div> }));

// Base UI's scroll area asks for running animations; jsdom has none.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { FleetList } from "./FleetPanel";

afterEach(cleanup);

describe("FleetList", () => {
  it("says No subagents when there are none", () => {
    model.agents = [];
    model.detailId = null;
    render(<FleetList sessionId="s1" parentCwd="/p" />);
    expect(screen.getByText("No subagents")).toBeTruthy();
  });

  it("lists the rows in a scroll area and opens the detail of the one picked", () => {
    model.agents = [
      { id: "a1", title: "Explore the store" },
      { id: "a2", title: "Write the tests" },
    ];
    model.detailId = "a2";
    const { container } = render(<FleetList sessionId="s1" parentCwd="/p" />);
    expect(container.querySelector('[data-slot="agents-section"]')?.closest('[data-slot="scroll-area"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Write the tests" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("detail").textContent).toBe("a2");
    fireEvent.click(screen.getByRole("button", { name: "Explore the store" }));
    expect(model.setDetailId).toHaveBeenCalledWith("a1");
  });
});
