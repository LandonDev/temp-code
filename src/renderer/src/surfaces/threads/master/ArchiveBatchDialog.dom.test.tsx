// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveBatchDialog } from "./ArchiveBatchDialog";

afterEach(cleanup);

describe("ArchiveBatchDialog", () => {
  it("is red only while the box that removes worktrees and simulators is ticked", () => {
    render(<ArchiveBatchDialog which="done" count={3} resources={2} onCancel={vi.fn()} onConfirm={vi.fn(async () => {})} />);
    const verb = () => screen.getByRole("button", { name: "Archive 3" });
    expect(verb().getAttribute("data-variant")).toBe("destructive");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(verb().getAttribute("data-variant")).toBe("default");
  });

  it("is primary with nothing to remove, and opens on its verb", async () => {
    render(<ArchiveBatchDialog which="all" count={7} resources={null} onCancel={vi.fn()} onConfirm={vi.fn(async () => {})} />);
    const verb = screen.getByRole("button", { name: "Archive 7" });
    expect(verb.getAttribute("data-variant")).toBe("default");
    await waitFor(() => expect(document.activeElement).toBe(verb));
  });
});
