// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ answer: null as null | ((pass: unknown) => void) }));
vi.mock("../lib/tcserver/projects", () => ({
  linkOfWorkspace: () => ({ request: () => new Promise((resolve) => (host.answer = resolve)) }),
}));
vi.mock("../components/choice-select", async () => await import("../components/choice-select-body"));
vi.mock("../lib/sounds", () => ({ playCue: vi.fn() }));

const { TurnPassEditor } = await import("./TurnPassFields");

afterEach(cleanup);

describe("Completed turn", () => {
  it("holds its rows in their shape until the pass loads, then names the build switch apart from the Build section", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    const section = screen.getByRole("region", { name: "Completed turn" });
    expect(section.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(3);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    expect(screen.getByRole("switch", { name: "Fresh build" })).toBeTruthy();
    expect(section.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
  });

  it("labels each row with a noun, its switch named the same", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    const section = screen.getByRole("region", { name: "Completed turn" });
    const titles = [...section.querySelectorAll("[data-slot=page-row] [data-slot=item-title]")].map((el) => el.textContent);
    expect(titles).toEqual(["Checks", "Fresh build", "Commit"]);
    expect(screen.getByRole("switch", { name: "Checks" })).toBeTruthy();
    expect(section.textContent).not.toMatch(/Verify|Make a build/);
  });
});
