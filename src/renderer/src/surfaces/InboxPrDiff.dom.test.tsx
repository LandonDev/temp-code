// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
});
