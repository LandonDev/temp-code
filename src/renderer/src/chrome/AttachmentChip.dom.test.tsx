// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const imageDataFor = vi.fn((_environmentId: string, _path: string) => Promise.resolve("data:image/png;base64,AA=="));
vi.mock("./lightboxStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightboxStore")>()),
  imageDataFor: (environmentId: string, path: string) => imageDataFor(environmentId, path),
}));

import { AttachmentChip } from "./AttachmentChip";
import type { Attachment } from "../lib/session";

class FakeObserver {
  static last: FakeObserver | null = null;
  constructor(public cb: (entries: { isIntersecting: boolean }[]) => void) {
    FakeObserver.last = this;
  }
  observe() {}
  disconnect() {}
}

const history: Attachment = {
  id: "a1",
  name: "shot.png",
  mimeType: "image/png",
  kind: "image",
  size: 10,
  path: "/tmp/shot.png",
};

afterEach(() => {
  vi.unstubAllGlobals();
  imageDataFor.mockClear();
});

describe("AttachmentChip", () => {
  it("fetches a history image's bytes only once the chip nears the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { container } = render(<AttachmentChip environmentId="local" attachment={history} />);
    expect(imageDataFor).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    await act(async () => FakeObserver.last!.cb([{ isIntersecting: true }]));
    expect(imageDataFor).toHaveBeenCalledWith("local", "/tmp/shot.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });

  it("says the size, then the upload, and marks a failed one", () => {
    const file: Attachment = { id: "f", name: "log.txt", mimeType: "text/plain", kind: "file", size: 4096 } as Attachment;
    const { container, rerender } = render(<AttachmentChip environmentId="local" attachment={file} onRemove={() => {}} />);
    expect(container.textContent).toContain("4 KB");
    expect(screen.getByRole("button", { name: "Remove log.txt" })).toBeTruthy();
    rerender(<AttachmentChip environmentId="local" attachment={file} progress={{ sent: 42, total: 100 }} />);
    expect(container.textContent).toContain("Uploading 42%");
    rerender(<AttachmentChip environmentId="local" attachment={file} progress={{ sent: 10, total: 100, failed: true }} />);
    expect(container.textContent).toContain("Failed");
    expect(container.querySelector("[data-slot=attachment]")?.getAttribute("data-state")).toBe("error");
    expect(container.querySelector("[data-slot=attachment]")?.hasAttribute("title")).toBe(false);
  });
});
