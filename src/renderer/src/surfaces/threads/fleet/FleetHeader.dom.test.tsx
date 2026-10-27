// @vitest-environment jsdom
/** The orchestration header (A18): the goal, then one sentence of counts. */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { tooltipChunk, warmTooltips } from "../../../components/ui/tooltip";
import { FleetHeader } from "./FleetHeader";
import { FLEET_METAS } from "./fleetFixture";

afterEach(cleanup);

describe("FleetHeader", () => {
  it("says the counts in order, joined with commas, needs you in amber and failed in red", () => {
    const { container } = render(<FleetHeader goal="Ship the iOS thread screens" agents={FLEET_METAS} />);
    const line = container.querySelectorAll("p")[1];
    // the large fleet: building and watching work; the reviewer waits; module 10
    // failed; the rest (done, queued, stopped) count as done
    expect(line.textContent).toBe("2 working, 1 needs you, 1 failed, 8 done");
    expect(line.textContent).not.toContain("·");
    expect([...line.querySelectorAll("span")].find((s) => s.textContent === "1 needs you")?.className).toBe("text-warning");
    expect([...line.querySelectorAll("span")].find((s) => s.textContent === "1 failed")?.className).toBe("text-destructive");
  });

  it("leaves out counts of zero", () => {
    const { container } = render(<FleetHeader goal="g" agents={[{ status: "idle" }, { status: "done" }]} />);
    expect(container.querySelectorAll("p")[1].textContent).toBe("2 done");
  });

  it("renders nothing without agents", () => {
    const { container } = render(<FleetHeader goal="Ship it" agents={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("puts the whole goal in a tooltip", async () => {
    const goal = "Build the shell and the thread screens in parallel, then review both";
    const { container } = render(<FleetHeader goal={goal} agents={FLEET_METAS} />);
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    const trigger = container.querySelector("p")!;
    expect(trigger.className).toContain("truncate");
    expect(trigger.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(trigger.textContent).toBe(goal);
  });
});
