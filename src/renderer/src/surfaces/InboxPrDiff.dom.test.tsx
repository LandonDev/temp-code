// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // 12px beside the 12px path, as every disclosure beside 12-13px words.
    expect(before.getAttribute("class")).toContain("size-3");
    expect(before.getAttribute("class")).not.toContain("size-3.5");
    expect(before.getAttribute("class")?.includes("rotate-90")).toBe(open());
    const was = open();
    fireEvent.click(row);
    expect(open()).toBe(!was);
    expect(row.querySelector("svg")).toBe(before);
    expect(before.getAttribute("class")?.includes("rotate-90")).toBe(!was);
  });

  it("says its tallies through Counts, sans and 4px apart with a true minus, and eases each file's body open and shut", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n";
    const diff = {
      additions: 3,
      deletions: 2,
      files: [
        { path: "src/a.ts", additions: 1, deletions: 1, status: "modified" },
        { path: "src/b.ts", additions: 2, deletions: 1, status: "modified" },
      ],
      patch,
      truncated: false,
    } as unknown as GithubPrDiff;
    const { container } = render(<InboxPrDiff diff={diff} />);
    const counts = [...container.querySelectorAll<HTMLElement>("[data-slot=counts]")];
    expect(counts.map((c) => c.textContent)).toEqual(["+3−2", "+1−1", "+2−1"]);
    // "2 files" sits 4px from its tally.
    expect(counts[0].parentElement!.className).toContain("gap-1");
    expect(counts[0].parentElement!.className).not.toContain("gap-3");
    for (const c of counts) {
      expect(c.className).toContain("font-sans");
      expect(c.className).toContain("gap-1");
      expect(c.className).not.toContain("font-mono");
    }
    // The first file opens on its own; its body is a Collapsible panel, not a bare swap.
    const panel = container.querySelector<HTMLElement>("[data-slot=collapsible-content]")!;
    expect(panel.className).toContain("collapsible-resize");
    const second = screen.getByRole("button", { name: /src\/b\.ts/ });
    fireEvent.click(second);
    await waitFor(() => expect(container.querySelectorAll("[data-slot=collapsible-content]")).toHaveLength(2));
  });
});
