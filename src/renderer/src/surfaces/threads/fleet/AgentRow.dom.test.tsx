// @vitest-environment jsdom
/**
 * The agent row (A18): one 36px button line, the host's phrase for a
 * working agent, the vocabulary's word and detail otherwise, no mark at
 * rest (idle, done), and no numbers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  environments: [{ id: "local", name: "This Mac" }] as { id: string; name: string; platform?: string }[],
}));

vi.mock("../../../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/connection/status")>()),
  useEnvironments: () => h.environments,
}));

import { AgentRowView } from "./AgentRow";
import { FLEET_ROWS, fixtureMeta } from "./fleetFixture";
import { agentStatus } from "../../../lib/threads/agents";

const row = (title: string) => FLEET_ROWS.find((r) => r.meta.title === title)!;

afterEach(() => {
  cleanup();
  h.environments = [{ id: "local", name: "This Mac" }];
});

describe("AgentRowView", () => {
  it("is one button carrying no numbers, model or separators", () => {
    const { meta, status } = row("Build the shell");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    const text = buttons[0].textContent ?? "";
    expect(text).not.toMatch(/[·$]/);
    expect(text).not.toMatch(/tasks|%|Opus/);
    expect(buttons[0].className).toContain("h-9");
  });

  it("a working row says the host's phrase, not Working", () => {
    const { meta, status } = row("Build the shell");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    const mark = container.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("working");
    expect(mark.textContent).toBe("Editing HomeView.swift");
  });

  it("a waiting row says Needs you and the approval it waits on", () => {
    const { meta, status } = row("Review the fold");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    const mark = container.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("waiting");
    expect(mark.querySelector('[data-slot="status-word"]')?.textContent).toBe("Needs you");
    expect(mark.querySelector('[data-slot="status-detail"]')?.textContent).toBe("approve rm -rf ios/TempCodeClient/.build");
  });

  it("a failed row says the host's failure summary", () => {
    const { meta, status } = row("Port module 10");
    const { container } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    expect(container.querySelector('[data-slot="status-mark"]')?.textContent).toBe("FailedUsage cap reached on work");
  });

  it("at rest a row draws no mark and no word: done and idle are the title alone", () => {
    const { meta, status } = row("Port module 4");
    expect(status.state).toBe("done");
    const { container, rerender } = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    expect(container.querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(container.textContent).not.toContain("Done");
    rerender(<AgentRowView meta={meta} status={{ state: "idle", detail: "", phrase: false }} onOpen={() => {}} />);
    expect(container.querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(container.textContent).not.toContain("Idle");
    expect(container.textContent).toContain("Port module 4");
  });

  it("marks the selected row and opens on click", () => {
    const onOpen = vi.fn();
    const { meta, status } = row("Port module 4");
    const { container, rerender } = render(<AgentRowView meta={meta} status={status} onOpen={onOpen} />);
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("aria-current")).toBe(false);
    rerender(<AgentRowView meta={meta} status={status} selected onOpen={onOpen} />);
    expect(button.getAttribute("aria-current")).toBe("true");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("draws the host glyph for a far child only with two hosts", () => {
    const meta = fixtureMeta("far", { title: "Far", environmentId: "env_box" });
    const status = agentStatus(meta);
    const one = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    expect(one.container.querySelector("[data-host-glyph]")).toBeNull();
    cleanup();
    h.environments = [
      { id: "local", name: "This Mac" },
      { id: "env_box", name: "The box", platform: "linux" },
    ];
    const two = render(<AgentRowView meta={meta} status={status} onOpen={() => {}} />);
    expect(two.container.querySelector("[data-host-glyph]")?.getAttribute("aria-label")).toBe("The box");
  });
});
