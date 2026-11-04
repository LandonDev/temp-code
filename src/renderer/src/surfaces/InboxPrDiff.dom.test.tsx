// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubPrDiff } from "../lib/githubTasks";
import { InboxPrDiff } from "./InboxPrDiff";

afterEach(cleanup);

describe("InboxPrDiff", () => {
  it("says once, in one line, that a diff too large to show lists its files alone", () => {
    const diff = { additions: 1, deletions: 0, files: [{ path: "src/a.ts", additions: 1, deletions: 0, status: "modified" }], patch: "", truncated: true } as unknown as GithubPrDiff;
    render(<InboxPrDiff diff={diff} />);
    expect(screen.getByText("Too large to show in full; the files appear without their diffs.")).toBeTruthy();
  });

  it("turns one chevron with its file instead of swapping glyphs", () => {
    const diff = { additions: 1, deletions: 0, files: [{ path: "src/a.ts", additions: 1, deletions: 0, status: "modified" }], patch: "", truncated: false } as unknown as GithubPrDiff;
    const { container } = render(<InboxPrDiff diff={diff} />);
    const row = container.querySelector<HTMLElement>("[aria-expanded]")!;
    const before = row.querySelector("svg")!;
    const open = () => row.getAttribute("aria-expanded") === "true";
    expect(before.getAttribute("class")).toContain("duration-(--dur-base)");
    expect(before.getAttribute("class")?.includes("rotate-90")).toBe(open());
    const was = open();
    fireEvent.click(row);
    expect(open()).toBe(!was);
    expect(row.querySelector("svg")).toBe(before);
    expect(before.getAttribute("class")?.includes("rotate-90")).toBe(!was);
  });
});
