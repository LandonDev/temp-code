// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/session";

let metas: Record<string, unknown> = {};
vi.mock("../../lib/threads/agents", () => ({ useMetaById: (id: string | null) => (id ? (metas[id] ?? null) : null) }));

import { SelectSessionContext } from "../AgentMarkdown";
import { PlanHandoffRow } from "./PlanHandoffRow";

afterEach(() => {
  cleanup();
  metas = {};
});

const block = (how: "auto" | "manual" = "auto"): Block =>
  ({ id: "h", role: "system", text: "", planHandoff: { id: "b1", title: "Build it", how } }) as unknown as Block;

const glyphOf = (container: HTMLElement) => container.querySelector('[data-slot="notice-line"] svg[data-type-glyph]');

describe("PlanHandoffRow", () => {
  it("an implementation build leads with the implementation glyph in its tint", () => {
    metas = { b1: { id: "b1", title: "Build it", threadType: "implementation", status: "running", archived: false } };
    const { container } = render(<PlanHandoffRow block={block()} />);
    expect(glyphOf(container)?.getAttribute("data-type-glyph")).toBe("implementation");
    expect(glyphOf(container)?.getAttribute("class")).toContain("text-type-implementation");
    expect(container.textContent).toContain("Started the build");
  });

  it("an orchestration build leads with the orchestration glyph", () => {
    metas = { b1: { id: "b1", title: "Build it", threadType: "orchestration", status: "idle", archived: false } };
    const { container } = render(<PlanHandoffRow block={block("manual")} />);
    expect(glyphOf(container)?.getAttribute("class")).toContain("text-type-orchestration");
    expect(container.textContent).toContain("Build started");
  });

  it("a build this window has not loaded yet is drawn as an implementation, and its title opens it", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SelectSessionContext.Provider value={onSelect}>
        <PlanHandoffRow block={block()} />
      </SelectSessionContext.Provider>,
    );
    expect(glyphOf(container)?.getAttribute("class")).toContain("text-type-implementation");
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    expect(onSelect).toHaveBeenCalledWith("b1");
  });
});
