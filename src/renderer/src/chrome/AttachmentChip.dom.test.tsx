// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const imageDataFor = vi.fn((_path: string) => Promise.resolve("data:image/png;base64,AA=="));
vi.mock("./Lightbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Lightbox")>()),
  imageDataFor: (path: string) => imageDataFor(path),
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
    const { container } = render(<AttachmentChip attachment={history} />);
    expect(imageDataFor).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    await act(async () => FakeObserver.last!.cb([{ isIntersecting: true }]));
    expect(imageDataFor).toHaveBeenCalledWith("/tmp/shot.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });
});
