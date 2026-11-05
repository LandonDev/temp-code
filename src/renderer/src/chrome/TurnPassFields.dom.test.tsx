// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  answer: null as null | ((pass: unknown) => void),
  refuse: null as null | ((error: Error) => void),
}));
vi.mock("../lib/tcserver/projects", () => {
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: () =>
      new Promise((resolve, reject) => {
        host.answer = resolve;
        host.refuse = reject;
      }),
  };
  return { linkOfWorkspace: () => link };
});
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

  it("ends the skeleton when turnpass.get fails: the error and Retry, which asks again", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.refuse?.(new Error("The host did not answer")));
    const section = screen.getByRole("region", { name: "Completed turn" });
    expect(section.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
    expect(within(section).getByRole("alert").textContent).toBe("The host did not answer");
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Retry" })));
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    expect(screen.getByRole("switch", { name: "Checks" })).toBeTruthy();
  });

  it("puts the held value back when the host refuses a save, under its red line", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    const build = screen.getByRole("switch", { name: "Fresh build" });
    fireEvent.click(build);
    expect(build.getAttribute("aria-checked")).toBe("true");
    await act(async () => host.refuse?.(new Error("Refused by the host")));
    expect(screen.getByRole("switch", { name: "Fresh build" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("alert").textContent).toBe("Refused by the host");
  });
});
