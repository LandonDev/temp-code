import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FileTypeIcon } from "./FileTypeIcon";

afterEach(cleanup);

describe("FileTypeIcon", () => {
  it("draws the pack's glyph for a file and a folder with no native title", async () => {
    const { container } = render(
      <div>
        <FileTypeIcon name="index.ts" isDir={false} />
        <FileTypeIcon name="src" isDir isOpen />
        <FileTypeIcon name="mystery.zzz" isDir={false} size={12} />
      </div>,
    );
    await waitFor(() => expect(container.querySelectorAll("svg")).toHaveLength(3));
    const icons = [...container.querySelectorAll<HTMLElement>("span[aria-hidden]")];
    expect(icons).toHaveLength(3);
    expect(icons.map((icon) => icon.style.width)).toEqual(["16px", "16px", "12px"]);
    for (const icon of icons) expect(icon.className).toContain("material-icon");
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("holds the glyph's box and alignment while the pack loads, so the row never shifts", async () => {
    const { container } = render(<FileTypeIcon name="README.md" isDir={false} />);
    const box = container.querySelector<HTMLElement>("span[aria-hidden]")!;
    const before = box.className;
    expect(before).toContain("align-middle");
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
    expect(container.querySelector<HTMLElement>("span[aria-hidden]")!.className).toBe(before);
  });
});
