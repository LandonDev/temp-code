import { afterEach, describe, expect, it, vi } from "vitest";

const openWithEditor = vi.fn();
vi.mock("../lib/native", () => ({ openWithEditor: (...args: unknown[]) => openWithEditor(...args) }));

import { mountProbe } from "../test/renderProbe";
import { FileNoteBar } from "./FileNoteBar";

describe("FileNoteBar", () => {
  let probe: ReturnType<typeof mountProbe> | null = null;
  afterEach(() => {
    probe?.unmount();
    probe = null;
    openWithEditor.mockReset();
  });

  it("says why the file is shown here and that it is read-only, with no action when there is none", () => {
    probe = mountProbe(<FileNoteBar note={{ text: "Only on box" }} readOnly />);
    expect(probe.container.textContent).toContain("Only on box");
    expect(probe.container.textContent).toContain("Read-only");
    expect(probe.container.querySelector("button")).toBeNull();
  });

  it("hands the action's target to the editor and keeps the failure on the line", async () => {
    openWithEditor.mockRejectedValueOnce(new Error("No editor found"));
    const editor = { path: "/Users/me/IdeaProjects/x/a.ts", line: 4 };
    probe = mountProbe(
      <FileNoteBar note={{ text: "Mac copy differs: on branch main here", action: { label: "Open the Mac copy anyway", editor } }} readOnly />,
    );
    const button = probe.container.querySelector("button")!;
    expect(button.textContent).toBe("Open the Mac copy anyway");
    await probe.act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(openWithEditor).toHaveBeenCalledWith(editor);
    expect(probe.container.textContent).toContain("Couldn’t open: No editor found");
  });
});
