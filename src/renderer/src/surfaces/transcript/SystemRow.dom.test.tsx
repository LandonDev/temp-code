// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../lib/session";
import { HandoffDivider, SystemRow } from "./SystemRow";

afterEach(cleanup);

const handoff = (status: "preparing" | "ready"): Block =>
  ({ id: "h", role: "handoff", text: "", handoff: { from: "claude", to: "codex", status } }) as unknown as Block;

describe("HandoffDivider", () => {
  it("preparing draws working's still dot and the shimmer on its words, never a spinner", () => {
    const { container } = render(<HandoffDivider block={handoff("preparing")} />);
    expect(screen.getByRole("status", { name: "Preparing a handoff to Codex" })).toBeTruthy();
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(container.querySelector('[data-slot="working-dot"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="working-text"]')?.textContent).toContain("Preparing a handoff to Codex");
  });

  it("once continued it is one quiet line with the harness's mark", () => {
    const { container } = render(<HandoffDivider block={handoff("ready")} />);
    expect(container.textContent).toBe("Continued with Codex");
    expect(container.querySelector('[data-slot="working-dot"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("SystemRow", () => {
  it("a plain system line is one muted, wrapping notice line", () => {
    const { container } = render(<SystemRow block={{ id: "s", role: "system", text: "Goal set: ship the pass" }} />);
    const line = container.querySelector('[data-slot="notice-line"]')!;
    expect(line.textContent).toBe("Goal set: ship the pass");
    expect(line.querySelector(".whitespace-pre-wrap")).not.toBeNull();
  });
});
