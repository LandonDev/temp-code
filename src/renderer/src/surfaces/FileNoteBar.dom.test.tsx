import { afterEach, describe, expect, it, vi } from "vitest";

const openWithEditor = vi.fn();
vi.mock("../lib/native", () => ({ openWithEditor: (...args: unknown[]) => openWithEditor(...args) }));

import { mountProbe } from "../test/renderProbe";
import { FileNoteBar, noteTone } from "./FileNoteBar";

describe("noteTone", () => {
  it("is info for a read-only preview and error for a launcher that fell back or an action that failed", () => {
    const note = { text: "No Mac copy" };
    expect(noteTone(note, true, false)).toBe("info");
    expect(noteTone(note, false, false)).toBe("error");
    expect(noteTone(note, true, true)).toBe("error");
    expect(noteTone(note, false, true)).toBe("error");
  });
});

describe("FileNoteBar", () => {
  let probe: ReturnType<typeof mountProbe> | null = null;
  afterEach(() => {
    probe?.unmount();
    probe = null;
    openWithEditor.mockReset();
  });

  const alert = () => probe!.container.querySelector<HTMLElement>('[data-slot="alert"]')!;

  it("says why the file is shown here and that it is read-only, with no action when there is none", () => {
    probe = mountProbe(<FileNoteBar note={{ text: "Only on box" }} readOnly />);
    expect(probe.container.textContent).toContain("Only on box");
    expect(probe.container.textContent).toContain("Read-only");
    expect(probe.container.textContent).not.toContain("·");
    expect(probe.container.querySelector("button")).toBeNull();
    expect(alert().getAttribute("role")).toBe("status");
    expect(alert().className).toContain("bg-info/10");
    expect(probe.container.querySelector("[title]")).toBeNull();
  });

  it("is an error on a writable file: the launcher failed and the app opened it instead", () => {
    probe = mountProbe(<FileNoteBar note={{ text: "IntelliJ IDEA is not installed" }} />);
    expect(alert().className).toContain("bg-destructive/10");
    expect(probe.container.textContent).not.toContain("Read-only");
  });

  it("hands the action's target to the editor and keeps the failure on the line, as an error", async () => {
    openWithEditor.mockRejectedValueOnce(new Error("No editor found"));
    const editor = { path: "/Users/me/IdeaProjects/x/a.ts", line: 4 };
    probe = mountProbe(
      <FileNoteBar note={{ text: "Mac copy differs: on branch main here", action: { label: "Open the Mac copy anyway", editor } }} readOnly />,
    );
    expect(alert().className).toContain("bg-info/10");
    const button = probe.container.querySelector("button")!;
    expect(button.textContent).toBe("Open the Mac copy anyway");
    await probe.act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(openWithEditor).toHaveBeenCalledWith(editor);
    expect(probe.container.textContent).toContain("Couldn’t open: No editor found");
    expect(alert().className).toContain("bg-destructive/10");
  });
});
